/* The tab's sound, for a film the page will not let the extension hear.
 *
 * content.js hears the film through the element's captureStream(), and
 * Chrome refuses that for two kinds of video, both observed: one with
 * MediaKeys ("Stream capture not supported with EME") - every film behind
 * DRM, which is every streaming site with an account - and one whose data is
 * from another origin without CORS. What is left is the tab's own sound,
 * through chrome.tabCapture, and Chrome hands that only to an extension the
 * reader has invoked on the tab: its toolbar button or one of its shortcuts.
 * Measured 2026-10-23 on Chrome 155 against Shaka's Widevine Sintel: refused
 * before an invocation ("Extension has not been invoked for the current
 * page"), and after one the capture carried the film at the levels
 * captureStream() reads off the clear copy - 300-3400Hz median -65.9dB
 * against -67.4dB, p90 -45.8 against -43.2.
 *
 * So the frame that was refused asks here; if the tab has not been invoked
 * it is told so and tells the reader what to press, and says it wants the
 * tab in its status. The next invocation on that tab - runCommand, which the
 * shortcuts and the popup's buttons both go through, or the popup opening -
 * reads that status and opens it. Nothing is remembered here, so a worker
 * that was stopped in between loses nothing.
 *
 * Capturing a tab takes its sound off the speakers until something plays it
 * back, so the offscreen document plays it back. One tab at a time: there is
 * one offscreen document, and opening another tab's ear closes the first,
 * which gives that tab its own sound back. */

const OFFSCREEN_URL = "src/offscreen.html";
let creating = null;

async function offscreenOpen() {
  try {
    const contexts = await chrome.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return Boolean(contexts?.length);
  } catch {
    return false;
  }
}

async function ensureOffscreen() {
  if (await offscreenOpen()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ["USER_MEDIA"],
      justification: "Hearing the film in this tab, to line its subtitle up with the dialogue",
    })
    .catch((error) => {
      // A second document is refused by name; one that exists is what was wanted.
      if (!/single offscreen/i.test(String(error?.message))) throw error;
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

/* Open the tab's ear for the frame that has the film, or say why not.
 * `invoke: true` means the reader has to press something first. */
export async function openTabEar(tabId, frameId) {
  if (await offscreenOpen()) {
    const adopted = await chrome.runtime.sendMessage({ target: "offscreen", type: "earAdopt", tabId, frameId }).catch(() => null);
    if (adopted?.ok) return adopted;
  }
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    const reason = String(error?.message || error);
    return { ok: false, reason, invoke: /not been invoked/i.test(reason), shortcut: await shortcut() };
  }
  await ensureOffscreen();
  const opened = await chrome.runtime.sendMessage({ target: "offscreen", type: "earOpen", tabId, frameId, streamId }).catch((error) => ({
    ok: false,
    reason: String(error?.message || error),
  }));
  return opened || { ok: false, reason: "the offscreen document did not answer" };
}

export async function closeTabEar(tabId, reason) {
  if (!(await offscreenOpen())) return;
  const answer = await chrome.runtime.sendMessage({ target: "offscreen", type: "earClose", tabId, reason }).catch(() => null);
  if (answer?.remaining === 0) await chrome.offscreen.closeDocument().catch(() => {});
}

/* What to tell the reader to press: the panel's shortcut as they have it
 * bound, or nothing if they unbound it. */
async function shortcut() {
  try {
    const commands = await chrome.commands.getAll();
    return commands.find((command) => command.name === "toggle-panel")?.shortcut || null;
  } catch {
    return null;
  }
}
