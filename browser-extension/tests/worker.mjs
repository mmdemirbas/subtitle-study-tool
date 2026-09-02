/* The service worker's own tests. `node tests/worker.mjs` from browser-extension.
 *
 * Neither browser harness loads background.js: harness.html is the overlay in a
 * hostile page and fallback.html is the fetch path, and both stub the worker
 * away because that is what a content script sees. So the half of the extension
 * that decides what to do with a tab had nothing running it at all.
 *
 * Chrome is stubbed rather than mocked per call: the listeners the worker
 * registers are captured and then invoked, so what is under test is the same
 * dispatch the browser would perform.
 */
const listeners = { message: [], removed: [], command: null, global: {} };
// Every file the log wrote, every batch it POSTed to the daemon, and switches
// for making either fail - which is the interesting half.
const written = [];
const posted = [];
let downloadsFail = false;
let daemonUp = true;
let foreignOnPort = false;
/* What the subtitle daemon answers, for the cases that need a search to come
 * back with something. null is "nothing is listening", which is what every
 * other case here wants and what the fetch below produces by rejecting. */
let daemonAnswers = null;

/* The daemon is a socket, so it is stubbed as one. The extension does not
 * health-check it: the POST is the check, and "not running" arrives as a fetch
 * that rejects - which is exactly what this does. */
globalThis.fetch = async (url, options) => {
  if (String(url).includes("/log")) {
    if (!daemonUp) throw new TypeError("Failed to fetch");
    /* Something that is not the daemon, holding 8791 - the same case the
     * health probe has to handle. It answers, so the POST succeeds and the log
     * would be dropped from the browser having gone to a stranger. */
    if (foreignOnPort) return { ok: true, status: 200, json: async () => ({}) };
    posted.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, file: "logs/today.jsonl" }) };
  }
  if (daemonAnswers) {
    const answer = daemonAnswers(String(url));
    if (answer) return { ok: true, status: 200, json: async () => answer };
  }
  throw new TypeError("Failed to fetch");
};

/* A service worker's global is an EventTarget and node's is not, so the worker
 * registering its own error handlers would throw here on a line that is
 * correct in Chrome. Captured rather than ignored: a test can fire them, which
 * is the only way to check that a failure in the worker is written down at
 * all. */
globalThis.addEventListener = (type, fn) => {
  (listeners.global[type] ||= []).push(fn);
};
let frameList = [{ frameId: 0 }];
const store = {};
const sentToTab = [];
// Every scripting call the worker made, so a test can assert the injection
// happened rather than only that nothing threw.
const injected = [];
let tabStatusReply = { ok: true, hasVideo: true, attached: false };
// What each frame says about the page. Replaced by the pageContext cases.
let pageInfoReply = () => ({ ok: true });
// Whether the tab has a content script that answers. False is a tab left open
// across an extension update, which is the case the self-heal exists for.
let pingAlive = false;

globalThis.indexedDB = {
  open: () => {
    const request = {};
    queueMicrotask(() => request.onerror?.());
    return request;
  },
};

globalThis.chrome = {
  runtime: {
    /* Mirrors the real manifest, and the `css` key is deliberately absent.
     *
     * It used to be `[{ js: [], css: [] }]`, which handed the worker a key the
     * real manifest does not have - every stylesheet here is fetched at runtime
     * and adopted into a shadow root, so `content_scripts[0]` carries only
     * `js`. With the key supplied by the stub, the insertCSS that opens both
     * injection paths looked fine; against the real manifest it throws
     * "Exactly one of 'css' and 'files' must be specified" and takes the
     * executeScript after it down with it. A stub more forgiving than the API
     * it stands for is how a whole feature ran green having never run. */
    getManifest: () => ({
      version: "test",
      content_scripts: [{ js: ["src/align.js", "src/content.js"], matches: ["<all_urls>"] }],
    }),
    getURL: (p) => `chrome-extension://test/${p}`,
    onInstalled: { addListener() {} },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    lastError: null,
  },
  // Captured, not discarded: the command path is where the self-heal runs.
  commands: { onCommand: { addListener: (fn) => { listeners.command = fn; } } },
  /* The log writes itself to disk, so the thing that writes it is stubbed the
   * way Chrome behaves: a promise, an id back, and a rejection when it cannot
   * write - which is the case the buffer must survive rather than discard. */
  downloads: {
    setUiOptions() {},
    async download(options) {
      if (downloadsFail) throw new Error("disk is full");
      written.push(options);
      return written.length;
    },
  },
  /* Optional host permissions, which study mode asks about before reaching a
     dictionary or a translator. Absent, `contains` threw inside a catch and
     every such question answered "no" - so the two paths that need one were
     unreachable from here and looked tested. Granted, because what these cases
     are about is what happens after permission exists. */
  permissions: {
    async contains() { return true; },
  },
  storage: {
    local: {
      async get(key) {
        if (key == null) return { ...store };
        const keys = Array.isArray(key) ? key : [key];
        return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]));
      },
      async set(obj) { Object.assign(store, obj); },
      async remove(key) { delete store[key]; },
    },
  },
  tabs: {
    onRemoved: { addListener: (fn) => listeners.removed.push(fn) },
    async query() { return [{ id: 1, url: "https://example.tv/watch/1" }]; },
    async get(id) { return { id, url: "https://example.tv/watch/1" }; },
    async create() { return {}; },
    async sendMessage(tabId, message) {
      sentToTab.push({ tabId, type: message.type, message });
      if (message.type === "sso:status") return { ...tabStatusReply };
      // Two frames describing the same page differently, which is the shape
      // pageContextForTab exists to reconcile. Set per case.
      if (message.type === "sso:pageInfo") return pageInfoReply(message, arguments[2]);
      if (message.type === "sso:ping") {
        // What Chrome does when nothing is listening in the tab.
        if (!pingAlive) throw new Error("Could not establish connection.");
        return { ok: true, version: chrome.runtime.getManifest().version };
      }
      return { ok: true };
    },
  },
  /* Rejects what the real API rejects.
   *
   * These were `async insertCSS() {}` and `async executeScript() {}` - stubs
   * that accept anything. Against them, an insertCSS called with
   * `files: undefined` looked like a working line, and the executeScript it
   * shared a try with looked like it ran. In Chrome the first throws "Exactly
   * one of 'css' and 'files' must be specified" and the second never happens.
   * A stub more permissive than the API is not a test of the caller. */
  scripting: {
    async insertCSS(options) {
      injected.push({ what: "css", ...options });
      const given = (value) => value !== undefined && value !== null;
      if (given(options.css) === given(options.files)) {
        throw new Error("Exactly one of 'css' and 'files' must be specified.");
      }
      if (given(options.files) && !Array.isArray(options.files)) {
        throw new Error("'files' must be an array.");
      }
    },
    async executeScript(options) {
      injected.push({ what: "js", ...options });
      if (!Array.isArray(options.files) || options.files.length === 0) {
        throw new Error("Exactly one of 'files' and 'func' must be specified.");
      }
      return [];
    },
  },
  webNavigation: { async getAllFrames() { return frameList; } },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
};

