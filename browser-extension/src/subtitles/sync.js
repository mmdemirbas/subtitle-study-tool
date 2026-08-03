/* Keeping the extension's cache and the daemon's in step.
 *
 * The two cannot be one store. An extension has no filesystem, so it cannot
 * read or write subtitle-daemon/cache/, and the daemon cannot reach IndexedDB.
 * What matters is not that the bytes live in one place but that a download is
 * never spent twice, so the two stores are converged whenever the daemon is
 * reachable: anything either side holds and the other does not gets copied.
 *
 * Direction matters for different reasons.
 *
 * - **Push** is the one that protects quota. A subtitle the extension fetched
 *   while the daemon was stopped is invisible to the daemon, so the next search
 *   through the daemon would rank that upload, miss its cache, and spend a
 *   second download on a file already held.
 * - **Pull** is what makes the daemon's history usable offline. Without it, a
 *   film downloaded through the daemon last week would be re-downloaded by the
 *   extension the first time the daemon is not running.
 *
 * Both run on connect, before any search, so neither side can act on a stale
 * view of what is held.
 */

import * as cache from "./cache.js";

const toBase64 = (bytes) => {
  let binary = "";
  // In chunks: String.fromCharCode with a whole subtitle's worth of arguments
  // overflows the call stack.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
};

const fromBase64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/**
 * Copy anything either side is missing. Returns what moved.
 *
 * Failures are counted, not thrown: a sync that cannot finish should cost the
 * convergence, not the search the user is waiting for.
 */
export async function converge(daemon) {
  const result = { deleted: 0, pushed: 0, pulled: 0, failed: 0 };

  /* Deletions first, and before anything is listed. A subtitle deleted here
   * while the daemon was stopped is still on the daemon, so pushing or pulling
   * before carrying the deletion out would copy it straight back and undo the
   * user's action. */
  for (const pending of await cache.pendingDeletions()) {
    try {
      await daemon.forget(pending.file_id);
      await cache.clearPendingDeletion(pending.file_id);
      result.deleted++;
    } catch {
      // Stays pending; it will be retried on the next convergence.
      result.failed++;
    }
  }

  let theirs;
  try {
    theirs = await daemon.cached();
  } catch {
    // The daemon went away between the health check and here. Nothing to do.
    return result;
  }
  const theirIds = new Set((theirs.subtitles || []).map((item) => item.file_id));

  const mine = await cache.listSubtitles();
  const myIds = new Set(mine.map((item) => item.file_id));

  for (const record of mine) {
    if (theirIds.has(record.file_id)) continue;
    try {
      const response = await daemon.importSubtitle({
        file_id: record.file_id,
        content: toBase64(record.bytes),
        meta: record.meta,
      });
      if (response.imported) result.pushed++;
    } catch {
      result.failed++;
    }
  }

  for (const item of theirs.subtitles || []) {
    if (myIds.has(item.file_id)) continue;
    try {
      const response = await daemon.cachedOne(item.file_id, { content: true });
      if (!response.content) {
        result.failed++;
        continue;
      }
      const { file_id: fileId, ...meta } = item;
      await cache.importSubtitle(fileId, fromBase64(response.content), meta);
      result.pulled++;
    } catch {
      result.failed++;
    }
  }

  return result;
}
