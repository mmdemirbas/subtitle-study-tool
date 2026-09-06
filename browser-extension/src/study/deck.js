/* The personal deck: words and phrases kept, each with the line it came from.
 *
 * The line is the point. A word list is nearly useless a week later - "warrant"
 * on its own is four meanings and no register - whereas the same word under the
 * sentence somebody said it in, in the film you were watching, is a memory you
 * already have. So the sentence, the paired line in the other language, the
 * film and the timestamp are all part of the entry, not decoration on it, and
 * an entry is saved with them or not at all.
 *
 * Stored in the browser rather than in the daemon. Saving has to work on the
 * key that saves it, in the middle of a film, whether or not a local service
 * happens to be running - and unlike a subtitle there is no download quota to
 * protect and nothing the daemon can do that the browser cannot. The options
 * page exports the deck, which is how it reaches Anki or anything else.
 */

const KEY = "sso:deck";

/* One entry per word per film. Meeting "warrant" nine times in one film is one
 * thing worth remembering, not nine, and a deck that grows a row per repetition
 * is a deck nobody reviews. Across films it is a separate entry: the second
 * sentence is new evidence about the same word. */
const identity = (entry) => `${entry.language}:${entry.term}:${entry.fileId ?? ""}`;

/* The deck as stored, and a failure to read it is raised rather than answered.
 *
 * `all` used to swallow it and return [], which is a fine answer for something
 * that only displays the deck and a destructive one for anything that writes:
 * both writers are read-modify-write, so one failed read turned the next save
 * into "the deck is this one new word". Observed with a deck of one entry and
 * a single rejected storage read: save() returned added:true and the stored
 * deck became just the new word, with nothing thrown and nothing logged.
 * remove() wrote [] the same way. */
async function read() {
  const stored = await chrome.storage.local.get(KEY);
  return Array.isArray(stored[KEY]) ? stored[KEY] : [];
}

/** The deck for anything that only shows it; an unreadable deck reads empty. */
export async function all() {
  try {
    return await read();
  } catch {
    return [];
  }
}

async function write(entries) {
  await chrome.storage.local.set({ [KEY]: entries });
  return entries;
}

/* Every writer takes its turn, because all three are read-modify-write on one
 * storage key and none of them is atomic.
 *
 * `all()` and `set()` are both round trips to the browser process, so two saves
 * started close together each read the deck before either writes it, and the
 * second write lands on top of the first. Measured in node against a 5ms
 * store: two words saved together left one entry, and the lost one vanished
 * with no exception and nothing in the log.
 *
 * It is reachable by ordinary use - the save key pressed twice, Save clicked on
 * one card while another is still in flight, two tabs open on the same film.
 * A queue is enough here: one extension process, no other writer, and a deck
 * write is a few milliseconds.
 *
 * The chain never rejects, so one failed save cannot wedge every later one;
 * the caller still sees its own rejection through the promise it was handed. */
let queue = Promise.resolve();

function inTurn(work) {
  const done = queue.then(work, work);
  queue = done.then(
    () => {},
    () => {},
  );
  return done;
}

/**
 * Add an entry, or return the existing one untouched.
 *
 * `added` says which happened, so the toast can say "saved" rather than
 * claiming to have saved something that was already there.
 */
export function save(entry) {
  return inTurn(() => addOne(entry));
}

async function addOne(entry) {
  const term = String(entry.term || "").trim();
  if (!term) return { added: false, entry: null, reason: "nothing to save" };

  const record = {
    /* The clock is not enough on its own. Two saves of the same word against
     * two different films inside one millisecond took the same id, and remove()
     * deletes by id - so deleting one card deleted both. Observed: two saves
     * returned id "mtpd832h-warrant", and one remove reported removed:2. */
    id: `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}-${term.slice(0, 24)}`,
    term,
    language: entry.language || "en",
    rank: entry.rank ?? null,
    definitions: entry.definitions || [],
    phonetic: entry.phonetic || "",
    translation: entry.translation || "",
    // The line the word was in, and the same moment in every other subtitle.
    sentence: entry.sentence || "",
    paired: pairedOf(entry),
    title: entry.title || "",
    fileId: entry.fileId ?? null,
    // Position in the film, so the moment can be found again.
    timeMs: entry.timeMs ?? null,
    url: entry.url || "",
    savedAt: new Date().toISOString(),
  };

  const entries = await read();
  const existing = entries.find((item) => identity(item) === identity(record));
  if (existing) return { added: false, entry: existing };

  entries.push(record);
  await write(entries);
  return { added: true, entry: record, size: entries.length };
}