await import("../src/background.js");

const ask = (message, sender) =>
  new Promise((resolve) => {
    let answered = false;
    for (const fn of listeners.message) {
      const kept = fn(message, sender, (reply) => { answered = true; resolve(reply); });
      if (kept) return;
    }
    if (!answered) resolve(undefined);
  });

const TAB = { id: 1, url: "https://example.tv/watch/1" };
const sender = { tab: TAB };
const sites = () => store["sso:autoSites"];
const toasts = () => sentToTab.filter((m) => m.type === "sso:toast").map((m) => m.message.message);

const results = [];
const t = (name, ok, detail = "") => results.push({ name, ok, detail });

// 1. A site nobody has decided about turns itself on at the first attach, once.
await ask({ type: "sso:attached" }, sender);
t("first attach enables the site", sites()?.["https://example.tv"] === true, JSON.stringify(sites()));
t("and says so", toasts().length === 1, JSON.stringify(toasts()));

sentToTab.length = 0;
await ask({ type: "sso:attached" }, sender);
t("a second attach says nothing more", toasts().length === 0, JSON.stringify(toasts()));

// 2. Turning it off has to stick, even when the reader attaches by hand after.
await ask({ type: "sso:daemon", op: "autoSiteSet", args: { enabled: false } }, sender);
t("the switch turns it off", sites()["https://example.tv"] === false);
await ask({ type: "sso:attached" }, sender);
t("and an attach does not turn it back on", sites()["https://example.tv"] === false,
  JSON.stringify(sites()));

// 3. A programme change on a site that is off does nothing at all.
sentToTab.length = 0;
const off = await ask({ type: "sso:programme", mark: "2400|Ep 4" }, sender);
t("a new episode is ignored where it is off", off?.ok === false && !sentToTab.some(
  (m) => m.type === "sso:detach"), JSON.stringify(off));

/* 4. Switched on, and the search comes back with nothing.
 *
 * The last episode's subtitles used to come off before the search started, on
 * the argument that lines from the wrong file read as a sync fault. They do -
 * and it traded a wrong subtitle for no subtitle every time the search that
 * followed found nothing. Twice in one evening on 2026-08-23, on a film that
 * had both languages on it a second earlier: reported as "my subtitles are
 * gone again in the middle of the movie". */
await ask({ type: "sso:daemon", op: "autoSiteSet", args: { enabled: true } }, sender);
tabStatusReply = { ok: true, hasVideo: true, attached: true };
// A daemon that is there and has nothing, rather than a daemon that is not
// there: the search has to fail on its answer, not on the transport.
daemonAnswers = (url) => {
  if (url.endsWith("/health")) return { default_languages: ["en"] };
  if (url.includes("/search")) return { used: { query: "Ep 5" }, results: [] };
  return null;
};
sentToTab.length = 0;
await ask({ type: "sso:programme", mark: "2400|Ep 5" }, sender);
t("a search that finds nothing leaves the last episode's subtitles alone",
  !sentToTab.some((m) => m.type === "sso:detach"),
  sentToTab.map((m) => m.type).join(","));
t("and says why",
  toasts().some((m) => /No subtitles found/i.test(m)),
  JSON.stringify(toasts()));

/* 4b. ...and when there IS something to put up, the old one still goes first.
 *
 * Both halves matter. Without the detach, a pair replaced by a single language
 * leaves the other slot holding the last episode - which is the confidently
 * wrong subtitle the old ordering existed to prevent. */
