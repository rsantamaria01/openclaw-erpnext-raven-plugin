import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  waitUntilAbort,
} from "openclaw/plugin-sdk/channel-outbound";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { channelBlockedPatch, channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { createComputedAccountStatusAdapter, createDefaultChannelRuntimeState } from "openclaw/plugin-sdk/status-helpers";
import { chunkTextForOutbound, sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import {
  CHANNEL_ID,
  CLEAR_BASE_FIELDS,
  defaultAccountId,
  isConfigured,
  listAccountIds,
  listAgentAccounts,
  resolveAccount,
} from "./config.js";
import { ensureDirectChannel, markdownToRavenHtml, sendRavenMessage } from "./client.js";
import { registerRavenWebhookRoute } from "./inbound.js";
import { sendRavenMediaUrls } from "./media.js";

const TEXT_CHUNK_LIMIT = 4000;
const lower = (v) => String(v ?? "").trim().toLowerCase();

/** "raven:<channelId>" or "raven:<email>" (DM) -> bare id. */
function normalizeRavenTarget(target) {
  const t = String(target ?? "").trim().replace(/^raven:/i, "").trim();
  return t || undefined;
}

const isEmail = (t) => /^[^\s@]+@[^\s@]+$/.test(t);

async function resolveChannelForSend(account, to) {
  const t = normalizeRavenTarget(to);
  if (!t) throw new Error("Raven send requires a target (channel id or user email)");
  return isEmail(t) ? await ensureDirectChannel(account, lower(t)) : t;
}

async function sendRavenText(ctx) {
  const cfg = ctx.cfg ?? {};
  const account = resolveAccount(cfg, ctx.accountId);
  const channelId = await resolveChannelForSend(account, ctx.to);
  const mentionables = listAgentAccounts(cfg).map((a) => ({ name: a.name, user: a.user }));
  const messageId = await sendRavenMessage(account, channelId, markdownToRavenHtml(ctx.text, mentionables));
  return {
    channel: CHANNEL_ID,
    messageId,
    target: { kind: "chat", id: channelId },
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: CHANNEL_ID, messageId, conversationId: channelId }],
      kind: "text",
      threadId: channelId,
    }),
  };
}

async function sendRavenMedia(ctx) {
  if (!ctx.mediaUrl) throw new Error("Raven media send requires mediaUrl");
  const cfg = ctx.cfg ?? {};
  const account = resolveAccount(cfg, ctx.accountId);
  const channelId = await resolveChannelForSend(account, ctx.to);
  const ids = [];
  if (ctx.text && ctx.text.trim()) ids.push((await sendRavenText({ ...ctx, to: channelId })).messageId);
  const fileIds = await sendRavenMediaUrls(account, channelId, [ctx.mediaUrl], {
    cfg,
    agentId: ctx.agentId,
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
  });
  if (!fileIds.length) throw new Error(`Raven could not upload ${ctx.mediaUrl}`);
  ids.push(...fileIds);
  const messageIds = ids.filter(Boolean);
  return {
    channel: CHANNEL_ID,
    messageId: messageIds[messageIds.length - 1] ?? "",
    target: { kind: "chat", id: channelId },
    receipt: createMessageReceiptFromOutboundResults({
      results: messageIds.map((messageId) => ({ channel: CHANNEL_ID, messageId, conversationId: channelId })),
      kind: "media",
      threadId: channelId,
    }),
  };
}

const ravenMessageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: { capabilities: { text: true, media: true, messageSendingHooks: true } },
  send: { text: sendRavenText, media: sendRavenMedia },
});

const ravenConfigAdapter = createScopedChannelConfigAdapter({
  sectionKey: CHANNEL_ID,
  listAccountIds,
  resolveAccount,
  defaultAccountId,
  inspectAccount: (cfg, accountId) => {
    const a = resolveAccount(cfg, accountId);
    return {
      enabled: a.enabled,
      configured: isConfigured(a),
      tokenStatus: a.credentialsFile ? "available" : "missing",
    };
  },
  clearBaseFields: CLEAR_BASE_FIELDS,
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => allowFrom.map(lower).filter(Boolean),
});

const resolveRavenDmPolicy = createScopedDmSecurityResolver({
  channelKey: CHANNEL_ID,
  resolvePolicy: (account) => account.dmPolicy,
  resolveAllowFrom: (account) => account.allowFrom,
  policyPathSuffix: "dmPolicy",
  defaultPolicy: "allowlist",
  normalizeEntry: (raw) => lower(raw),
});

