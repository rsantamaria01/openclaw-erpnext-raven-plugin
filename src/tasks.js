// Predetermined tasks: an agent tool that lists and starts the agent's own
// OpenClaw automations (cron jobs) on demand.
//
// What the tasks are comes from OpenClaw itself: every automation of the
// agent whose description contains the marker (default "[on-demand]"). Add a
// task by creating an automation for the agent with that marker; no plugin
// config change is needed.
//
// Who may start a task is decided here, in code, from trusted runtime context
// (the real Raven sender), never by the model:
//   - OpenClaw owners (the runtime's owner bit, or `commands.ownerAllowFrom`
//     containing "raven:<email>"), unless `owners: false`;
//   - Frappe users listed in `users`;
//   - Frappe users holding any of `roles` (read live from Frappe).
// Everyone can still ask the agent what it can do; the list says which tasks
// the current person may start.
import { execFile } from "node:child_process";
import { ravenRequest } from "./client.js";
import { CHANNEL_ID, listAgentAccounts, resolveAccount } from "./config.js";

export const TASKS_TOOL_NAME = "raven_tasks";

const ROLE_CACHE_MS = 60 * 1000;
const LIST_CACHE_MS = 15 * 1000;
const roleCache = new Map(); // `${baseUrl}|${email}` -> { roles: Set, at }
const listCache = new Map(); // `${cli}|${agentId}` -> { jobs, at }
const lastStart = new Map(); // job id -> ms

const lower = (v) => String(v ?? "").trim().toLowerCase();
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/** Frappe roles of `email`, read with the given account's credentials. */
export async function frappeRolesOf(account, email) {
  const key = `${account.baseUrl}|${email}`;
  const hit = roleCache.get(key);
  if (hit && Date.now() - hit.at < ROLE_CACHE_MS) return hit.roles;
  const q = new URLSearchParams({
    doctype: "Has Role",
    parent: "User",
    fields: JSON.stringify(["role"]),
    filters: JSON.stringify({ parent: email, parenttype: "User" }),
    limit_page_length: "500",
  });
  const r = await ravenRequest(account, "GET", `/api/method/frappe.client.get_list?${q}`);
  const roles = new Set((r.message ?? []).map((x) => String(x.role)));
  roleCache.set(key, { roles, at: Date.now() });
  return roles;
}

function runCli(cli, args, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    execFile(cli, args, { timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      let out = null;
      try {
        out = JSON.parse(stdout);
      } catch {
        /* non-JSON output */
      }
      if (err || out?.ok === false) {
        const detail = out?.error?.message ?? (stderr || err?.message || "unknown error");
        return reject(new Error(String(detail).trim().split("\n").pop().slice(0, 300)));
      }
      resolve(out ?? {});
    });
  });
}

/** The agent's automations that carry the marker (disabled ones included: on-demand only). */
async function agentTasks(tasks, agentId, { fresh = false } = {}) {
  const key = `${tasks.cli}|${agentId}`;
  const hit = listCache.get(key);
  let jobs = !fresh && hit && Date.now() - hit.at < LIST_CACHE_MS ? hit.jobs : null;
  if (!jobs) {
    const out = await runCli(tasks.cli, ["cron", "list", "--json", "--all", "--agent", agentId]);
    jobs = (out.jobs ?? []).filter((j) => j.agentId === agentId);
    listCache.set(key, { jobs, at: Date.now() });
  }
  const marker = lower(tasks.marker);
  return jobs
    .filter((j) => !marker || lower(j.description).includes(marker))
    .filter((j) => (tasks.overrides[j.id] ?? tasks.overrides[j.name])?.enabled !== false);
}

function deliveryLabel(d) {
  if (!d?.to) return null;
  const to = String(d.to);
  return d.channel && !to.startsWith(`${d.channel}:`) ? `${d.channel}:${to}` : to;
}

function describeJob(job, marker) {
  const text = String(job.description ?? "")
    .replace(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "")
    .trim();
  const sch = job.schedule ?? {};
  const schedule = !job.enabled
    ? "on demand only"
    : sch.kind === "cron"
      ? `cron "${sch.expr}"${sch.tz ? ` (${sch.tz})` : ""}`
      : sch.kind
        ? JSON.stringify(sch)
        : "on demand only";
  const st = job.state ?? {};
  return {
    id: job.id,
    name: job.displayName || job.name,
    description: text || job.displayName || job.name,
    schedule,
    deliversTo: deliveryLabel(job.delivery),
    running: Boolean(st.runningAtMs),
    lastRunAt: st.lastRunAtMs ? new Date(st.lastRunAtMs).toISOString() : null,
    lastRunStatus: st.lastRunStatus ?? null,
  };
}

function findTask(jobs, query) {
  const q = lower(query);
  return (
    jobs.find((j) => lower(j.id) === q) ??
    jobs.find((j) => lower(j.name) === q || lower(j.displayName) === q) ??
    jobs.find((j) => lower(j.id).startsWith(q) && q.length >= 6)
  );
}

/** Raven account this agent speaks through (the runtime's account, else the agent's binding). */
function accountFor(cfg, ctx) {
  if (ctx.agentAccountId) return ctx.agentAccountId;
  const b = (cfg?.bindings ?? []).find((x) => x?.agentId === ctx.agentId && x?.match?.channel === CHANNEL_ID);
  return b?.match?.accountId ?? null;
}

const senderEmail = (id) => lower(String(id ?? "").replace(new RegExp(`^${CHANNEL_ID}:`, "i"), ""));

