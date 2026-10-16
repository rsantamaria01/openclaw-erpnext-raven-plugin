// Chat commands: a human types "/<name>" in Raven and the plugin, not the
// model, decides whether that person may run it. Today the only action is
// running an existing OpenClaw automation (cron job) on demand.
//
// Who may run a command:
//   - OpenClaw owners (`commands.ownerAllowFrom` contains "raven:<email>"),
//     unless the command sets `owners: false`;
//   - users listed in the command's `users`;
//   - users holding any Frappe role listed in the command's `roles`.
// Everyone else can still chat with the agent normally.
import { execFile } from "node:child_process";
import { ravenRequest } from "./client.js";

const ROLE_CACHE_MS = 60 * 1000;
const roleCache = new Map(); // `${baseUrl}|${email}` -> { roles: Set, at }
const lastRun = new Map(); // `${accountId}|${command}` -> ms

export const DEFAULT_COMMAND_MESSAGES = {
  started: "Started **{description}**. The result will be posted when it finishes.",
  denied: "You don't have permission to run `/{command}`. You can still chat with me as usual.",
  cooldown: "`/{command}` was started {minutes} min ago. Try again later.",
  failed: "Couldn't start `/{command}`: {error}",
  helpHeader: "Commands you can run here:",
  helpEmpty: "There are no commands you can run here. You can still chat with me as usual.",
};

const lower = (v) => String(v ?? "").trim().toLowerCase();

/** Merge channel-level and account-level `commands` blocks (account wins, entries merged by name). */
export function resolveCommandsConfig(section, account) {
  const s = section?.commands ?? {};
  const a = account?.commands ?? {};
  const entries = {};
  for (const [name, e] of Object.entries({ ...(s.entries ?? {}), ...(a.entries ?? {}) })) {
    if (!e || e.enabled === false) continue;
    entries[lower(name)] = e;
  }
  return {
    enabled: (a.enabled ?? s.enabled ?? true) !== false && Object.keys(entries).length > 0,
    prefix: String(a.prefix ?? s.prefix ?? "/"),
    help: lower(a.help ?? s.help ?? "commands"),
    owners: (a.owners ?? s.owners ?? true) !== false,
    roleCheckAccount: a.roleCheckAccount ?? s.roleCheckAccount ?? "",
    cli: a.cli ?? s.cli ?? "openclaw",
    messages: { ...DEFAULT_COMMAND_MESSAGES, ...(s.messages ?? {}), ...(a.messages ?? {}) },
    entries,
  };
}

/** Parse "/name rest" when the text starts with the prefix; null otherwise. */
export function parseCommand(text, prefix) {
  const t = String(text ?? "").trim();
  if (!prefix || !t.startsWith(prefix)) return null;
  const m = t.slice(prefix.length).match(/^([\p{L}\p{N}_.-]+)(?:\s+([\s\S]*))?$/u);
  return m ? { name: lower(m[1]), args: (m[2] ?? "").trim() } : null;
}

function findEntry(cmds, name) {
  if (cmds.entries[name]) return [name, cmds.entries[name]];
  for (const [n, e] of Object.entries(cmds.entries)) {
    if ((e.aliases ?? []).map(lower).includes(name)) return [n, e];
  }
  return null;
}

function isOwner(cfg, email, channelId) {
  const owners = cfg?.commands?.ownerAllowFrom ?? [];
  return owners.map(lower).includes(`${channelId}:${email}`);
}

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

async function mayRun({ entry, cmds, cfg, email, channelId, roleAccount, log }) {
  if (cmds.owners && entry.owners !== false && isOwner(cfg, email, channelId)) return true;
  if ((entry.users ?? []).map(lower).includes(email)) return true;
  const wanted = entry.roles ?? [];
  if (!wanted.length) return false;
  try {
    const roles = await frappeRolesOf(roleAccount, email);
    return wanted.some((r) => roles.has(r));
  } catch (e) {
    log?.warn?.(`raven: cannot read Frappe roles of ${email}: ${e.message}`);
    return false; // fail closed
  }
}

function runAutomation(cli, id) {
  return new Promise((resolve, reject) => {
    execFile(cli, ["cron", "run", String(id)], { timeout: 60_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      let out = null;
      try {
        out = JSON.parse(stdout);
      } catch {
        /* non-JSON output */
      }
      if (err || out?.ok === false) {
        const detail = out?.error?.message ?? (stderr || err?.message || "unknown error");
        return reject(new Error(String(detail).trim().split("\n").pop().slice(0, 200)));
      }
      resolve(out ?? {});
    });
  });
}

const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/**
 * Handle a chat command addressed to this account. Returns true when the
 * message was a command (answered or refused) and must not reach the agent.
 */
export async function handleRavenCommand({ cfg, account, roleAccount, channelId, text, email, reply, log }) {
  const cmds = account.commands;
  if (!cmds?.enabled) return false;
  const parsed = parseCommand(text, cmds.prefix);
  if (!parsed) return false;
  const ctx = { cfg, cmds, email, channelId, roleAccount, log };

  if (cmds.help && parsed.name === cmds.help) {
    const lines = [];
    for (const [name, entry] of Object.entries(cmds.entries)) {
      if (await mayRun({ ...ctx, entry })) lines.push(`- \`${cmds.prefix}${name}\` — ${entry.description ?? name}`);
    }
    await reply(lines.length ? `${cmds.messages.helpHeader}\n${lines.join("\n")}` : cmds.messages.helpEmpty);
    return true;
  }

  const found = findEntry(cmds, parsed.name);
  if (!found) return false; // not ours: let the agent (and OpenClaw's own commands) handle it
  const [name, entry] = found;
  const vars = { command: name, description: entry.description ?? name, user: email };

  if (!(await mayRun({ ...ctx, entry }))) {
    log?.info?.(`raven[${account.accountId}]: command /${name} denied for ${email}`);
    await reply(fill(cmds.messages.denied, vars));
    return true;
  }

  const cooldownMs = Number(entry.cooldownSeconds ?? 300) * 1000;
  const runKey = `${account.accountId}|${name}`;
  const since = Date.now() - (lastRun.get(runKey) ?? 0);
  if (cooldownMs > 0 && since < cooldownMs) {
    await reply(fill(cmds.messages.cooldown, { ...vars, minutes: Math.max(1, Math.round(since / 60000)) }));
    return true;
  }

  if (!entry.automation) {
    await reply(fill(cmds.messages.failed, { ...vars, error: "no automation configured" }));
    return true;
  }
  try {
    lastRun.set(runKey, Date.now());
    const out = await runAutomation(entry.cli ?? cmds.cli, entry.automation);
    log?.info?.(`raven[${account.accountId}]: command /${name} by ${email} started automation ${entry.automation} (run ${out.runId ?? "?"})`);
    await reply(fill(cmds.messages.started, vars));
  } catch (e) {
    lastRun.delete(runKey);
    log?.warn?.(`raven[${account.accountId}]: command /${name} by ${email} failed: ${e.message}`);
    await reply(fill(cmds.messages.failed, { ...vars, error: e.message }));
  }
  return true;
}