daemonAnswers = (url) => {
  if (url.endsWith("/health")) return { default_languages: ["en"] };
  if (url.includes("/search")) {
    return {
      used: { query: "A Film" },
      resolved: { type: "movie", imdb_id: "tt1" },
      auto_attach_threshold: 0.75,
      results: [{
        file_id: 7, language: "en", release: "A.Film.1080p", movie_name: "A Film",
        match_score: 0.99, download_count: 10,
      }],
    };
  }
  if (url.endsWith("/fetch")) return { cues: [{ start: 0, end: 1000, text: "hello" }] };
  return null;
};
sentToTab.length = 0;
await ask({ type: "sso:programme", mark: "2400|Ep 5b" }, sender);
const order = sentToTab.map((m) => m.type);
t("a search that finds one takes the last episode's off first",
  order.indexOf("sso:detach") >= 0 && order.indexOf("sso:detach") < order.indexOf("sso:attach"),
  order.join(","));
daemonAnswers = null;

/* 4c. A resolved title is the guard. The uploader's file name is not.
 *
 * Reported as an episode that would not attach by itself. From the log on
 * 2026-08-23: The Americans season 3 episode 13 resolved to tt2149175 with no
 * rivals, the search went out by that id with the season and episode on it, and
 * all seven results that came back were S03E13 - every one of them refused at
 * match_score 0.70 against a threshold of 0.75. Episode 12 the same day
 * attached at 0.85, and the whole of the difference was that one uploader had
 * called their file "The Americans S03E12" while the rest carried a release
 * name. The score was deciding on the length of the episode's title.
 */
const seriesPage = {
  ok: true,
  year: 2015,
  candidates: [
    {
      source: "json-ld",
      text: "The Americans S03E13 March 8, 1983.mkv",
      episode: { season: 3, episode: 13, matched: "S03E13" },
    },
    { source: "json-ld-series", text: "The Americans", episode: null },
  ],
  episode: { fromMetadata: { season: 3, episode: 13, matched: "schema.org episodeNumber" } },
};

/* One badly-named result for the right episode, and the switches that decide
 * whether the daemon knew which programme it was answering about. */
const americans = ({ resolved = true, ambiguous = false, episode = 13 } = {}) => (url) => {
  if (url.endsWith("/health")) return { default_languages: ["en"] };
  if (url.includes("/search")) {
    const answer = {
      used: { query: "The Americans", season: 3, episode: 13, languages: ["en"] },
      auto_attach_threshold: 0.75,
      results: [{
        file_id: 13, language: "en", season: 3, episode,
        movie_name: "The Americans - S03E13  March 8, 1983",
        release: "The.Americans.2013.S03E13.HDTV.x264-KILLERS",
        download_count: 74396, from_trusted: true, match_score: 0.7, year: 2015,
      }],
    };
    if (resolved) {
      answer.resolved = { title: "the americans", year: 2013, imdb_id: "2149175", type: "Tvshow" };
    }
    if (ambiguous) answer.ambiguous_title = true;
    return answer;
  }
  if (url.endsWith("/fetch")) return { cues: [{ start: 0, end: 1000, text: "hello" }] };
  return null;
};

const attempt = async (mark, answers) => {
  pageInfoReply = () => seriesPage;
  daemonAnswers = answers;
  tabStatusReply = { ok: true, hasVideo: true, attached: false };
  sentToTab.length = 0;
  await ask({ type: "sso:programme", mark }, sender);
  const out = { types: sentToTab.map((m) => m.type), said: toasts() };
  daemonAnswers = null;
  pageInfoReply = () => ({ ok: true });
  return out;
};

let tried = await attempt("2900|E13", americans());
t("a resolved episode attaches however its uploader named the file",
  tried.types.includes("sso:attach"),
  JSON.stringify(tried));

/* The other side of it, and the reason the score is still there. Without a
 * resolved title the search was `query=` and OpenSubtitles will confidently
 * return an unrelated film - which is how "Ekusute" was once downloaded for a
 * Crime 101 search. */
tried = await attempt("2901|E13", americans({ resolved: false }));
t("an unresolved title is still refused on the name score",
  !tried.types.includes("sso:attach") && tried.said.some((m) => /Nothing matched/.test(m)),
  JSON.stringify(tried));

/* And where the daemon says it could not tell two titles apart, "resolved" is
 * a coin toss rather than an answer. */
tried = await attempt("2902|E13", americans({ ambiguous: true }));
t("an ambiguous title is still refused on the name score",
  !tried.types.includes("sso:attach") && tried.said.some((m) => /Nothing matched/.test(m)),
  JSON.stringify(tried));

/* Resolved is not the same question as the right instalment. When the episode
 * has no subtitles at all the daemon falls back to the series as a whole, so a
 * resolved answer can be every episode but this one. */
tried = await attempt("2903|E13", americans({ episode: 4 }));
t("a resolved title carrying another episode is refused",
  !tried.types.includes("sso:attach") && tried.said.some((m) => /Nothing matched/.test(m)),
  JSON.stringify(tried));

// 5. The same programme reported by every frame is handled once.
sentToTab.length = 0;
await ask({ type: "sso:programme", mark: "2400|Ep 5" }, sender);
t("the same episode is not handled twice",
  !sentToTab.some((m) => m.type === "sso:detach"),
  sentToTab.map((m) => m.type).join(","));

