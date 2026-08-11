/* What the extension saw, recorded as it happens rather than when somebody
 * thinks to ask for it.
 *
 * The diagnostic report next door answers "why did this page not work" on
 * demand, and that is the wrong shape for two kinds of question.
 *
 * The first is structure. A page is three documents deep, one of them
 * cross-origin, and which frame holds the film decides everything the
 * extension does. Asking for that after the fact means asking somebody to
 * reproduce a thing that has already happened, on a page whose player may have
 * navigated since. Recording it at the moment the panel opens costs nothing
 * and means the arrangement is already written down.
 *
 * The second is the aligner. Whether two subtitle files can be lined up is
 * decided entirely by their cue times, and no amount of reading the code
 * substitutes for the pair that failed. Every attempt is recorded with both
 * files' timings and the answer it gave - and, when the reader then takes the
 * offer or undoes it, with what they thought of that answer. That last part is
 * the only ground truth there is about whether an answer was right.
 *
 * All of it stays on this machine. Nothing here is sent anywhere; the report
 * page has a button that writes the log to a file, and that is the only way it
 * leaves.
 */

const KEY = "sso:trace";

/* Bounded twice, because the two kinds of entry have very different sizes. A
 * page trace is a few kilobytes per frame; an alignment attempt carries two
 * files' worth of timings. Whichever bound is reached first drops the oldest
 * entries, and the log says how many it dropped rather than quietly shrinking. */
const MAX_ENTRIES = 40;
const MAX_BYTES = 2_000_000;

/* Every writer takes its turn. Read-modify-write on one storage key, exactly
 * as the deck does it, and for the same reason: two traces started close
 * together each read the log before either writes it, and the second write
 * lands on top of the first. The panel opening fires one and an alignment
 * started from it fires another, milliseconds apart. */
let queue = Promise.resolve();

function inTurn(work) {
  const done = queue.then(work, work);
  queue = done.then(
    () => {},
    () => {},
  );
  return done;
}

export async function entries() {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return Array.isArray(stored[KEY]) ? stored[KEY] : [];
  } catch {
    return [];
  }
}

export function clear() {
  return inTurn(() => chrome.storage.local.remove(KEY).catch(() => {}));
}

/**
 * Add one entry. `at` is stamped here so every entry has one, whatever the
 * caller remembered.
 */
export function record(kind, detail) {
  return inTurn(async () => {
    try {
      const log = await entries();
      log.push({ at: new Date().toISOString(), kind, ...detail });
      await chrome.storage.local.set({ [KEY]: trim(log) });
    } catch {
      // A trace that cannot be written must never break what it was tracing.
    }
  });
}

function trim(log) {
  let kept = log.length > MAX_ENTRIES ? log.slice(log.length - MAX_ENTRIES) : log;
  /* Measured rather than estimated, because an alignment entry for a
   * thousand-cue pair is two orders of magnitude larger than a page trace and
   * a count-only bound would let ten of them fill the quota. */
  while (kept.length > 1 && JSON.stringify(kept).length > MAX_BYTES) {
    kept = kept.slice(1);
  }
  return kept;
}

/* Cue times, small enough to keep a lot of them.
 *
 * A subtitle is a thousand or more starts, each up to eight digits, and the
 * gaps between them are three or four. Storing the gaps rather than the times
 * is a third of the size for something that reconstructs exactly, which
 * matters because the whole point is keeping enough attempts to compare them.
 */
export function packTimes(times) {
  const out = [];
  let previous = 0;
  for (const time of times) {
    const value = Math.round(time);
    out.push(value - previous);
    previous = value;
  }
  return out;
}

export function unpackTimes(gaps) {
  const out = [];
  let running = 0;
  for (const gap of gaps) {
    running += gap;
    out.push(running);
  }
  return out;
}
