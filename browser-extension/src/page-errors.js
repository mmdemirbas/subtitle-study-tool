/* Errors from the extension's own pages, sent where everything else goes.
 *
 * The content scripts and the service worker have recorded their own failures
 * since trace.js was written. The three extension PAGES never did, so anything
 * that broke on the settings page, the popup or the report page existed in one
 * place only: chrome://extensions, which nobody has open, which keeps nothing
 * across a reload, and which cannot be read from here.
 *
 * That was the gap behind "there are some errors on the extension errors page,
 * transfer them to the daemon so future investigations are easier". This is
 * that transfer. The log already carries `error` entries from the frames and
 * the worker; these arrive in the same shape and sit beside them.
 *
 * One thing it deliberately does NOT try to do: report a context that has been
 * invalidated. An extension page dies with its extension - there is no orphaned
 * page the way there is an orphaned content script - and the worker a report
 * would travel through is exactly what has gone. Hence the bare try/catch: a
 * reporter that throws while reporting is worse than a missing line.
 */

/** Say where these came from, and start listening. Safe to call twice. */
export function reportPageErrors(where) {
  if (globalThis.__ssoPageErrors) return;
  globalThis.__ssoPageErrors = true;

  const send = (detail) => {
    try {
      chrome.runtime
        .sendMessage({ type: "sso:daemon", op: "trace", args: { kind: "error", detail } })
        .catch(() => {});
    } catch {
      // Nowhere left to say it. See the note above.
    }
  };

  addEventListener("error", (event) => {
    send({
      where,
      // Always: an extension page runs no third-party script, so unlike the
      // content scripts there is no page code here to be confused with ours.
      mine: true,
      url: location.href,
      message: String(event.message || event.error?.message || event.error || "error"),
      stack: String(event.error?.stack || "").slice(0, 2000),
      file: `${event.filename || ""}:${event.lineno || 0}`,
    });
  });

  addEventListener("unhandledrejection", (event) => {
    send({
      where,
      mine: true,
      url: location.href,
      unhandledRejection: true,
      message: String(event.reason?.message || event.reason || "rejection"),
      stack: String(event.reason?.stack || "").slice(0, 2000),
    });
  });
}
