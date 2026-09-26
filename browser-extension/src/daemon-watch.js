/* Whether the daemon is there, said where the reader will see it.
 *
 * The daemon stopped on 2026-09-16 and nothing said so for ten days. The
 * extension carried on doing the work itself, as it is built to, while the
 * running log piled up to 4.8MB in the browser and was rewritten whole on every
 * line; it was found by reading Brave's storage off the disk. Asked for
 * directly: "show a badge or something like that on the subtitle extension
 * icon when daemon is connected vs not connected, otherwise I could easily
 * miss that the daemon is not running".
 *
 * Three surfaces read what is stored here: the toolbar icon (a badge and its
 * tooltip, set below), the popup, and the panel's status line, which watch
 * the stored record for themselves.
 *
 * Every look at the daemon reports here - provider.daemonUp()'s probe and
 * trace.js's POST - and the latest one wins. Both look at the same socket, so
 * the newer look is the truer one; there is no second opinion to reconcile.
 *
 * Only an installation that has seen the daemon answer is ever warned. The
 * daemon is optional, and for a reader who never started one "nothing is
 * listening" is the ordinary state (see daemonUp in provider.js): a red mark
 * on every such toolbar would be a warning nobody can act on and everybody
 * learns to ignore. */

export const PRESENCE_KEY = "sso:daemonPresence";
export const CHECK_ALARM = "sso:daemonCheck";
const BADGE = "!";
// The red the per-tab flag already uses, so the icon has one colour for trouble.
const RED = "#c2503f";
const TITLE = "Subtitle Overlay";

let known = null;
let queue = Promise.resolve();

function inTurn(work) {
  const done = queue.then(work, work);
  queue = done.then(
    () => {},
    () => {},
  );
  return done;
}

/** { up: true | false | null, why, since, seen }: null until the first look. */
export async function presence() {
  if (known) return known;
  try {
    const stored = (await chrome.storage.local.get(PRESENCE_KEY))[PRESENCE_KEY];
    known = stored && typeof stored === "object" ? stored : null;
  } catch {
    known = null;
  }
  known ||= { up: null, why: "", since: 0, seen: false };
  return known;
}

/**
 * Record one look at the daemon. Writes and redraws only when something the
 * reader would see changed, so the probe that runs every few seconds costs a
 * comparison and nothing else.
 */
export function noteDaemon(up, why = "") {
  return inTurn(async () => {
    try {
      const was = await presence();
      const next = { up, why: up ? "" : String(why || ""), since: was.since, seen: was.seen || up };
      if (was.up === next.up && was.why === next.why && was.seen === next.seen) return;
      next.since = Date.now();
      known = next;
      await chrome.storage.local.set({ [PRESENCE_KEY]: next });
      await show(next);
    } catch {
      // The icon is a courtesy. A failure to draw it must not fail the look.
    }
  });
}

/**
 * Put the icon back the way the stored record says. The browser keeps a badge
 * only for its own session, so a restart or a reload of the extension draws a
 * plain icon over a record that still says the daemon is gone.
 */
export async function restore() {
  try {
    await show(await presence());
  } catch {
    // As above.
  }
}

export const warned = (state) => Boolean(state?.seen) && state.up === false;

async function show(state) {
  const warn = warned(state);
  await chrome.action.setBadgeText({ text: warn ? BADGE : "" });
  if (warn) await chrome.action.setBadgeBackgroundColor({ color: RED });
  await chrome.action.setTitle({
    title: warn
      ? `${TITLE} - ${state.why || "the subtitle daemon is not running. Start subtitle-daemon/run.sh"}`
      : state.up
        ? `${TITLE} - daemon connected`
        : TITLE,
  });
  /* Looked for again once a minute while it is gone, and only then.
   *
   * Nothing else asks while a film plays on a page that carries its own
   * subtitles, so without this the badge would stay red after the daemon was
   * started until something happened to need it. An alarm rather than a timer
   * because a timer dies with the worker; and cleared the moment it answers,
   * because a worker woken every minute for a daemon that is running is the
   * cost this project has been removing. */
  if (warn) await chrome.alarms.create(CHECK_ALARM, { periodInMinutes: 1 });
  else await chrome.alarms.clear(CHECK_ALARM);
}
