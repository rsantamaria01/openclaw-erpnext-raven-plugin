// Outbound attachments: load agent media (local workspace file or URL) with the
// host's guarded loader, then upload it to Raven as a real file message.
import path from "node:path";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { uploadRavenFile } from "./client.js";

function fileNameFor(url, media) {
  if (media.fileName) return media.fileName;
  try {
    const p = /^[a-z]+:\/\//i.test(url) ? new URL(url).pathname : url;
    const base = path.basename(decodeURIComponent(p));
    if (base && base !== "/" && base !== ".") return base;
  } catch {
    /* fall through */
  }
  return "archivo";
}

/**
 * Upload each media URL/path to a Raven channel as the account's user.
 * Load access: explicit host media access when the caller has it (message tool,
 * cron delivery), otherwise the agent's scoped media roots (its workspace and
 * the host media store), never arbitrary local files.
 * Returns the Raven message ids created; failures are logged and skipped.
 */
export async function sendRavenMediaUrls(account, channelId, urls, opts = {}) {
  const { cfg, agentId, replyTo, log, mediaAccess, mediaLocalRoots, mediaReadFile } = opts;
  const sent = [];
  let first = true;
  for (const url of urls) {
    try {
      const loadOptions = {
        maxBytes: account.mediaMaxBytes,
        ...(mediaAccess ? { mediaAccess } : {}),
        ...(mediaReadFile ? { mediaReadFile } : {}),
        mediaLocalRoots: mediaLocalRoots ?? (cfg ? getAgentScopedMediaLocalRoots(cfg, agentId) : undefined),
      };
      const media = await loadOutboundMediaFromUrl(url, loadOptions);
      const id = await uploadRavenFile(
        account,
        channelId,
        { buffer: media.buffer, fileName: fileNameFor(url, media), contentType: media.contentType },
        first ? replyTo : null,
      );
      first = false;
      sent.push(id);
    } catch (e) {
      log?.warn?.(`raven[${account.accountId}]: could not send attachment ${url}: ${e.message}`);
    }
  }
  return sent;
}