/* The same moment in the other subtitles, as a list.
 *
 * It was one `pairedSentence` and one `pairedLanguage`, which was enough while
 * study followed one subtitle out of two. With two being studied, or three on
 * screen, "the other one" names nothing, so an entry carries them all.
 *
 * Entries saved before that keep working: a stored pair reads back as a list of
 * one. The shim is here rather than at each reader, because a deck is a file
 * that outlives the code that wrote it and every reader would need the same
 * three lines. */
export function pairedOf(entry) {
  if (Array.isArray(entry?.paired)) {
    return entry.paired
      .filter((line) => line && line.text)
      .map((line) => ({ text: String(line.text), language: line.language || "" }));
  }
  if (entry?.pairedSentence) {
    return [{ text: entry.pairedSentence, language: entry.pairedLanguage || "" }];
  }
  return [];
}

export function remove(id) {
  // In the queue too: a removal racing a save reads the deck before the save
  // lands and writes it back without the new entry.
  return inTurn(async () => {
    const entries = await read();
    const kept = entries.filter((entry) => entry.id !== id);
    await write(kept);
    return { removed: entries.length - kept.length, size: kept.length };
  });
}

export function clear() {
  return inTurn(async () => {
    await write([]);
    return { size: 0 };
  });
}

/** The terms already in the deck, so the overlay can mark them as met before. */
export async function terms() {
  const entries = await all();
  return entries.map((entry) => `${entry.language}:${entry.term}`);
}

// --- export -----------------------------------------------------------------

const COLUMNS = [
  ["term", (entry) => entry.term],
  ["language", (entry) => entry.language],
  ["rank", (entry) => (entry.rank == null ? "" : String(entry.rank))],
  // Guarded like every other column. An entry saved by an older build, or one
  // hand-edited back in, has no definitions array - and one of those threw out
  // of the whole export rather than exporting an empty cell.
  ["definition", (entry) => (entry.definitions || []).map((d) => `${d.partOfSpeech}: ${d.sense}`).join(" | ")],
  ["phonetic", (entry) => entry.phonetic],
  ["translation", (entry) => entry.translation],
  ["sentence", (entry) => entry.sentence],
  /* One column still, with the lines joined, because the column name is what an
   * existing Anki note type is mapped to - a deck exported last month and one
   * exported today have to import the same way. */
  ["paired_sentence", (entry) => pairedOf(entry).map((line) => line.text).join(" | ")],
  ["title", (entry) => entry.title],
  ["time", (entry) => formatTime(entry.timeMs)],
  ["saved_at", (entry) => entry.savedAt],
];

export function formatTime(ms) {
  if (ms == null) return "";
  const total = Math.max(0, Math.round(ms / 1000));
  const parts = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

/**
 * Serialise the deck.
 *
 * `tsv` rather than csv is the default because that is what Anki's importer
 * takes without configuration, and a subtitle line is full of commas - the
 * character CSV would then have to quote in almost every row.
 *
 * Tabs and newlines are flattened, which used to be the whole of it, and the
 * quotes were left alone on the grounds that a tab-separated file has nothing
 * to quote. Anki's importer reads the file with Python's csv module, which
 * honours quotes whatever the delimiter is. Measured on four entries, one of
 * them holding a line of dialogue in quotation marks: the file parsed as three
 * rows instead of five, `"Get out," he said.` arrived as `Get out, he said.`,
 * and an unbalanced quote - ordinary when speech runs across two cues -
 * swallowed its own row and the two after it.
 *
 * So a field carrying a quote is quoted and its quotes doubled, which is what
 * RFC 4180 says and what that importer expects. Every field without one is
 * written exactly as before, so a deck exported last month and one exported
 * today still import the same way.
 */
export function serialise(entries, format = "tsv") {
  if (format === "json") return JSON.stringify(entries, null, 2);

  const field = (value) => {
    const flat = String(value || "").replace(/[\t\r\n]+/g, " ");
    return flat.includes('"') ? `"${flat.replace(/"/g, '""')}"` : flat;
  };
  const rows = [COLUMNS.map(([name]) => name)];
  for (const entry of entries) {
    rows.push(COLUMNS.map(([, take]) => field(take(entry))));
  }
  return rows.map((row) => row.join("\t")).join("\n");
}
