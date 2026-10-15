// Raven typing indicator. Raven publishes "who is typing" from Frappe's
// socket.io server (events raven_channel_typing / raven_channel_typing_stopped),
// so each account keeps one lazy socket.io connection authenticated with its
// own API key. Minimal Engine.IO v4 / Socket.IO v4 client over Node's built-in
// WebSocket: no dependencies. Best effort: failures never block a reply.
import { resolveCredentials } from "./client.js";

const IDLE_CLOSE_MS = 10 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 8000;
const connections = new Map(); // accountId -> Connection

class Connection {
  constructor(account, log) {
    this.account = account;
    this.log = log;
    this.ws = null;
    this.ready = null; // Promise<void> resolving when the namespace is joined
    this.ns = "";
    this.idleTimer = null;
    this.active = new Set(); // channels this account is "typing" in
  }

  namespace() {
    const { baseUrl } = resolveCredentials(this.account);
    const site = this.account.siteName || new URL(baseUrl).hostname;
    return `/${site}`;
  }

  connect() {
    if (this.ready) return this.ready;
    const { authorization, baseUrl } = resolveCredentials(this.account);
    this.ns = this.namespace();
    const url = `${baseUrl.replace(/^http/, "ws")}/socket.io/?EIO=4&transport=websocket`;
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this.ready = null;
          reject(err);
        } else resolve();
      };
      const timer = setTimeout(() => done(new Error("raven typing: connect timeout")), CONNECT_TIMEOUT_MS);
      let ws;
      try {
        ws = new WebSocket(url, { headers: { Authorization: authorization } });
      } catch (e) {
        done(e);
        return;
      }
      this.ws = ws;
      ws.onmessage = (ev) => {
        const data = String(ev.data);
        if (data.startsWith("0")) ws.send(`40${this.ns},`); // engine open -> join namespace
        else if (data === "2") ws.send("3"); // ping -> pong
        else if (data.startsWith(`40${this.ns}`)) done();
        else if (data.startsWith(`44${this.ns}`)) done(new Error(`raven typing: namespace refused ${data.slice(0, 120)}`));
      };
      ws.onerror = () => done(new Error("raven typing: socket error"));
      ws.onclose = () => {
        this.ws = null;
        this.ready = null;
        this.active.clear();
        done(new Error("raven typing: socket closed"));
      };
    });
    return this.ready;
  }

  emit(event, channelId) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(`42${this.ns},${JSON.stringify([event, channelId])}`);
    }
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.active.size === 0) this.close();
    }, IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  close() {
    clearTimeout(this.idleTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.ready = null;
    this.active.clear();
  }
}

function connectionFor(account, log) {
  let c = connections.get(account.accountId);
  if (!c) {
    c = new Connection(account, log);
    connections.set(account.accountId, c);
  }
  c.account = account; // pick up config changes
  return c;
}

export async function startTyping(account, channelId, log) {
  if (!account.typingIndicator) return;
  const c = connectionFor(account, log);
  try {
    await c.connect();
    c.active.add(channelId);
    c.emit("raven_channel_typing", channelId);
    c.touch();
  } catch (e) {
    log?.info?.(`raven[${account.accountId}]: typing indicator unavailable: ${e.message}`);
  }
}

export function stopTyping(account, channelId) {
  const c = connections.get(account.accountId);
  if (!c) return;
  if (c.active.delete(channelId)) c.emit("raven_channel_typing_stopped", channelId);
  c.touch();
}

export function closeTyping(accountId) {
  connections.get(accountId)?.close();
  connections.delete(accountId);
}
