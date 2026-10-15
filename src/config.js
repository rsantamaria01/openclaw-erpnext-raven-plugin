// channels.raven config. One account per agent: each account is that agent's
// own Frappe user, bound to the agent with a `bindings` entry
// ({ agentId, match: { channel: "raven", accountId } }).
export const CHANNEL_ID = "raven";

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
];