/* 5b. A film that has not started yet must not cost the one attempt.
 *
 * Reported as "subtitles should be immediately loaded in video start without
 * much delay - but it fails to find subtitles, and even video for a while, I
 * need to try multiple times".
 *
 * The mark is written down as handled before anything else happens, so a bail
 * on "no video" spent the attempt on a reading taken before the film started
 * and nothing ever tried again. On any page with a play button that is every
 * time. The search does not need a picture, so it runs while the film is
 * still arriving, and the wait is only for somewhere to put the answer.
 */
sentToTab.length = 0;
tabStatusReply = { ok: true, hasVideo: false, videoComing: true, attached: false };
const late = ask({ type: "sso:programme", mark: "2400|Ep 6" }, sender);
// The film turns up a moment later, the way a remuxed stream does.
setTimeout(() => { tabStatusReply = { ok: true, hasVideo: true, videoComing: true, attached: false }; }, 400);
await late;
t("a film that starts a moment late is still searched for",
  toasts().some((m) => /Looking for subtitles/.test(m)),
  JSON.stringify(toasts()));
t("and it is not refused for having had no video when the page said so",
  !toasts().some((m) => /No video playing/.test(m)),
  JSON.stringify(toasts()));

// 5c. ...and a page with no film coming is still refused at once, rather than
//     after a silent wait for something that is not on its way.
sentToTab.length = 0;
tabStatusReply = { ok: true, hasVideo: false, videoComing: false, attached: false };
const startedAt = Date.now();
await ask({ type: "sso:programme", mark: "2400|Ep 7" }, sender);
const waited = Date.now() - startedAt;
t("a page with no film is refused without waiting for one",
  toasts().some((m) => /No video playing/.test(m)) && waited < 2000,
  `${waited}ms: ${JSON.stringify(toasts())}`);
tabStatusReply = { ok: true, hasVideo: true, videoComing: true, attached: false };

// 6. The panel can read the state back.
const read = await ask({ type: "sso:daemon", op: "autoSite", args: {} }, sender);
t("the panel can read it back", read?.enabled === true && read?.origin === "https://example.tv",
  JSON.stringify(read));

// 7. The second language of a pair, which is what "either TR or both are not
//    loaded, I need to add manually each time" was about.
const { pickSecondLanguage } = await import("../src/daemon.js");

const EN = { language: "en", match_score: 1.0, season: 2, episode: 4 };
const TR_BADLY_NAMED = { language: "tr", match_score: 0.31, season: 2, episode: 4 };
const TR_WRONG_EP = { language: "tr", match_score: 0.98, season: 2, episode: 9 };
const askSecond = (results, extra = {}) => pickSecondLanguage({
  results, languages: ["en", "tr"], taken: "en",
  used: { season: 2, episode: 4 }, threshold: 0.75, query: "The Americans",
  resolved: true, ...extra,
});

let got = askSecond([EN, TR_BADLY_NAMED]);
t("a Turkish subtitle named in Turkish is still the pair's other half",
  got.result === TR_BADLY_NAMED, JSON.stringify(got));

got = askSecond([EN, TR_WRONG_EP]);
t("a subtitle for another episode is not taken to fill the pair",
  got.result === null && /another episode/.test(got.reason), JSON.stringify(got));

got = askSecond([EN, TR_BADLY_NAMED], { resolved: false });
t("without a resolved title the name score is still the only guard",
  got.result === null && /well enough/.test(got.reason), JSON.stringify(got));

got = askSecond([EN]);
t("a language with nothing in it says so rather than nothing",
  got.result === null && got.reason.length > 0, JSON.stringify(got));

got = pickSecondLanguage({ results: [EN], languages: ["en"], taken: "en", used: {}, threshold: 0.75 });
t("one configured language is not a missing pair", got.result === null && got.reason === "",
  JSON.stringify(got));

// 8. A tab left open across an update is repaired, and the repair really runs.
//
// Reloading an extension does not update tabs that are already open: they keep
// the previous content script until navigated, so a new command arrives and
// nothing in the page knows about it. ensureInjected is the answer to that, and
// it had never once executed - the insertCSS opening it threw on every call and
// took the executeScript with it.
//
// Asserting on `injected` rather than on "nothing threw", because not throwing
// is exactly what the broken version did.
injected.length = 0;
sentToTab.length = 0;
pingAlive = false; // the tab is stale
await listeners.command("toggle-panel");
t(
  "a stale tab gets the current content scripts",
  injected.some((call) => call.what === "js" && call.files?.length),
  JSON.stringify(injected.map((c) => c.what)),
);
t(
  "and the command is delivered afterwards",
  sentToTab.some((m) => m.type === "sso:togglePanel"),
  sentToTab.map((m) => m.type).join(","),
);

// A tab already running the current version is left alone.
injected.length = 0;
pingAlive = true;
await listeners.command("toggle-panel");
t("a tab already running the current version is not re-injected",
  injected.length === 0, JSON.stringify(injected.map((c) => c.what)));
pingAlive = false;

// 9. The deck is one storage key, and every writer has to take its turn.
//
// save() is read-modify-write and neither the read nor the write is atomic, so
// two saves started together each read the deck before either writes it and the
// second write lands on top of the first. Measured against a 5ms store before
// the queue: two words saved at once left one entry, and the lost one went with
// no exception and nothing in the log. Reachable by pressing the save key
// twice, by clicking Save on one card while another is in flight, or from two
// tabs on the same film.
//
// The stub is slowed AND made to copy for this, because the plain one cannot
// show the defect and the reason is worth writing down: it hands every reader
// the same array object, so three concurrent saves push into one array and all
// three survive by accident. Real chrome.storage serialises across a process
// boundary, so each reader gets its own copy and the last write wins. A stub
// that shares structure is more forgiving than the API it stands for, and the
// case passes against the broken code - which is how this went unnoticed.
const deck = await import("../src/study/deck.js");

