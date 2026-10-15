// Raven REST client and text conversion. Every call runs as one account's own
// Frappe user (token auth), so Raven permissions = that agent's permissions.
import fs from "node:fs";

const CHANNEL_CACHE_MS = 5 * 60 * 1000;
const channelCache = new Map(); // `${accountId}|${channelId}` -> { doc, at }
const nameCache = new Map(); // email -> { name, at }

export function readKeyValueFile(file) {
  const out = {};
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Secret file: either a bare value or KEY=VALUE lines (first value wins). */
export function readSecretFile(file) {
  if (!file) return "";
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text.includes("=")) return text;
  const kv = readKeyValueFile(file);
  return kv.RAVEN_WEBHOOK_SECRET || Object.values(kv)[0] || "";
}

export function resolveCredentials(account) {
  if (!account.credentialsFile) throw new Error(`raven: account ${account.accountId} has no credentialsFile`);
  const env = readKeyValueFile(account.credentialsFile);
  const key = env.ERPNEXT_API_KEY || env.FRAPPE_API_KEY;
  const secret = env.ERPNEXT_API_SECRET || env.FRAPPE_API_SECRET;
  if (!key || !secret) throw new Error(`raven: credentials missing in ${account.credentialsFile}`);
  const baseUrl = (account.baseUrl || env.ERPNEXT_URL || env.FRAPPE_URL || "").replace(/\/$/, "");
  if (!baseUrl) throw new Error(`raven: account ${account.accountId} has no baseUrl`);
  return { authorization: `token ${key}:${secret}`, baseUrl };
}

export async function ravenRequest(account, method, apiPath, body, signal) {
  const { authorization, baseUrl } = resolveCredentials(account);
  const res = await fetch(baseUrl + apiPath, {
    method,
    headers: {
      Authorization: authorization,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ?? AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail = String(json.exc_type || json.exception || text).slice(0, 200);
    const err = new Error(`raven ${method} ${apiPath} -> HTTP ${res.status} ${detail}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

export async function getDoc(account, doctype, name) {
  const r = await ravenRequest(
    account,
    "GET",
    `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
  );
  return r.data;
}

/** Channel doc as seen by this account; null when it is not a member (403/404). */
export async function getChannelAs(account, channelId) {
  const key = `${account.accountId}|${channelId}`;
  const hit = channelCache.get(key);
  if (hit && Date.now() - hit.at < CHANNEL_CACHE_MS) return hit.doc;
  try {
    const doc = await getDoc(account, "Raven Channel", channelId);
    channelCache.set(key, { doc, at: Date.now() });
    return doc;
  } catch (e) {
    if (e.status === 403 || e.status === 404) {
      channelCache.set(key, { doc: null, at: Date.now() });
      return null;
    }
    throw e;
  }
}

export async function getMessageAs(account, messageId) {
  try {
    return await getDoc(account, "Raven Message", messageId);
  } catch (e) {
    if (e.status === 403 || e.status === 404) return null;
    throw e;
  }
}

export async function displayNameOf(account, email) {
  const hit = nameCache.get(email);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.name;
  let name = email.split("@")[0];
  try {
    const u = await getDoc(account, "Raven User", email);
    name = u.full_name || u.first_name || name;
  } catch {
    /* keep fallback */
  }
  nameCache.set(email, { name, at: Date.now() });
  return name;
}

export async function sendRavenMessage(account, channelId, html, replyToMessageId) {
  const r = await ravenRequest(account, "POST", "/api/method/raven.api.raven_message.send_message", {
    channel_id: channelId,
    text: html,
    ...(replyToMessageId ? { is_reply: 1, linked_message: replyToMessageId } : {}),
  });
  return r.message?.name ?? r.data?.name ?? "";
}

/** Toggles a reaction (Raven's react endpoint adds or removes). Best effort. */
export async function toggleReaction(account, messageId, emoji) {
  try {
    await ravenRequest(account, "POST", "/api/method/raven.api.reactions.react", {
      message_id: messageId,
      reaction: emoji,
    });
  } catch {
    /* reactions are cosmetic */
  }
}

/** DM channel between this account's user and `email` (created if missing). */
export async function ensureDirectChannel(account, email) {
  const r = await ravenRequest(account, "POST", "/api/method/raven.api.raven_channel.create_direct_message_channel", {
    user_id: email,
  });
  return r.message ?? r.data;
}

// ---------- text conversion ----------

const decodeEntities = (s) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&");

export function htmlToText(html = "") {
  return decodeEntities(
    String(html)
      .replace(/<span[^>]*userMention[^>]*>@?([^<]*)<\/span>/gi, "@$1")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h\d|pre|blockquote)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inlineMd(s, mentionables) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  for (const m of mentionables) {
    const re = new RegExp(`@${escapeRegExp(m.name)}\\b`, "gi");
    t = t.replace(
      re,
      `<span class="mention" data-type="userMention" data-id="${esc(m.user)}" data-label="${esc(m.name)}">@${esc(m.name)}</span>`,
    );
  }
  return t;
}

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Markdown -> Raven HTML. `@Name` of a known agent becomes a real Raven mention. */
export function markdownToRavenHtml(md, mentionables = []) {
  const lines = String(md).replace(/\r/g, "").split("\n");
  const out = [];
  let list = null;
  let code = null;
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  for (const line of lines) {
    if (code !== null) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^```/.test(line)) {
      closeList();
      code = [];
      continue;
    }
    let m;
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inlineMd(m[1], mentionables)}</li>`);
      continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inlineMd(m[1], mentionables)}</li>`);
      continue;
    }
    closeList();
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) {
      out.push(`<p><strong>${inlineMd(m[1], mentionables)}</strong></p>`);
      continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) {
      out.push(`<blockquote>${inlineMd(m[1], mentionables)}</blockquote>`);
      continue;
    }
    if (line.trim() === "") continue;
    out.push(`<p>${inlineMd(line, mentionables)}</p>`);
  }
  if (code !== null) out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
  closeList();
  return out.join("");
}
