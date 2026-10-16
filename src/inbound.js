// Inbound path: Frappe Webhook (Raven Message after_insert) -> plugin route
// -> durable ingress queue -> targeting decision -> host ingress policy
// -> agent turn -> reply posted as this account's own Raven user.
import crypto from "node:crypto";
import { createChannelIngressError } from "openclaw/plugin-sdk/channel-outbound";
import { createStandardRawEventIngressMonitor } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { toInboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";
import { readRequestBodyWithLimit, registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { getRavenRuntime } from "./runtime.js";
import { CHANNEL_ID, listAgentAccounts, resolveAccount } from "./config.js";
import {
  displayNameOf,
  fetchRavenFile,
  getChannelAs,
  getMessageAs,
  getRecentMessages,
  htmlToText,
  markdownToRavenHtml,
  readSecretFile,
  sendRavenMessage,
  toggleReaction,
} from "./client.js";
import { sendRavenMediaUrls } from "./media.js";
import { closeTyping, startTyping, stopTyping } from "./typing.js";

const RavenIngressPermanentError = createChannelIngressError("RavenIngressPermanentError", { withReason: true });
const MAX_BODY_BYTES = 256 * 1024;
const FILE_TYPES = new Set(["File", "Image"]);

// Agent-to-agent hop budget per Raven channel; a human message resets it.
// Shared by every account in this process so one message is counted once.
const chainHops = new Map();
const chainCounted = new Map();

// ---------- webhook ----------

function verifySignature(secret, rawBody, header) {
  if (!secret || !header) return false;
  const want = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const got = String(header);
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function respond(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function createWebhookHandler({ account, receive, log }) {
  return async (req, res) => {
    if (req.method !== "POST") return respond(res, 405, { error: "Method not allowed" });
    const ip = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (account.allowedSourceIps.length && !account.allowedSourceIps.includes(ip)) {
      log?.warn?.(`raven[${account.accountId}]: rejected webhook from ${ip}`);
      return respond(res, 403, { error: "forbidden" });
    }
    let raw;
    try {
      raw = await readRequestBodyWithLimit(req, { maxBytes: MAX_BODY_BYTES, timeoutMs: 5000 });
    } catch {
      return respond(res, 413, { error: "body too large or slow" });
    }
    let secret;
    try {
      secret = readSecretFile(account.webhookSecretFile);
    } catch (e) {
      log?.error?.(`raven[${account.accountId}]: cannot read webhook secret: ${e.message}`);
      return respond(res, 500, { error: "misconfigured" });
    }
    if (!verifySignature(secret, raw, req.headers["x-frappe-webhook-signature"])) {
      return respond(res, 401, { error: "bad signature" });
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return respond(res, 400, { error: "invalid json" });
    }
    let admitted;
    try {
      admitted = await receive(msg);
    } catch (e) {
      log?.error?.(`raven[${account.accountId}]: durable admission failed: ${e.message}`);
      return respond(res, 503, { error: "admission failed" });
    }
    if (admitted.kind === "invalid") return respond(res, 400, { error: admitted.message });
    return respond(res, 200, { ok: true });
  };
}

// ---------- ingress queue ----------

function inspectRavenEvent(msg) {
  if (!msg || typeof msg !== "object") throw new RavenIngressPermanentError("invalid-event", "Raven webhook body is not an object.");
  if (!msg.name || !msg.channel_id || !msg.owner) {
    throw new RavenIngressPermanentError("invalid-event", "Raven webhook is missing name, channel_id or owner.");
  }
  return { eventId: String(msg.name), laneKey: `channel:${msg.channel_id}` };
}

function createRavenIngressMonitor({ account, abortSignal, log, dispatch }) {
  return createStandardRawEventIngressMonitor({
    queue: () => getRavenRuntime().state.openChannelIngressQueue({ accountId: account.accountId }),
    inspect: inspectRavenEvent,
    payload: {
      serialize: (msg) => JSON.stringify(msg),
      deserialize: (rawEvent, { claim }) => {
        try {
          return JSON.parse(rawEvent);
        } catch (error) {
          throw new RavenIngressPermanentError("invalid-event", `Raven ingress row ${claim.id} has invalid JSON.`, {
            cause: error,
          });
        }
      },
      createClaimError: (kind, claim) =>
        new RavenIngressPermanentError("invalid-event", `Raven ingress row ${claim.id}: ${kind}.`),
    },
    deliver: dispatch,
    drain: {
      resolveNonRetryableFailure: (error) =>
        error instanceof RavenIngressPermanentError ? { reason: error.reason, message: error.message } : null,
      onLog: (message) => log?.error?.(`raven: ${message}`),
    },
    ...(abortSignal ? { abortSignal } : {}),
    createStoppedError: () => new Error("Raven ingress is stopped."),
    onError: (error) => log?.error?.(`raven ingress drain failed: ${error?.message ?? error}`),
    classifyAdmissionError: (error) => (error instanceof RavenIngressPermanentError ? error.message : undefined),
  });
}

// ---------- targeting ----------

// Only real Raven mention chips count (msg.mentions). Plain "@Name" text does
// not route; agent replies are converted to chips by markdownToRavenHtml.
function mentionedUsers(msg) {
  return new Set((Array.isArray(msg.mentions) ? msg.mentions : []).map((u) => String(u).toLowerCase()));
}

/**
 * Decide whether this account (agent) should answer this Raven message.
 * Returns null to ignore, or the facts needed to dispatch the turn.
 */
async function decideTarget({ account, msg, cfg, log }) {
  const owner = String(msg.owner).toLowerCase();
  if (owner === account.user) return null; // own message
  if (Number(msg.is_bot_message) || msg.message_type === "System") return null;
  if (account.mutedChannels.includes(msg.channel_id)) return null;

  const agents = listAgentAccounts(cfg);
  const senderAgent = agents.find((a) => a.user === owner) ?? null;

  const channel = await getChannelAs(account, msg.channel_id);
  if (!channel) return null; // not a member: Raven permissions decide visibility

  const text = htmlToText(msg.text || "");
  const mentions = mentionedUsers(msg);
  mentions.delete(owner);

  if (!senderAgent) chainHops.set(msg.channel_id, 0);

  if (Number(channel.is_direct_message)) {
    if (senderAgent) return null; // agent-to-agent DMs are not used
    const other = [channel.dm_user_1, channel.dm_user_2].map((u) => String(u ?? "").toLowerCase()).find((u) => u !== owner);
    if (other !== account.user) return null;
    return { channel, text, kind: "direct", label: await displayNameOf(account, owner), senderAgent, replyTo: null };
  }

  let parentMsg = null;
  let parentChannel = null;
  if (Number(channel.is_thread)) {
    parentMsg = await getMessageAs(account, msg.channel_id); // thread channel id == parent message id
    if (parentMsg) parentChannel = await getChannelAs(account, parentMsg.channel_id);
  }
  const baseChannelId = parentChannel?.name ?? msg.channel_id;

  let targeted = false;
  if (mentions.has(account.user)) targeted = true;
  else if (!senderAgent && mentions.size === 0) {
    targeted =
      (parentMsg && String(parentMsg.owner).toLowerCase() === account.user) ||
      account.defaultChannels.includes(msg.channel_id) ||
      account.defaultChannels.includes(baseChannelId);
  }
  if (!targeted) return null;

  if (senderAgent) {
    if (!chainCounted.has(msg.name)) {
      chainCounted.set(msg.name, true);
      if (chainCounted.size > 2000) for (const k of [...chainCounted.keys()].slice(0, 500)) chainCounted.delete(k);
      chainHops.set(msg.channel_id, (chainHops.get(msg.channel_id) ?? 0) + 1);
    }
    if ((chainHops.get(msg.channel_id) ?? 0) > account.maxAgentChain) {
      log?.info?.(`raven[${account.accountId}]: agent chain limit reached in ${msg.channel_id}`);
      return null;
    }
  }

  const label = parentChannel
    ? `thread in #${parentChannel.channel_name}`
    : `#${channel.channel_name ?? msg.channel_id}`;
  const replyTo = Number(channel.is_thread) ? null : String(msg.name);
  return {
    channel,
    text,
    kind: "group",
    label,
    senderAgent,
    replyTo,
    parentPeerId: parentChannel ? parentChannel.name : undefined,
  };
}

// ---------- dispatch ----------

async function dispatchRavenMessage({ account, msg, lifecycle, log }) {
  const rt = getRavenRuntime();
  const cfg = rt.config.current();
  const live = resolveAccount(cfg, account.accountId);
  const target = await decideTarget({ account: live, msg, cfg, log });
  if (!target) return;

  const owner = String(msg.owner).toLowerCase();
  const agents = listAgentAccounts(cfg);
  const senderName = await displayNameOf(live, owner);
  const isDirect = target.kind === "direct";
  const peer = isDirect ? { kind: "direct", id: owner } : { kind: "group", id: String(msg.channel_id) };

  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: live.accountId,
    peer,
    ...(isDirect ? { dmScope: "per-account-channel-peer" } : {}),
    ...(target.parentPeerId ? { parentPeer: { kind: "group", id: target.parentPeerId } } : {}),
  });
  const sessionKey = route.sessionKey;
  const replyTarget = `${CHANNEL_ID}:${msg.channel_id}`;

  // Quoted message (Raven inline reply)
  let quote;
  if (Number(msg.is_reply) && msg.linked_message) {
    const q = await getMessageAs(live, msg.linked_message);
    if (q) {
      quote = {
        id: String(q.name),
        body: htmlToText(q.text || "").slice(0, 1500),
        sender: await displayNameOf(live, String(q.owner).toLowerCase()),
        senderAllowed: true,
      };
    }
  }

  // Attachment: Raven attaches the file after the message insert, so re-read the doc when needed.
  let text = target.text;
  let fileUrl = msg.file || "";
  if (!fileUrl && FILE_TYPES.has(msg.message_type)) {
    for (let i = 0; i < 6 && !fileUrl; i++) {
      await sleep(500);
      const doc = await getMessageAs(live, msg.name);
      fileUrl = doc?.file || "";
      if (doc && !text) text = htmlToText(doc.text || "");
    }
  }
  let media = [];
  let fileNote = "";
  if (fileUrl) {
    const fileName = decodeURIComponent(fileUrl.split("/").pop() || "archivo");
    try {
      const res = await fetchRavenFile(live, fileUrl);
      const saved = await rt.channel.media.saveResponseMedia(res, {
        subdir: "inbound",
        maxBytes: live.mediaMaxBytes,
        sourceUrl: fileUrl,
        originalFilename: fileName,
      });
      media = toInboundMediaFacts([{ path: saved.path, contentType: saved.contentType, messageId: String(msg.name) }]);
    } catch (e) {
      log?.warn?.(`raven[${live.accountId}]: attachment ${fileName} not downloaded: ${e.message}`);
      fileNote = `\n[adjunto no disponible: ${fileName}]`;
    }
  }
  const body = `${text}${fileNote}`.trim();
  if (!body && media.length === 0) return;

  // Recent channel messages (everyone, other agents included) as platform-selected history.
  let inboundHistory;
  if (!isDirect && live.historyLimit > 0) {
    inboundHistory = [];
    for (const r of await getRecentMessages(live, String(msg.channel_id), String(msg.name), live.historyLimit)) {
      if (r.message_type === "System") continue;
      const rBody =
        htmlToText(r.text || "") || (r.file ? `[archivo: ${decodeURIComponent(String(r.file).split("/").pop())}]` : "");
      if (!rBody) continue;
      inboundHistory.push({
        sender: await displayNameOf(live, String(r.owner).toLowerCase()),
        body: rBody.slice(0, 2000),
        messageId: String(r.name),
      });
    }
  }

  const others = agents.filter((a) => a.user !== live.user).map((a) => `@${a.name}`);
  const groupSystemPrompt = isDirect || !live.groupPrompt
    ? undefined
    : live.groupPrompt.replaceAll("{where}", target.label).replaceAll("{others}", others.join(", ") || "-");

  const mentionables = agents.map((a) => ({ name: a.name, user: a.user }));
  const allowFrom = [...live.allowFrom, ...agents.map((a) => a.user)];
  const channelId = String(msg.channel_id);

  await startTyping(live, channelId, log);
  if (live.workingReaction) await toggleReaction(live, msg.name, live.workingReaction);
  try {
    await rt.channel.inbound.run({
      channel: CHANNEL_ID,
      accountId: live.accountId,
      raw: msg,
      ...(lifecycle ? { turnAdoptionLifecycle: lifecycle } : {}),
      adapter: {
        ingest: (m) => ({
          id: String(m.name),
          timestamp: Date.now(),
          rawText: body,
          textForAgent: body,
          textForCommands: target.senderAgent ? "" : body,
          raw: m,
        }),
        resolveTurn: async (input) => {
          const channelIngress = await rt.channel.inbound.ingress.resolveStable({
            channelId: CHANNEL_ID,
            accountId: live.accountId,
            identity: { key: "raven-user", entryIdPrefix: "raven-entry" },
            subject: { stableId: owner },
            conversation: { kind: target.kind, id: peer.id, ...(target.parentPeerId ? { parentId: target.parentPeerId } : {}) },
            contextBinding: {
              agentId: route.agentId,
              sessionKey,
              messageId: input.id,
              inboundEventKind: "user_request",
            },
            event: { mayPair: false },
            dmPolicy: live.dmPolicy,
            groupPolicy: live.groupPolicy,
            allowFrom: isDirect ? live.allowFrom : allowFrom,
            groupAllowFrom: allowFrom,
          });
          if (!channelIngress.senderAccess.allowed) {
            log?.info?.(
              `raven[${live.accountId}]: sender ${owner} not allowed (${channelIngress.senderAccess.reasonCode})`,
            );
            throw new RavenIngressPermanentError("raven-auth", `Raven sender ${owner} is not authorized.`);
          }
          const ctxPayload = rt.channel.inbound.buildContext({
            channelIngress,
            channel: CHANNEL_ID,
            accountId: live.accountId,
            messageId: input.id,
            timestamp: input.timestamp,
            from: `${CHANNEL_ID}:${owner}`,
            sender: { id: owner, name: senderName },
            conversation: {
              kind: target.kind,
              id: peer.id,
              label: target.label,
              ...(target.parentPeerId ? { parentId: target.parentPeerId } : {}),
            },
            route: {
              agentId: route.agentId,
              dmScope: route.dmScope,
              accountId: live.accountId,
              routeSessionKey: sessionKey,
              dispatchSessionKey: sessionKey,
            },
            reply: { to: replyTarget, ...(target.replyTo ? { replyToId: target.replyTo } : {}) },
            message: {
              rawBody: input.rawText,
              commandBody: input.textForCommands,
              bodyForAgent: input.textForAgent,
              ...(inboundHistory?.length ? { inboundHistory } : {}),
            },
            ...(inboundHistory?.length
              ? { sessionTranscript: { historyLimit: live.historyLimit, historyKind: "recent" } }
              : {}),
            ...(media.length ? { media } : {}),
            supplemental: {
              ...(quote ? { quote } : {}),
              ...(groupSystemPrompt ? { groupSystemPrompt } : {}),
            },
            extra: {
              ChatType: target.kind,
              CommandAuthorized: !target.senderAgent && channelIngress.senderAccess.allowed,
              ...(isDirect ? {} : { GroupSubject: target.label }),
            },
          });
          let firstSend = true;
          const takeReplyTo = () => {
            const r = firstSend ? target.replyTo : null;
            firstSend = false;
            return r;
          };
          return {
            cfg,
            channel: CHANNEL_ID,
            accountId: live.accountId,
            route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey },
            ctxPayload,
            delivery: {
              durable: () => ({ to: replyTarget }),
              deliver: async (payload) => {
                let sent = false;
                if (payload.text && payload.text.trim()) {
                  await sendRavenMessage(live, channelId, markdownToRavenHtml(payload.text, mentionables), takeReplyTo());
                  sent = true;
                }
                const urls = [...(payload.mediaUrls ?? []), ...(payload.mediaUrl ? [payload.mediaUrl] : [])];
                if (urls.length) {
                  const ids = await sendRavenMediaUrls(live, channelId, [...new Set(urls)], {
                    cfg,
                    agentId: route.agentId,
                    replyTo: takeReplyTo(),
                    log,
                  });
                  sent = sent || ids.length > 0;
                }
                return { visibleReplySent: sent };
              },
            },
            record: {
              onRecordError: (err) => log?.info?.(`raven[${live.accountId}]: session record failed: ${err?.message ?? err}`),
            },
          };
        },
      },
    });
  } finally {
    stopTyping(live, channelId);
    if (live.workingReaction) await toggleReaction(live, msg.name, live.workingReaction);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- route lifecycle ----------

const activeRoutes = new Map();

export async function registerRavenWebhookRoute({ cfg, account, log, abortSignal }) {
  const routeKey = `${account.accountId}:${account.webhookPath}`;
  const previous = activeRoutes.get(routeKey);
  if (previous) await previous();

  const ingress = createRavenIngressMonitor({
    account,
    abortSignal,
    log,
    dispatch: async (msg, lifecycle) => {
      await dispatchRavenMessage({ account, msg, lifecycle, log });
    },
  });
  ingress.start();

  let unregister;
  try {
    unregister = registerPluginHttpRoute({
      path: account.webhookPath,
      auth: "plugin",
      pluginId: CHANNEL_ID,
      accountId: account.accountId,
      log: (m) => log?.info?.(m),
      throwOnFailure: true,
      handler: async (req, res) => {
        await createWebhookHandler({ account, receive: ingress.receive, log })(req, res);
        return true;
      },
    });
  } catch (error) {
    await ingress.stop();
    throw error;
  }

  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      try {
        unregister();
      } finally {
        try {
          closeTyping(account.accountId);
          await ingress.stop();
        } finally {
          if (activeRoutes.get(routeKey) === cleanup) activeRoutes.delete(routeKey);
        }
      }
    })();
    return cleanupPromise;
  };
  activeRoutes.set(routeKey, cleanup);
  return cleanup;
}