const instant = { get: chrome.storage.local.get, set: chrome.storage.local.set };
const real = (fn) => async (...args) => {
  await new Promise((r) => setTimeout(r, 5));
  return structuredClone(await fn.apply(chrome.storage.local, structuredClone(args)));
};
chrome.storage.local.get = real(instant.get);
chrome.storage.local.set = real(instant.set);

await deck.clear();
await Promise.all([
  deck.save({ term: "warrant", language: "en", fileId: 1 }),
  deck.save({ term: "reckon", language: "en", fileId: 1 }),
  deck.save({ term: "quarry", language: "en", fileId: 1 }),
]);
const kept = (await deck.all()).map((entry) => entry.term).sort();
t("three words saved at once all survive", kept.length === 3, kept.join(",") || "(empty)");

await deck.clear();
await deck.save({ term: "one", language: "en", fileId: 1 });
const [only] = await deck.all();
await Promise.all([
  deck.save({ term: "two", language: "en", fileId: 1 }),
  deck.remove(only.id),
]);
const after = (await deck.all()).map((entry) => entry.term);
t(
  "a removal racing a save does not take the save with it",
  after.length === 1 && after[0] === "two",
  after.join(",") || "(empty)",
);

// --- the running log --------------------------------------------------------
/* Same slow store as the deck above, and for the same reason: this is a
 * read-modify-write on one key with two callers that fire milliseconds apart -
 * the panel opening writes one entry and a Line up pressed on it writes
 * another. Against an instant store they never overlap and the test proves
 * nothing. */
const trace = await import("../src/trace.js");

/* The command tests above record traces of their own, and they do not wait for
 * them - the worker's callers never do, deliberately. So a case that counts
 * entries has to let those land and then start from empty, or it is counting
 * somebody else's work and will fail depending on how the event loop went. */
const resetTrace = async () => {
  downloadsFail = false;
  daemonUp = true;
  foreignOnPort = false;
  await new Promise((r) => setTimeout(r, 60));
  await trace.flush();
  await trace.clear();
  written.length = 0;
  posted.length = 0;
};

await resetTrace();
await Promise.all([
  trace.record("panel", { open: true }),
  trace.record("align", { slot: 1 }),
  trace.record("alignOutcome", { outcome: "undone" }),
]);
const kinds = (await trace.entries()).map((e) => e.kind).sort();
t("three traces written at once all survive", kinds.length === 3, kinds.join(",") || "(empty)");

t(
  "every entry is stamped, whatever the caller passed",
  (await trace.entries()).every((e) => typeof e.at === "string" && !Number.isNaN(Date.parse(e.at))),
  JSON.stringify((await trace.entries()).map((e) => e.at)),
);

/* The daemon is the destination, not the download folder. A browser extension
 * cannot write to a directory, and the one API that puts a file on disk
 * announces every file it writes - which for something recording while a film
 * plays is a popup every few seconds. The daemon is a program with a
 * filesystem. */
await trace.flush();
t(
  "a flush goes to the daemon and nothing is downloaded",
  posted.length === 1 && posted[0].entries.length === 3 && written.length === 0,
  `${posted.length} posted, ${written.length} downloaded`,
);
t(
  "and the buffer is emptied only once it is somewhere else",
  (await trace.entries()).length === 0,
  `${(await trace.entries()).length} left`,
);

/* With the daemon down it HOLDS. This is the whole answer to the popups: an
 * evening of viewing stays in the browser rather than announcing a file every
 * few seconds, and goes out in one piece when the daemon appears. */
await resetTrace();
daemonUp = false;
for (let i = 0; i < 80; i++) await trace.record("panel", { i });
t(
  "with no daemon it holds everything rather than downloading",
  written.length === 0 && (await trace.entries()).length === 80,
  `${written.length} downloaded, ${(await trace.entries()).length} held`,
);

daemonUp = true;
await trace.flush();
t(
  "and sends the lot the moment the daemon is there",
  posted.length === 1 && posted[0].entries.length === 80 && (await trace.entries()).length === 0,
  `${posted.length} batch(es), ${posted[0]?.entries.length} entries`,
);

/* ...but only to the daemon. A POST that succeeds is the whole check that the
 * daemon is there, so anything else holding the port is handed the log and the
 * browser's copy is dropped - the entries are gone and they went to a
 * stranger's process. The reply has to look like the daemon's. */
await resetTrace();
foreignOnPort = true;
for (let i = 0; i < 5; i++) await trace.record("panel", { i });
await trace.flush();
t(
  "a stranger on the daemon's port is not handed the log",
  posted.length === 0 && (await trace.entries()).length === 5,
  `${posted.length} batch(es) sent, ${(await trace.entries()).length} held`,
);
foreignOnPort = false;

/* Asked for by hand on the report page, with no daemon: that is the one time a
 * file is the right answer. */
await resetTrace();
daemonUp = false;
await trace.record("panel", { open: true });
const forced = await trace.flush({ force: true });
t(
  "asking for it by hand with no daemon downloads a file",
  forced.ok && written.length === 1 && String(written[0].filename).startsWith(`${trace.FOLDER}/`),
  `${written.length} file(s): ${written[0]?.filename}`,
);
/* Read defensively: when the case above fails there is no file to open, and a
 * suite that throws there reports nothing about any case after it. */
