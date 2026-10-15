// channels.raven config. One account per agent: each account is that agent's
// own Frappe user, bound to the agent with a `bindings` entry
// ({ agentId, match: { channel: "raven", accountId } }).
export const CHANNEL_ID = "raven";

// Placeholders: {where} = "#channel" or "thread in #channel", {others} = "@A, @B".
export const DEFAULT_GROUP_PROMPT =
  "You are in Raven, the team chat, in {where}. Other agents here: {others}. " +
  "To ask another agent for something, mention it with @Name in your reply. " +
  "If you have nothing useful to add, reply NO_REPLY.";

const section = (cfg) => cfg?.channels?.[CHANNEL_ID] ?? {};
const lower = (v) => String(v ?? "").trim().toLowerCase();

export function listAccountIds(cfg) {
  return Object.keys(section(cfg).accounts ?? {});
}

export function defaultAccountId(cfg) {
  return listAccountIds(cfg)[0] ?? "default";
}

export function resolveAccount(cfg, accountId) {
  const s = section(cfg);
  const id = accountId || defaultAccountId(cfg);
  const a = s.accounts?.[id] ?? {};
  return {
    accountId: id,
    enabled: (s.enabled ?? true) !== false && (a.enabled ?? true) !== false,
    name: a.name ?? id,
    user: lower(a.user),
    credentialsFile: a.credentialsFile ?? "",
    baseUrl: String(a.baseUrl ?? s.baseUrl ?? "").replace(/\/$/, ""),
    webhookPath: a.webhookPath ?? `/raven/webhook/${id}`,
    webhookSecretFile: a.webhookSecretFile ?? s.webhookSecretFile ?? "",
    allowedSourceIps: a.allowedSourceIps ?? s.allowedSourceIps ?? [],
    dmPolicy: a.dmPolicy ?? s.dmPolicy ?? "allowlist",
    allowFrom: (a.allowFrom ?? s.allowFrom ?? []).map(lower).filter(Boolean),
    groupPolicy: s.groupPolicy ?? "allowlist",
    defaultChannels: a.defaultChannels ?? [],
    mutedChannels: s.mutedChannels ?? [],
    maxAgentChain: Number(s.maxAgentChain ?? 4),
    groupPrompt: a.groupPrompt ?? s.groupPrompt ?? DEFAULT_GROUP_PROMPT,
    // Recent channel messages (all participants, other agents included) given to the agent as context.
    historyLimit: Number(a.historyLimit ?? s.historyLimit ?? 20),
    // Raven typing indicator over Frappe's socket.io. siteName = Frappe site (socket namespace);
    // defaults to the baseUrl host.
    typingIndicator: (a.typingIndicator ?? s.typingIndicator ?? true) !== false,
    siteName: a.siteName ?? s.siteName ?? "",
    // Optional reaction on the triggering message while the agent works (e.g. "👀"); off by default.
    workingReaction: a.workingReaction ?? s.workingReaction ?? "",
    mediaMaxBytes: Number(a.mediaMaxBytes ?? s.mediaMaxBytes ?? 25 * 1024 * 1024),
  };
}

export function isConfigured(account) {
  return Boolean(account.user && account.credentialsFile && account.webhookSecretFile);
}

/** Every enabled agent account: used for mentions and agent-to-agent rules. */
export function listAgentAccounts(cfg) {
  return listAccountIds(cfg)
    .map((id) => resolveAccount(cfg, id))
    .filter((a) => a.enabled && a.user);
}

export const CLEAR_BASE_FIELDS = [
  "baseUrl",
  "webhookSecretFile",
  "allowedSourceIps",
  "dmPolicy",
  "allowFrom",
  "groupPolicy",
  "mutedChannels",
  "maxAgentChain",
  "groupPrompt",
  "historyLimit",
  "typingIndicator",
  "siteName",
  "workingReaction",
  "mediaMaxBytes",
];