async function permission({ cfg, ctx, tasks, roleAccount, job, email, log }) {
  if (!email) return { allowed: false, reason: "no human sender in this conversation" };
  if (listAgentAccounts(cfg).some((a) => a.user === email)) {
    return { allowed: false, reason: "tasks can only be started by people, not by agents" };
  }
  const o = (job && (tasks.overrides[job.id] ?? tasks.overrides[job.name])) || {};
  const owners = o.owners ?? tasks.owners;
  const users = o.users ? list(o.users).map(lower) : tasks.users;
  const roles = o.roles ? list(o.roles).map(String) : tasks.roles;
  const ownerList = (cfg?.commands?.ownerAllowFrom ?? []).map(lower);
  if (owners && (ctx.senderIsOwner === true || ownerList.includes(`${CHANNEL_ID}:${email}`))) {
    return { allowed: true, reason: "owner" };
  }
  if (users.includes(email)) return { allowed: true, reason: "listed user" };
  if (!roles.length) return { allowed: false, reason: "only owners may start this task" };
  try {
    const have = await frappeRolesOf(roleAccount, email);
    const hit = roles.find((r) => have.has(r));
    return hit
      ? { allowed: true, reason: `role ${hit}` }
      : { allowed: false, reason: `needs one of these roles: ${roles.join(", ")}` };
  } catch (e) {
    log?.warn?.(`raven: cannot read Frappe roles of ${email}: ${e.message}`);
    return { allowed: false, reason: "could not verify the person's roles" }; // fail closed
  }
}

const result = (details) => ({
  content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
  details,
});

/** Tool factory registered by the plugin entry; returns null when tasks are not set up for this turn. */
export function createTasksTool(ctx, log) {
  if (ctx.messageChannel && lower(ctx.messageChannel).split(":")[0] !== CHANNEL_ID) return null;
  const cfg0 = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
  const accountId0 = accountFor(cfg0, ctx);
  if (!ctx.agentId || !accountId0 || !resolveAccount(cfg0, accountId0).tasks.enabled) return null;

  return {
    name: TASKS_TOOL_NAME,
    label: "Tasks",
    description:
      "Your predetermined tasks: automations you run on a schedule that people can also ask you to start now. " +
      "Use action \"list\" when someone asks what you can do or run, or before starting one; it shows each task, " +
      "its schedule, where its result is delivered, whether it is running, and whether the person you are talking " +
      "to may start it. Use action \"run\" with the task id to start it now. Permission is checked by the system " +
      "from the person's roles; you cannot grant it. Never say a task started unless run returned started: true.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "run"] },
        task: { type: "string", description: "Task id (or exact name) from list; required for run." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
      const account = resolveAccount(cfg, accountFor(cfg, ctx));
      const tasks = account.tasks;
      if (!tasks.enabled) return result({ error: "tasks are turned off for this agent" });
      const roleAccount = tasks.roleCheckAccount ? resolveAccount(cfg, tasks.roleCheckAccount) : account;
      const email = senderEmail(ctx.requesterSenderId);
      const action = lower(params?.action);

      if (action === "list") {
        let jobs;
        try {
          jobs = await agentTasks(tasks, ctx.agentId);
        } catch (e) {
          return result({ error: `could not read tasks: ${e.message}` });
        }
        const out = [];
        for (const job of jobs) {
          const p = await permission({ cfg, ctx, tasks, roleAccount, job, email, log });
          out.push({ ...describeJob(job, tasks.marker), personMayStart: p.allowed, ...(p.allowed ? {} : { why: p.reason }) });
        }
        return result({ person: email || null, tasks: out });
      }

      if (action === "run") {
        if (!params?.task) return result({ started: false, error: "task is required; call list first" });
        let jobs;
        try {
          jobs = await agentTasks(tasks, ctx.agentId, { fresh: true });
        } catch (e) {
          return result({ started: false, error: `could not read tasks: ${e.message}` });
        }
        const job = findTask(jobs, params.task);
        if (!job) return result({ started: false, error: `no task "${params.task}"; call list to see your tasks` });
        const info = describeJob(job, tasks.marker);
        const p = await permission({ cfg, ctx, tasks, roleAccount, job, email, log });
        if (!p.allowed) {
          log?.info?.(`raven[${account.accountId}]: task ${job.id} denied for ${email || "(no sender)"}: ${p.reason}`);
          return result({ started: false, task: info.name, denied: true, why: p.reason });
        }
        if (info.running) return result({ started: false, task: info.name, why: "it is already running" });
        const since = Date.now() - (lastStart.get(job.id) ?? 0);
        if (tasks.cooldownSeconds > 0 && since < tasks.cooldownSeconds * 1000) {
          return result({
            started: false,
            task: info.name,
            why: `it was started ${Math.max(1, Math.round(since / 60000))} min ago`,
          });
        }
        try {
          ctx.assertInvocationCurrent?.();
          lastStart.set(job.id, Date.now());
          const out = await runCli(tasks.cli, ["cron", "run", job.id]);
          listCache.clear();
          log?.info?.(`raven[${account.accountId}]: task ${job.id} started by ${email} (${p.reason}, run ${out.runId ?? "?"})`);
          return result({ started: true, task: info.name, runId: out.runId ?? null, deliversTo: info.deliversTo });
        } catch (e) {
          lastStart.delete(job.id);
          log?.warn?.(`raven[${account.accountId}]: task ${job.id} by ${email} failed: ${e.message}`);
          return result({ started: false, task: info.name, error: e.message });
        }
      }

      return result({ error: 'action must be "list" or "run"' });
    },
  };
}