const readFile = (file) => {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(file.url.split(",")[1]))));
  } catch {
    return null;
  }
};
const wrote = written[0] ? readFile(written[0]) : null;
t(
  "and the file holds the entries, not a summary of them",
  wrote?.entries?.length === 1 && wrote.entries[0].kind === "panel",
  wrote ? JSON.stringify(wrote.entries.map((e) => e.kind)) : "no file was written",
);

/* Nothing may be dropped by a destination that refused it. Losing the entries
 * is the one outcome that leaves nothing at all to look at afterwards. */
await resetTrace();
daemonUp = false;
downloadsFail = true;
await trace.record("align", { slot: 0 });
const refused = await trace.flush({ force: true });
t(
  "a destination that refuses it keeps the entries rather than dropping them",
  refused.ok === false && (await trace.entries()).length === 1,
  `${(await trace.entries()).length} kept, reason ${refused.reason}`,
);
t(
  "and says so, so the report page can show it",
  Boolean((await trace.state()).lastError),
  String((await trace.state()).lastError),
);

/* The switch. Off means nothing is recorded at all - not recorded and
 * discarded, not recorded and held. */
await resetTrace();
store["sso:settings"] = { diagnostics: false };
await trace.record("panel", { open: true });
await trace.record("align", { slot: 0 });
t(
  "the switch stops it recording anything",
  (await trace.entries()).length === 0,
  `${(await trace.entries()).length} entries got through`,
);
store["sso:settings"] = { diagnostics: true };
await trace.record("panel", { open: true });
t(
  "and switching it back on starts it again",
  (await trace.entries()).length === 1,
  `${(await trace.entries()).length} entries`,
);
delete store["sso:settings"];
t(
  "an installation with no such setting keeps recording",
  await trace.enabled(),
  "defaulted off, which would lose the record on every existing install",
);

/* Cue times are stored as gaps to keep more of them; a pack that does not
 * reconstruct exactly is worse than no pack, because the file it produces
 * looks usable and is not. */
const times = [0, 1000, 1001, 45678, 45679, 3_600_000];
t(
  "packed cue times come back exactly",
  JSON.stringify(trace.unpackTimes(trace.packTimes(times))) === JSON.stringify(times),
  JSON.stringify(trace.unpackTimes(trace.packTimes(times))),
);
t(
  "and packing is smaller than not",
  JSON.stringify(trace.packTimes(times)).length < JSON.stringify(times).length,
  `${JSON.stringify(trace.packTimes(times)).length} against ${JSON.stringify(times).length}`,
);

/* --- what the page offered, not just how much of it -------------------------
 *
 * auto-attach refused on 2026-08-12 with `Nothing matched "The Americans Full
 * Episodes"`, and its recorded context said `candidateCount: 4,
 * episodeSource: null`. Four candidates and no way to tell whether the page
 * named the episode somewhere the picker missed or never said it at all -
 * which are different bugs with the same log line.
 */
{
  const { pageContextForTab } = await import("../src/daemon.js");
  frameList = [{ frameId: 0 }, { frameId: 2 }];
  pageInfoReply = (message, options) => {
    const frameId = options?.frameId ?? 0;
    if (frameId === 0) {
      return {
        ok: true,
        year: null,
        candidates: [
          { source: "og:title", text: "Watch The Americans Full Episodes", episode: null },
          { source: "h1", text: "The Americans", episode: null },
        ],
        episode: null,
      };
    }
    return {
      ok: true,
      year: null,
      candidates: [{ source: "frame title", text: "The Americans S01E05", episode: { season: 1, episode: 5 } }],
      episode: { fromTitle: { season: 1, episode: 5 } },
    };
  };

  const context = await pageContextForTab({ id: 1, title: "tab" }, 2);
  t(
    "the page context says which episode, from the frame that knew",
    context.season === 1 && context.episode === 5,
    JSON.stringify({ season: context.season, episode: context.episode, source: context.episodeSource }),
  );
  t(
    "and it records what every frame offered, not only how many",
    Array.isArray(context.candidates) &&
      context.candidates.length === 3 &&
      context.candidates.some((c) => c.text.includes("Full Episodes") && c.frameId === 0) &&
      context.candidates.some((c) => c.text.includes("S01E05") && c.frameId === 2),
    JSON.stringify(context.candidates),
  );

  frameList = [{ frameId: 0 }];
  pageInfoReply = () => ({ ok: true });
}