export const ravenPlugin = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "Raven",
    selectionLabel: "Raven (Frappe chat, webhook)",
    detailLabel: "Raven (Frappe chat)",
    blurb: "Agents chat in Raven as their own Frappe users.",
    order: 95,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    threads: false,
    reactions: false,
    edit: false,
    unsend: false,
    reply: false,
    effects: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  configSchema: {
    schema: { type: "object", additionalProperties: true },
  },
  config: ravenConfigAdapter,
  messaging: {
    targetPrefixes: [CHANNEL_ID],
    normalizeTarget: normalizeRavenTarget,
    inferTargetChatType: ({ to }) => {
      const t = normalizeRavenTarget(to);
      if (!t) return undefined;
      return isEmail(t) ? "direct" : "group";
    },
    resolveOutboundSessionRoute: ({ agentId, accountId, target }) => {
      const t = normalizeRavenTarget(target);
      if (!t) return null;
      const direct = isEmail(t);
      const peer = { kind: direct ? "direct" : "group", id: direct ? lower(t) : t };
      const sessionKey = buildAgentSessionKey({
        agentId,
        channel: CHANNEL_ID,
        accountId: accountId?.trim() || DEFAULT_ACCOUNT_ID,
        peer,
        ...(direct ? { dmScope: "per-account-channel-peer" } : {}),
      });
      return {
        sessionKey,
        baseSessionKey: sessionKey,
        recipientSessionExact: "delivery-identity",
        peer,
        chatType: peer.kind,
        from: `${CHANNEL_ID}:${peer.id}`,
        to: peer.id,
      };
    },
    targetResolver: {
      looksLikeId: (id) => normalizeRavenTarget(id) !== undefined,
      hint: "<channel id> | <user email>",
    },
  },
  directory: createEmptyChannelDirectoryAdapter(),
  status: createComputedAccountStatusAdapter({
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    buildChannelSummary: ({ snapshot }) => ({ webhookPath: snapshot.webhookPath ?? null }),
    resolveAccountSnapshot: ({ account }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: isConfigured(account),
      extra: { webhookPath: account.webhookPath, user: account.user, name: account.name },
    }),
  }),
  gateway: {
    startAccount: async (ctx) => {
      const { cfg, accountId, log, abortSignal } = ctx;
      const account = resolveAccount(cfg, accountId);
      if (!account.enabled || !isConfigured(account)) {
        log?.warn?.(`Raven account ${accountId} is disabled or missing user/credentialsFile/webhookSecretFile`);
        ctx.setStatus?.(channelBlockedPatch("Raven account not configured", { accountId, running: true }));
        return waitUntilAbort(abortSignal);
      }
      const clash = listAccountIds(cfg).filter(
        (id) => id !== accountId && resolveAccount(cfg, id).enabled && resolveAccount(cfg, id).webhookPath === account.webhookPath,
      );
      if (clash.length) {
        log?.warn?.(`Raven account ${accountId} shares webhookPath ${account.webhookPath} with ${clash.join(", ")}; refusing`);
        ctx.setStatus?.(channelBlockedPatch("Raven webhookPath conflict", { accountId, running: true }));
        return waitUntilAbort(abortSignal);
      }
      const cleanup = await registerRavenWebhookRoute({ cfg, account, log, abortSignal });
      log?.info?.(`Raven account ${accountId} (${account.name}) listening on ${account.webhookPath}`);
      ctx.setStatus?.(channelReadyPatch({ accountId }));
      return waitUntilAbort(abortSignal, async () => {
        await cleanup();
        ctx.setStatus?.(channelStoppedPatch({ accountId }));
      });
    },
    stopAccount: async (ctx) => {
      ctx.log?.info?.(`Raven account ${ctx.accountId} stopped`);
    },
  },
  agentPrompt: {
    messageToolHints: () => [
      "",
      "### Raven formatting",
      "Raven renders Markdown-like text: **bold**, *italic*, `code`, code blocks, bullet and numbered lists, [links](https://...).",
      "To address another agent, write @Name (for example @Atlas or @Pythia); it becomes a real Raven mention and that agent replies.",
      "Raven targets: a channel id (for example `raven:general`) or a user email for a direct message.",
      "Files and images you send as media are uploaded to Raven as real attachments.",
    ],
  },
  message: ravenMessageAdapter,
  conversationBindings: { supportsCurrentConversationBinding: true },
  security: {
    resolveDmPolicy: resolveRavenDmPolicy,
    collectWarnings: ({ account }) => {
      const w = [];
      if (!account.webhookSecretFile) w.push("- Raven: webhookSecretFile is not set. Every webhook will be rejected.");
      if (!account.allowFrom.length) w.push("- Raven: allowFrom is empty. No human can talk to the agents.");
      if (!account.allowedSourceIps.length) w.push("- Raven: allowedSourceIps is empty. Signature is the only webhook check.");
      return w;
    },
  },
  outbound: {
    deliveryMode: "gateway",
    chunker: chunkTextForOutbound,
    chunkerMode: "markdown",
    textChunkLimit: TEXT_CHUNK_LIMIT,
    sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
    sendText: sendRavenText,
    sendMedia: sendRavenMedia,
  },
};