/* An episode page names two things, and only one of them can be searched.
 *
 * Reported on a local catalogue app: the page is "Baggage", season 3 episode 2
 * of The Americans, and every visible title on it says "Baggage" - so that is
 * what went to OpenSubtitles, which indexes episodes under the series with the
 * numbers beside it. The page stated all three in schema.org and nothing read
 * two of them.
 */
{
  const { pageContextForTab } = await import("../src/daemon.js");
  frameList = [{ frameId: 0 }];
  pageInfoReply = () => ({
    ok: true,
    year: 2015,
    candidates: [
      { source: "json-ld", text: "Baggage", episode: null },
      { source: "json-ld-series", text: "The Americans", episode: null },
      { source: "h1", text: "Baggage", episode: null },
      { source: "document.title", text: "Baggage (2015) - Catalogue", episode: null },
    ],
    episode: { fromMetadata: { season: 3, episode: 2, matched: "schema.org episodeNumber" } },
  });

  const context = await pageContextForTab({ id: 1, title: "Baggage (2015) - Catalogue" }, 0);
  t(
    "an episode page is searched by its series, not by the episode's own name",
    context.title === "The Americans",
    JSON.stringify({ title: context.title, source: context.titleSource }),
  );
  t(
    "and the season and episode come from the metadata that stated them",
    context.season === 3 && context.episode === 2,
    JSON.stringify({ season: context.season, episode: context.episode, source: context.episodeSource }),
  );

  pageInfoReply = () => ({ ok: true });
}

/* A page that announces what it is playing is not guessed at.
 *
 * The ranking above exists because a page states several names and labels none
 * of them. `data-sso-now-playing` labels them, so there is nothing left to
 * rank - and it carries an IMDb id, which is what turns the search from a
 * /features round trip plus a fuzzy match into one exact call.
 */
{
  const { pageContextForTab } = await import("../src/daemon.js");
  const announcement = {
    kind: "episode",
    title: "The Americans",
    year: 2013,
    season: 3,
    episode: 9,
    imdb: "tt4331672",
    durationSeconds: 2701.44,
  };

  frameList = [{ frameId: 0 }, { frameId: 2 }];
  pageInfoReply = (message, options) => {
    const frameId = options?.frameId ?? 0;
    if (frameId === 0) {
      // The page around the player, saying the wrong thing as loudly as it can.
      return {
        ok: true,
        year: 1999,
        announced: null,
        candidates: [{ source: "json-ld", text: "Do Mail Robots Dream", episode: null }],
        episode: { fromTitle: { season: 9, episode: 9 } },
      };
    }
    return {
      ok: true,
      year: 1999,
      announced: announcement,
      candidates: [{ source: "document.title", text: "Catalogue", episode: null }],
      episode: null,
    };
  };

  const context = await pageContextForTab({ id: 1, title: "Catalogue" }, 2);
  t(
    "an announced programme is used as stated, not ranked against the page",
    context.title === "The Americans" && context.year === 2013,
    JSON.stringify({ title: context.title, year: context.year, source: context.titleSource }),
  );
  t(
    "and its season and episode outrank a number scraped from a title",
    context.season === 3 && context.episode === 9,
    JSON.stringify({ season: context.season, episode: context.episode }),
  );
  t(
    "and its IMDb id reaches the search, which is what makes it exact",
    context.imdbId === "tt4331672",
    JSON.stringify({ imdbId: context.imdbId }),
  );
  t(
    "and what the page said is still recorded, so a wrong announcement is visible",
    context.candidates.some((candidate) => candidate.text.includes("Do Mail Robots")),
    JSON.stringify(context.candidates),
  );

  /* Two frames announcing is a player embedded in a page that also knows what
   * it is showing. The player's frame is describing what was actually loaded. */
  pageInfoReply = (message, options) => ({
    ok: true,
    year: null,
    announced:
      (options?.frameId ?? 0) === 2 ? announcement : { ...announcement, title: "The page's idea" },
    candidates: [],
    episode: null,
  });
  const both = await pageContextForTab({ id: 1, title: "Catalogue" }, 2);
  t(
    "where two frames announce, the one holding the video wins",
    both.title === "The Americans",
    JSON.stringify({ title: both.title }),
  );

  /* A page with no announcement is served exactly as it was before there was
   * one to make. */
  pageInfoReply = () => ({
    ok: true,
    year: 2015,
    candidates: [{ source: "json-ld-series", text: "The Americans", episode: null }],
    episode: { fromMetadata: { season: 3, episode: 2, matched: "schema.org episodeNumber" } },
  });
  const guessed = await pageContextForTab({ id: 1, title: "Baggage" }, 0);
  t(
    "and a page that announces nothing is still guessed at, with no id to send",
    guessed.title === "The Americans" && guessed.season === 3 && guessed.imdbId === null,
    JSON.stringify({ title: guessed.title, season: guessed.season, imdbId: guessed.imdbId }),
  );

  frameList = [{ frameId: 0 }];
  pageInfoReply = () => ({ ok: true });
}

/* A failure inside the worker is invisible from the page and from the report,
 * and it is exactly what makes a control do nothing. */
await resetTrace();
for (const fn of listeners.global.unhandledrejection || []) {
  fn({ reason: new Error("something in the worker gave up") });
}
await new Promise((r) => setTimeout(r, 30));
const errors = (await trace.entries()).filter((e) => e.kind === "error");
t(
  "a rejection nobody caught in the worker is written down",
  errors.length === 1 && errors[0].message.includes("gave up") && errors[0].where === "worker",
  JSON.stringify(errors.map((e) => e.message)),
);

await resetTrace();
t("clearing empties it", (await trace.entries()).length === 0);

chrome.storage.local.get = instant.get;
chrome.storage.local.set = instant.set;

/* --- what a word costs when there is no daemon --------------------------------
 *
 * Study mode's meanings come from the daemon when it is there, which can gloss a
 * word in the line it was said in. When it is not, this path asks a free archive
 * that never sees the line and allows about six hundred words a day.
 *
 * So the line must not be part of what an answer is filed under here. Filed by
 * line, the same word would be asked about again for every new sentence it
 * turned up in - identical answers, one film spending a day's allowance.
 */
{
  const askedFor = [];
  daemonUp = false;
  daemonAnswers = (url) => {
    if (!url.includes("mymemory")) return null;
    askedFor.push(url);
    return { matches: [{ translation: "parça", match: 1, quality: "90" }] };
  };

  /* The probe is cached for a while, so "the daemon just stopped" is a state
   * this path really passes through - and in it the key still carries the line
   * and the archive is asked twice. Forced here so the case is about the
   * settled behaviour rather than about the probe's timing. */
  await (await import("../src/provider.js")).daemonUp({ force: true });

  const { lookup } = await import("../src/study/lookup.js");
  const first = await lookup({
    query: "spare", language: "en", target: "tr", sentence: "Can you spare a minute?",
  });
  const second = await lookup({
    query: "spare", language: "en", target: "tr", sentence: "We are down to one spare engine.",
  });
  t(
    "with no daemon a word is asked about once, whatever line it turned up in",
    askedFor.length === 1 && first.translation === "parça" && second.translation === "parça",
    `asked ${askedFor.length} time(s), answers ${JSON.stringify([first.translation, second.translation])}`,
  );
  daemonAnswers = null;
  daemonUp = true;
}

/* --- the next episode, warmed before anybody asks for it ---------------------
 *
 * The page says what follows what it is playing. A search costs nothing and is
 * not metered, so it goes out on the announcement; a download is metered at
 * five a day anonymously, so it waits for two separate gates. The content
 * script holds one of them (the middle of the current film, which is where the
 * next episode stops being a guess) and arrives here as `committed`. This is
 * the other: the day's allowance has to have more than a pair spare, and until
 * something has actually been downloaded there is no allowance to read.
 */
{
  const askedFor = [];
  const forNext = (remaining) => (url) => {
    const at = String(url);
    askedFor.push(at);
    if (at.endsWith("/health")) return { default_languages: ["en"] };
    if (at.includes("/search")) {
      return {
        used: { query: "The Americans", season: 5, episode: 12, languages: ["en"] },
        auto_attach_threshold: 0.75,
        resolved: { title: "the americans", year: 2013, imdb_id: "5610032", type: "Tvshow" },
        results: [{
          file_id: 512, language: "en", season: 5, episode: 12, identified: true, cached: false,
          movie_name: "The Americans", release: "The.Americans.2013.S05E12.HDTV.x264-SVA",
          download_count: 900, from_trusted: true, match_score: 0.95, year: 2013,
        }],
      };
    }
    if (at.endsWith("/fetch")) {
      return { cues: [{ start: 0, end: 1000, text: "hello" }], remaining_quota: remaining };
    }
    return null;
  };
  const upNext = (episode) => ({
    kind: "episode", title: "The Americans", year: 2013, season: 5, episode, imdb: `tt56100${episode}`,
  });
  const searches = () => askedFor.filter((url) => url.includes("/search")).length;
  const downloads = () => askedFor.filter((url) => url.endsWith("/fetch")).length;

  daemonAnswers = forNext(9);
  /* The probe is cached, and the block above this one deliberately leaves it
   * saying "down" - which sends every search to the extension's own path, where
   * node has no IndexedDB. A real browser has one; this is the stale-probe
   * window made deterministic. */
  await (await import("../src/provider.js")).daemonUp({ force: true });

  askedFor.length = 0;
  await ask({ type: "sso:warmNext", next: upNext(12), committed: false }, sender);
  t(
    "the next episode is searched for as soon as the page names it",
    searches() === 1 && downloads() === 0,
    `${searches()} search(es), ${downloads()} download(s)`,
  );

  askedFor.length = 0;
  await ask({ type: "sso:warmNext", next: upNext(12), committed: true }, sender);
  t(
    "and is not downloaded before anything has said what the day's allowance is",
    downloads() === 0,
    `${downloads()} download(s) with no allowance known`,
  );

  /* A real attach is the only way this ever learns what is left: the number
   * comes back on a download and nowhere else. */
  const spending = (remaining) => (url) => {
    const answer = americans()(url);
    return String(url).endsWith("/fetch") ? { ...answer, remaining_quota: remaining } : answer;
  };
  await attempt("2901|E13 allowance", spending(9));
  daemonAnswers = forNext(9);
  askedFor.length = 0;
  await ask({ type: "sso:warmNext", next: upNext(13), committed: true }, sender);
  t(
    "and is downloaded once the film is half over and the allowance can spare it",
    downloads() === 1,
    `${downloads()} download(s) with nine left`,
  );

  await attempt("2902|E13 nearly gone", spending(1));
  daemonAnswers = forNext(1);
  askedFor.length = 0;
  await ask({ type: "sso:warmNext", next: upNext(14), committed: true }, sender);
  t(
    "and is left alone when the day's last downloads belong to what is playing",
    downloads() === 0,
    `${downloads()} download(s) with one left`,
  );

  askedFor.length = 0;
  await ask({ type: "sso:warmNext", next: upNext(14), committed: true }, sender);
  t(
    "and the same ask twice does not search twice",
    searches() === 0,
    `${searches()} search(es) on the repeat`,
  );

  daemonAnswers = null;
}

for (const r of results) console.log(r.ok ? "PASS" : "FAIL", "-", r.name, r.ok ? "" : `→ ${r.detail}`);

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
