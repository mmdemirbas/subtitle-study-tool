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
// The toolbar icon and the alarms, as the worker last left them.
const badge = { text: "", title: "", tabs: new Map() };
const shownOn = (tabId) => (badge.tabs.has(tabId) ? badge.tabs.get(tabId) : badge.text);
const alarmsSet = new Map();
// Every POST the log tried, landed or not: a refused one costs the worker a read
// and a stringify all the same.
let logAttempts = 0;
// The daemon's port answering with an error status, and every error body let go.
let logRefused = 0;
let released = 0;
const refusal = (status) => ({ ok: false, status, body: { cancel: async () => { released += 1; } } });
/* What the subtitle daemon answers, for the cases that need a search to come
 * back with something. null is "nothing is listening", which is what every
 * other case here wants and what the fetch below produces by rejecting. */
let daemonAnswers = null;

/* The daemon is a socket, so it is stubbed as one. The extension does not
 * health-check it: the POST is the check, and "not running" arrives as a fetch
 * that rejects - which is exactly what this does. */
globalThis.fetch = async (url, options) => {
  if (String(url).includes("/log")) {
    logAttempts += 1;
    if (!daemonUp) throw new TypeError("Failed to fetch");
    if (logRefused) return refusal(logRefused);
    /* Something that is not the daemon, holding 8791 - the same case the
     * health probe has to handle. It answers, so the POST succeeds and the log
     * would be dropped from the browser having gone to a stranger. */
    if (foreignOnPort) return { ok: true, status: 200, json: async () => ({}) };
    posted.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, file: "logs/today.jsonl" }) };
  }
  if (daemonAnswers) {
    const answer = daemonAnswers(String(url), options?.method || "GET");
    if (answer) return { ok: true, status: 200, json: async () => answer };
  }
  if (Object.hasOwn(pageFiles, String(url))) {
    const body = pageFiles[String(url)];
    if (typeof body === "number") return refusal(body);
    return {
      ok: true, status: 200,
      text: async () => (typeof body === "string" ? body : new TextDecoder().decode(body)),
      arrayBuffer: async () => (typeof body === "string" ? new TextEncoder().encode(body).buffer : body.buffer),
    };
  }
  /* A packaged file, served off disk. rarity.js and phrases.js fetch their
   * tables through chrome.runtime.getURL rather than importing them, because a
   * service worker may not use dynamic import - so the shipped tables are only
   * reachable from a test through this. Reading the real ones is the point: a
   * stub table would test the lookup and never the data. */
  const packaged = String(url).replace("chrome-extension://test/", "");
  if (packaged !== String(url)) {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = fileURLToPath(new URL(`../${packaged}`, import.meta.url));
    const text = await readFile(path, "utf-8").catch(() => null);
    if (text === null) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => text };
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
// Where the one tab is. The page-world ear goes in only on the hosts it is for.
let tabUrl = "https://example.tv/watch/1";
const store = {};
const sentToTab = [];
// Every scripting call the worker made, so a test can assert the injection
// happened rather than only that nothing threw.
const injected = [];
let tabStatusReply = { ok: true, hasVideo: true, attached: false };
// What each frame says about the page. Replaced by the pageContext cases.
let pageInfoReply = () => ({ ok: true });
// What the page's own player was handed, with the URLs. Null is every page
// that is not a streaming site with a hook, which is nearly all of them.
let pageSubtitlesReply = () => null;
// The page's own subtitle files, by URL, as the CDN would serve them.
let pageFiles = {};
// Whether the tab has a content script that answers. False is a tab left open
// across an extension update, which is the case the self-heal exists for.
let pingAlive = false;
// A tab whose panel cannot be reached, which is when the worker flags the icon.
let panelRefused = false;

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
      content_scripts: [
        { js: ["src/align.js", "src/content.js"], matches: ["<all_urls>"] },
        // The page-world ear, as the real manifest declares it.
        { js: ["src/sites/primevideo.js"], matches: ["https://*.primevideo.com/*"], run_at: "document_start", world: "MAIN" },
      ],
    }),
    getURL: (p) => `chrome-extension://test/${p}`,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
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
      /* A key or a list of them, as Chrome takes. It took one key only, so
       * trace.clear()'s list removed nothing, and the log's cases started
       * empty only because the flush before each clear had already sent it. */
      async remove(key) { for (const k of [key].flat()) delete store[k]; },
    },
  },
  tabs: {
    onRemoved: { addListener: (fn) => listeners.removed.push(fn) },
    async query() { return [{ id: 1, url: tabUrl }]; },
    async get(id) { return { id, url: tabUrl }; },
    async create() { return {}; },
    async sendMessage(tabId, message) {
      sentToTab.push({ tabId, type: message.type, message });
      if (message.type === "sso:status") return { ...tabStatusReply };
      // Two frames describing the same page differently, which is the shape
      // pageContextForTab exists to reconcile. Set per case.
      if (message.type === "sso:pageInfo") return pageInfoReply(message, arguments[2]);
      if (message.type === "sso:pageSubtitles") return pageSubtitlesReply(message, arguments[2]);
      if (message.type === "sso:ping") {
        // What Chrome does when nothing is listening in the tab.
        if (!pingAlive) throw new Error("Could not establish connection.");
        return { ok: true, version: chrome.runtime.getManifest().version };
      }
      if (message.type === "sso:togglePanel" && panelRefused) return { ok: false };
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
  /* The badge as Chrome keeps it: one global text, and per-tab texts that
   * outrank it. A tab's "" is a text like any other and hides the global one;
   * only null hands the tab back. A stub that let "" fall through would pass
   * the flag's reset that hid the daemon's badge on every flagged tab.
   * https://developer.chrome.com/docs/extensions/reference/api/action#method-setBadgeText */
  action: {
    async setBadgeText({ tabId, text }) {
      if (tabId === undefined) badge.text = text;
      else if (text === null) badge.tabs.delete(tabId);
      else badge.tabs.set(tabId, text);
    },
    async setBadgeBackgroundColor() {},
    async setTitle({ title }) { badge.title = title; },
  },
  alarms: {
    async create(name, info) { alarmsSet.set(name, info); },
    async clear(name) { return alarmsSet.delete(name); },
    onAlarm: { addListener: (fn) => { listeners.alarm = fn; } },
  },
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

/* Poll for a condition instead of sleeping for a guess.
 *
 * What these cases wait on is a promise chain inside the worker, and how long
 * it takes is a fact about the machine. "a rejection nobody caught in the
 * worker is written down" waited a fixed 30ms, lost that bet while the machine
 * was busy, and reported an empty list for code that was working. Returns
 * either way, so the case still reports what it actually saw. */
const until = async (ready, ms = 2000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await ready()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
};

/* First, before any case below makes the daemon answer: an installation that
 * has never seen it is not told it is missing. The daemon is optional, and a
 * red mark on the icon of every reader who never started one is a warning
 * nobody can act on. */
{
  /* Through the log's POST, not the provider's probe: the probe caches its
   * answer for five seconds, and a "no" cached here sends the search cases
   * below down the path that does the work without the daemon. */
  const log = await import("../src/trace.js");
  daemonUp = false;
  await log.record("panel", { open: true });
  await log.flush();
  t("a daemon this installation has never seen is not a mark on the icon",
    badge.text === "" && alarmsSet.size === 0 && store["sso:daemonPresence"]?.seen === false,
    `badge "${badge.text}", ${alarmsSet.size} alarms, ${JSON.stringify(store["sso:daemonPresence"])}`);
  daemonUp = true;
  await log.flush();
  posted.length = 0;
}

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
/* A search that can succeed, or the plan fails on the daemon's silence and
 * the run ends in "Something went wrong" before it ever waits for the film -
 * which is what this case did for a while, passing on the toast it was
 * asked about while exercising none of the wait. */
daemonAnswers = americans();
const startedLate = Date.now();
const late = ask({ type: "sso:programme", mark: "2400|Ep 6" }, sender);
// The film turns up a moment later, the way a remuxed stream does.
const arrived = new Promise((resolve) => setTimeout(() => {
  tabStatusReply = { ok: true, hasVideo: true, videoComing: true, attached: false };
  resolve();
}, 400));
await late;
await arrived;
daemonAnswers = null;
t("a film that starts a moment late is still searched for",
  toasts().some((m) => /Looking for subtitles/.test(m)),
  JSON.stringify(toasts()));
t("and it is not refused for having had no video when the page said so",
  !toasts().some((m) => /No video playing/.test(m)),
  JSON.stringify(toasts()));
t("and the attach waited for it",
  Date.now() - startedLate >= 400 && sentToTab.some((m) => m.type === "sso:attach"),
  `${Date.now() - startedLate}ms ${sentToTab.map((m) => m.type).join(",")}`);

// 5c. ...and a page with no film coming is still refused at once, rather than
//     after a silent wait for something that is not on its way. Refused
//     QUIETLY: nobody pressed anything, so "No video playing on this page" is
//     an answer to nothing. Read out of the log, 2026-09-13: six of them in
//     ten minutes of browsing Prime Video's storefront, each for a trailer
//     that had ended by the time its plan was made.
sentToTab.length = 0;
tabStatusReply = { ok: true, hasVideo: false, videoComing: false, attached: false };
const startedAt = Date.now();
await ask({ type: "sso:programme", mark: "2400|Ep 7" }, sender);
const waited = Date.now() - startedAt;
t("a page with no film is refused without waiting for one",
  !toasts().some((m) => /Looking for subtitles/.test(m)) && waited < 2000,
  `${waited}ms: ${JSON.stringify(toasts())}`);
t("and an automatic run says nothing about it to the reader",
  !toasts().some((m) => /No video playing/.test(m)),
  JSON.stringify(toasts()));
{
  const log = await import("../src/trace.js");
  const skipped = async () => (await log.entries()).filter((e) => e.kind === "autoAttach" && e.skipped === "no video").pop();
  await until(async () => Boolean(await skipped()));
  t("but the log does", Boolean(await skipped()), JSON.stringify(await skipped()));
}
// 5d. The shortcut is a question, and gets the answer.
sentToTab.length = 0;
await ask({ type: "sso:command", command: "auto-attach" }, sender);
t("the shortcut on a page with no film is still told so",
  toasts().some((m) => /No video playing/.test(m)),
  JSON.stringify(toasts()));
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

t(
  "and no page-world ear goes into a tab on a host that has none",
  !injected.some((call) => call.world === "MAIN"),
  JSON.stringify(injected),
);

// The same stale tab on Prime Video gets the ear as well, in the page's world.
injected.length = 0;
tabUrl = "https://www.primevideo.com/detail/0F73UBN1X5HC63POQZSJBLWXCP";
await listeners.command("toggle-panel");
t(
  "a stale Prime Video tab gets the ear too, in the page's world",
  injected.some((call) => call.world === "MAIN" && call.files?.[0] === "src/sites/primevideo.js" && call.target?.allFrames !== true),
  JSON.stringify(injected),
);
tabUrl = "https://example.tv/watch/1";

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

/* A storage read that failed is not an empty deck.
 *
 * Both writers are read-modify-write, and `all()` answered a failed read with
 * [] - so one unlucky read turned the next save into "the deck is this one new
 * word". Measured with a deck of one entry and a single rejecting read: save()
 * returned added:true and the stored deck came back holding only the new word,
 * with nothing thrown and nothing logged. The writers read strictly now and the
 * failure reaches the caller. */
await deck.clear();
await deck.save({ term: "warrant", language: "en", fileId: 1 });
const readableAgain = chrome.storage.local.get;
let saveRefused = false;
chrome.storage.local.get = async () => { throw new Error("storage is unavailable"); };
try {
  await deck.save({ term: "new", language: "en", fileId: 2 });
} catch {
  saveRefused = true;
}
chrome.storage.local.get = readableAgain;
const survived = (await deck.all()).map((entry) => entry.term);
t(
  "a deck that could not be read is not overwritten with one word",
  saveRefused && survived.length === 1 && survived[0] === "warrant",
  `refused=${saveRefused} deck=${survived.join(",") || "(empty)"}`,
);

/* One word, two films, one millisecond: two ids, not one.
 *
 * The id was the clock in base 36 plus the word, so the same word saved against
 * two films inside a millisecond took the same id - and remove() deletes by id.
 * Measured before: both saves returned "mtpd832h-warrant" and removing one
 * reported removed:2, so deleting one card took the other with it. */
await deck.clear();
const [first, second] = await Promise.all([
  deck.save({ term: "warrant", language: "en", fileId: 10, title: "one" }),
  deck.save({ term: "warrant", language: "en", fileId: 11, title: "two" }),
]);
const gone = await deck.remove(first.entry.id);
t(
  "the same word saved against two films keeps two ids",
  first.entry.id !== second.entry.id && gone.removed === 1 && gone.size === 1,
  `ids ${first.entry.id === second.entry.id ? "collide" : "differ"}, removed ${gone.removed}, left ${gone.size}`,
);

/* An export a reader can import back.
 *
 * Tabs and newlines were flattened and quotes were left alone, on the grounds
 * that a tab-separated file has nothing to quote. Anki reads it with Python's
 * csv module, which honours quotes whatever the delimiter is. Measured on four
 * entries, one holding a line of dialogue in quotation marks: the file parsed
 * as three rows instead of five, and an unbalanced quote - ordinary when speech
 * runs across two cues - swallowed its own row and the two after it. An entry
 * with no definitions array threw out of the export entirely. */
const exported = deck.serialise([
  { term: "one", language: "en", definitions: [], sentence: '"Get out," he said.', savedAt: "x" },
  { term: "two", language: "en", definitions: [], sentence: '"I told you', savedAt: "x" },
  { term: "three", language: "en", definitions: [], sentence: "plain", savedAt: "x" },
  { term: "four", language: "en", savedAt: "x" },
]);
/* Read back the way the importer reads it: a quoted field runs to its closing
 * quote, and a doubled quote inside one is a quote. */
const parseTsv = (text) => {
  const rows = [[""]];
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const ch = text[at];
    const row = rows[rows.length - 1];
    if (quoted) {
      if (ch === '"' && text[at + 1] === '"') { row[row.length - 1] += '"'; at += 1; }
      else if (ch === '"') quoted = false;
      else row[row.length - 1] += ch;
    } else if (ch === '"' && row[row.length - 1] === "") quoted = true;
    else if (ch === "\t") row.push("");
    else if (ch === "\n") rows.push([""]);
    else row[row.length - 1] += ch;
  }
  return rows;
};
const back = parseTsv(exported);
t(
  "a quote in a subtitle line does not eat the rows after it",
  back.length === 5 && back[1][6] === '"Get out," he said.' && back[4][0] === "four",
  `${back.length} rows, first sentence ${JSON.stringify(back[1]?.[6])}, last term ${JSON.stringify(back[4]?.[0])}`,
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

/* What one more line costs, however much is already held.
 *
 * Found on 2026-09-26 with the daemon down for ten days: 3,151 entries, 4.8MB,
 * and every new line read the whole array, added itself and wrote the whole
 * array back - then, being past sixty, started a flush that read it again and
 * stringified it for a POST that could not land. Brave's storage log showed a
 * fresh 1.1MB table every 3 to 13 seconds while a video played. The log is
 * seeded here the way it was held then, one array under one key, which is also
 * how every installation from before the change has it. */
await resetTrace();
const seeded = Array.from({ length: 3000 }, (_, i) => ({
  at: new Date(Date.UTC(2026, 8, 16, 14, 0, 0) + i).toISOString(), kind: "survey", i, pad: "x".repeat(600),
}));
store["sso:trace"] = seeded;
daemonUp = false;
await trace.flush();
await trace.record("perf", { first: true });
{
  const { get, set } = chrome.storage.local;
  let wrote = 0;
  let read = 0;
  chrome.storage.local.set = async (obj) => { wrote += JSON.stringify(obj).length; return set(obj); };
  chrome.storage.local.get = async (key) => { const got = await get(key); read += JSON.stringify(got).length; return got; };
  await trace.record("perf", { second: true });
  chrome.storage.local.set = set;
  chrome.storage.local.get = get;
  // One piece of the log is the most a line may touch: 256KB, against 2MB held.
  t("one more line does not read or rewrite what is already held",
    wrote < 300 * 1024 && read < 300 * 1024,
    `${wrote} bytes written and ${read} read for one line, with ${JSON.stringify(seeded).length} held`);
}

/* A daemon that refused the last POST is not asked again on the next line.
 * Past sixty held entries every record started a flush, so a film watched with
 * the daemon down knocked on a closed port once per line, reading the whole log
 * each time to do it. */
logAttempts = 0;
for (let i = 0; i < 30; i++) await trace.record("perf", { i });
t("with the daemon gone, thirty lines knock on its door at most once",
  logAttempts <= 1, `${logAttempts} POSTs attempted`);

/* And when it is back, what it missed goes in pieces, oldest first. One POST
 * of everything was a body the size of the absence, and the daemon refuses a
 * log body over 64MB while the browser holds up to 400MB - past that line the
 * log could never have reached it. */
daemonUp = true;
posted.length = 0;
const caughtUp = await trace.flush();
const delivered = posted.flatMap((p) => p.entries);
t("the old array and the new lines all reach the daemon, in order",
  caughtUp.ok && delivered.length === 3032 && delivered[0].i === 0 && delivered[2999].i === 2999 &&
    delivered[3000].first && delivered[3001].second && delivered[3031].i === 29,
  `${delivered.length} delivered: ${JSON.stringify(delivered.slice(2999, 3003).map((e) => e.i ?? e.kind))}`);
t("in POSTs of a bounded size, not one the size of the absence",
  posted.length > 1 && posted.every((p) => JSON.stringify(p).length < 300 * 1024),
  `${posted.length} POSTs, largest ${Math.max(...posted.map((p) => JSON.stringify(p).length))} bytes`);
t("and nothing is left behind, the old key included",
  (await trace.entries()).length === 0 && !("sso:trace" in store),
  `${(await trace.entries()).length} held, old key ${"sso:trace" in store ? "still there" : "gone"}`);

/* --- whether the daemon is there, on the icon --------------------------------
 *
 * The daemon stopped on 2026-09-16 and nothing said so for ten days; the log
 * piled up in the browser meanwhile. Asked for as "a badge ... on the
 * subtitle extension icon when daemon is connected vs not connected". */
{
  const { daemonUp: probeDaemon } = await import("../src/provider.js");
  const daemonIsUp = (url) => (url.includes("/health") ? { default_languages: ["en"] } : null);
  daemonAnswers = daemonIsUp;
  await probeDaemon({ force: true });
  t("once it has answered, the icon says connected and carries no badge",
    badge.text === "" && /daemon connected/.test(badge.title) && !alarmsSet.has("sso:daemonCheck"),
    `badge "${badge.text}", title "${badge.title}"`);

  daemonAnswers = null;
  await probeDaemon({ force: true });
  t("when it stops answering the icon carries a badge, and the tooltip says what to start",
    badge.text === "!" && /not running.*run\.sh/.test(badge.title),
    `badge "${badge.text}", title "${badge.title}"`);
  t("and it is looked for again every minute while it is gone",
    alarmsSet.get("sso:daemonCheck")?.periodInMinutes === 1, JSON.stringify([...alarmsSet]));
  t("the popup and the panel can read the same answer",
    store["sso:daemonPresence"]?.up === false && store["sso:daemonPresence"]?.seen === true,
    JSON.stringify(store["sso:daemonPresence"]));

  daemonAnswers = daemonIsUp;
  listeners.alarm?.({ name: "sso:daemonCheck" });
  await until(() => badge.text === "");
  t("started again, the next minute's look takes the badge off and stops looking",
    badge.text === "" && !alarmsSet.has("sso:daemonCheck"), `badge "${badge.text}", ${alarmsSet.size} alarms`);

  /* The log's POST is enough on its own. What ran for ten days was pages that
   * carry their own subtitles, where nothing searches and the probe is never
   * asked - only the log was knocking. */
  daemonAnswers = null;
  await resetTrace();
  daemonUp = false;
  await trace.record("perf", { i: 0 });
  await trace.flush();
  t("a log POST that finds nobody puts the badge up without any search",
    badge.text === "!", `badge "${badge.text}"`);
  daemonUp = true;
  await trace.flush();
  t("and one that lands takes it off", badge.text === "", `badge "${badge.text}"`);

  /* A tab the worker flagged goes back to the icon's own badge. The flag's
   * reset wrote "", which Chrome keeps as that tab's text over the global one,
   * so a tab flagged once showed no daemon badge until it was closed. */
  daemonAnswers = null;
  await probeDaemon({ force: true });
  panelRefused = true;
  pingAlive = true;
  await listeners.command("toggle-panel");
  const flagged = shownOn(1);
  await new Promise((r) => setTimeout(r, 4200));
  t("a tab flagged for a moment shows the daemon's badge again afterwards",
    flagged === "!" && shownOn(1) === "!", `during "${flagged}", after "${shownOn(1)}"`);
  panelRefused = false;
  pingAlive = false;
  daemonAnswers = daemonIsUp;
  await probeDaemon({ force: true });
  daemonAnswers = null;
}

/* An answer with an error status is let go, not left open.
 *
 * A body nobody reads keeps its request open until the Response is collected,
 * and a host's connections are few: a playlist of subtitle segments with a few
 * refused ones could hold up the rest. Found in the log's POST, then at every
 * path that decides from the status alone. */
{
  released = 0;
  await resetTrace();
  logRefused = 500;
  await trace.record("perf", { i: 0 });
  const refused = await trace.flush();
  logRefused = 0;
  t("a log POST the daemon refuses is let go, and the entries are kept",
    released === 1 && refused.held === 1, `${released} released, ${JSON.stringify(refused)}`);

  const { readPageTrack } = await import("../src/subtitles/page.js");
  released = 0;
  pageFiles["https://cdn.example/refused.vtt"] = 403;
  const failed = await readPageTrack({ url: "https://cdn.example/refused.vtt", format: "vtt" }).catch((error) => error);
  delete pageFiles["https://cdn.example/refused.vtt"];
  t("a page's subtitle the CDN refuses is let go, and says why",
    released === 1 && /403/.test(String(failed?.message)), `${released} released, ${failed?.message}`);
}

/* Lining two subtitles up is the worker's job now, not the page's.
 *
 * Attaching a second subtitle ran align.js on the page's thread: 76-117ms of
 * one task on a film-length pair (tools/measure-attach.mjs, 2026-09-26). The
 * worker has to give the same answer the page would have, and nothing but
 * the two operations, on nothing but numbers. */
{
  let at = 0;
  const reference = Array.from({ length: 400 }, (_, i) => (at += 1500 + ((i * 7919) % 2300)));
  const target = reference.filter((_, i) => i % 4 !== 3).map((ms) => ms + 2500);
  const answer = await ask({ type: "sso:align", op: "alignSteps", a: reference, b: target }, sender);
  const direct = globalThis.__ssoAlign?.alignSteps(reference, target);
  t("the worker lines two subtitles up, with the answer align.js gives",
    answer?.ok === true && answer.shiftMs === 2500 && JSON.stringify(answer) === JSON.stringify(direct),
    `shift ${answer?.shiftMs}, same as direct: ${JSON.stringify(answer) === JSON.stringify(direct)}`);
  const refused = [
    await ask({ type: "sso:align", op: "snapNear", a: reference, b: target }, sender),
    await ask({ type: "sso:align", op: "align", a: ["1"], b: target }, sender),
  ];
  t("and answers nothing else it is asked", refused.every((r) => r === null), JSON.stringify(refused));
}

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

/* A player that says which episode it is playing, on a page that does not.
 *
 * Prime Video, watching Monk: the film plays in place on the series page, so
 * the address and the tab title never change, and while the video was live the
 * page offered h1 "Monk" and title "Prime Video: Monk" and nothing else. Every
 * episode source was null across four snapshots and the viewer picked S01E01,
 * S01E02 and S01E03 by hand. The player's own overlay is the one string on the
 * page that names what is on screen.
 */
{
  const { pageContextForTab } = await import("../src/daemon.js");
  frameList = [{ frameId: 0 }];
  pageInfoReply = () => ({
    ok: true,
    candidates: [
      { source: "h1", text: "Monk", episode: null },
      { source: "document.title", text: "Prime Video: Monk", episode: null },
    ],
    episode: {
      fromMetadata: null,
      fromPlayer: { season: 1, episode: 7, matched: "S1 E7", text: "S1 E7 Mr. Monk and the Billionaire Mugger" },
      fromTitle: null,
      fromMarker: null,
      fromUrl: null,
    },
  });

  const context = await pageContextForTab({ id: 1, title: "Prime Video: Monk" }, 0);
  t(
    "the episode written inside the player is the episode",
    context.season === 1 && context.episode === 7,
    JSON.stringify({ season: context.season, episode: context.episode, source: context.episodeSource }),
  );
  t(
    "and the source says so",
    context.episodeSource === "the player's own overlay",
    context.episodeSource,
  );

  /* ...but only from the frame that holds the video. An overlay in another
   * frame is describing another player. */
  frameList = [{ frameId: 0 }, { frameId: 7 }];
  pageInfoReply = (message, options) =>
    (options?.frameId ?? 0) === 7
      ? { ok: true, candidates: [], episode: { fromPlayer: { season: 4, episode: 4, matched: "S4 E4" } } }
      : {
          ok: true,
          candidates: [{ source: "document.title", text: "Prime Video: Monk", episode: null }],
          episode: { fromMetadata: { season: 1, episode: 2, matched: "schema.org episodeNumber" } },
        };
  // The video is in frame 0; frame 7 is some other embed with its own overlay.
  const elsewhere = await pageContextForTab({ id: 1, title: "Prime Video: Monk" }, 0);
  t(
    "an overlay in a frame that is not the player's is not believed over the page",
    elsewhere.season === 1 && elsewhere.episode === 2,
    JSON.stringify({ season: elsewhere.season, episode: elsewhere.episode, source: elsewhere.episodeSource }),
  );

  frameList = [{ frameId: 0 }];
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
let errors = [];
await until(async () => {
  errors = (await trace.entries()).filter((e) => e.kind === "error");
  return errors.length === 1;
});
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

/* --- what a word costs when there IS a daemon ---------------------------------
 *
 * With a model behind it the line is part of the answer, so it is part of the
 * key - and the rest of what the reader's page knows is neither. The film and
 * the two lines either side help the model answer the question; they do not
 * change which question it is, so they travel with the request and stay out of
 * the key. Filed by them, a word said twice in one film would be asked twice
 * and a line an episode repeats would never hit at all.
 */
{
  const asked = [];
  daemonUp = true;
  daemonAnswers = (url) => {
    const at = String(url);
    // The probe is the daemon's own, and without it this whole block runs the
    // no-daemon path above and asserts nothing about the daemon.
    if (at.endsWith("/health")) return { default_languages: ["en"] };
    if (!at.includes("/lookup")) return null;
    asked.push(at);
    return { definitions: [], translation: "sıçrama", source: "gloss" };
  };
  await (await import("../src/provider.js")).daemonUp({ force: true });

  const { lookup } = await import("../src/study/lookup.js");
  const line = "Prepare for the jump.";
  const answer = await lookup({
    query: "jump", language: "en", target: "tr", sentence: line,
    film: "Battlestar Galactica (2003), season 0 episode 1",
    before: "Are we clear of the fleet?",
    after: "Coordinates laid in, sir.",
  });
  const sent = new URL(asked[0] || "http://127.0.0.1:8791/lookup").searchParams;
  t(
    "the film and the lines around it reach the daemon",
    sent.get("film") === "Battlestar Galactica (2003), season 0 episode 1" &&
      sent.get("before") === "Are we clear of the fleet?" &&
      sent.get("after") === "Coordinates laid in, sir." &&
      sent.get("sentence") === line &&
      answer.translation === "sıçrama",
    `asked ${asked[0]}`,
  );

  await lookup({
    query: "jump", language: "en", target: "tr", sentence: line,
    film: "Something Else", before: "A different line entirely.",
  });
  t(
    "a word in the same line is one question however it was surrounded",
    asked.length === 1,
    `asked ${asked.length} time(s)`,
  );

  /* And a page that says nothing about itself asks exactly the request it
   * always asked - an empty film is left out rather than sent as "". */
  await lookup({ query: "chamber", language: "en", target: "tr", sentence: "The chamber." });
  const bare = new URL(asked[1] || "http://127.0.0.1:8791/lookup").searchParams;
  t(
    "what nobody knows is left out rather than sent empty",
    asked.length === 2 && !bare.has("film") && !bare.has("before") && !bare.has("after"),
    `asked ${asked[1]}`,
  );

  daemonAnswers = null;
  daemonUp = true;
}

/* --- a daemon that answers the probe and then does not answer -----------------
 *
 * The interesting case, and the one the key used to get wrong. Whether the line
 * belongs in the key is a fact about who answered, not about who was listening:
 * a daemon whose model will not load passes the probe, fails the lookup, and
 * sends every word to the archive - and if the archive's answers are filed
 * under the line, one film asks it once per sentence and spends a day's six
 * hundred words in an evening. That is the shape the shadowing bug had.
 */
{
  const archive = [];
  daemonUp = true;
  daemonAnswers = (url) => {
    const at = String(url);
    if (at.endsWith("/health")) return { default_languages: ["en"] };
    if (at.includes("/lookup")) return { error: "the gloss model would not load" };
    if (at.includes("mymemory")) {
      archive.push(at);
      return { matches: [{ translation: "uçak hangarı", match: 1, quality: "90" }] };
    }
    return null;
  };
  await (await import("../src/provider.js")).daemonUp({ force: true });

  const { lookup } = await import("../src/study/lookup.js");
  const first = await lookup({
    query: "hangar", language: "en", target: "tr", sentence: "Clear the hangar deck.",
  });
  const second = await lookup({
    query: "hangar", language: "en", target: "tr", sentence: "He was hiding in the hangar.",
  });
  t(
    "a daemon that fails the lookup does not multiply what the archive is asked",
    archive.length === 1 && first.translation === "uçak hangarı" && second.translation === "uçak hangarı",
    `asked ${archive.length} time(s), answers ${JSON.stringify([first.translation, second.translation])}`,
  );

  /* Every answer says where it came from, including the second time. A
   * translation with no definition beside it used to carry no source at all,
   * and the replay read that back as the string "undefined (cached)". */
  t(
    "a translation says where it came from, and still does when it is replayed",
    first.source === "mymemory.translated.net" &&
      second.source === "mymemory.translated.net (cached)",
    `${JSON.stringify([first.source, second.source])}`,
  );

  /* And when nothing answers at all, the daemon's reason is what the chip
   * shows. Dropping it reported the archive's silence for a word the daemon
   * knows and could not gloss. */
  const nothing = await lookup({ query: "reactor", language: "en", target: "", sentence: "The reactor." });
  t(
    "when nothing answers, the chip carries the reason the daemon gave",
    String(nothing.unavailable).includes("the gloss model would not load"),
    `unavailable: ${nothing.unavailable}`,
  );

  daemonAnswers = null;
  daemonUp = true;
}

/* --- the cache reaches disk while the reader is still reading -----------------
 *
 * The storage write is debounced, and the debounce is restarted by every
 * lookup, so a reader working through a scene restarts it forever: eight
 * lookups over 9.6 seconds produced no write at all, and a worker torn down in
 * that window loses every one of them. Checked through the delay the code asks
 * for rather than by waiting ten seconds - the invariant is that the delay
 * shrinks to nothing once the oldest pending change is old enough.
 */
{
  const delays = [];
  const realTimeout = globalThis.setTimeout;
  const realNow = Date.now;
  /* Anchored on the real clock rather than on a round number: an earlier block
   * in this file left a write pending, and a fake clock set in the past reads
   * as "that change is not old yet" forever. */
  let clock = realNow();
  globalThis.setTimeout = (fn, ms) => {
    delays.push(ms);
    return realTimeout(() => {}, 0);
  };
  Date.now = () => clock;

  daemonUp = false;
  daemonAnswers = (url) =>
    String(url).includes("mymemory")
      ? { matches: [{ translation: "cevap", match: 1, quality: "90" }] }
      : null;
  await (await import("../src/provider.js")).daemonUp({ force: true });

  const { lookup } = await import("../src/study/lookup.js");
  // A word a second, which is slower than a reader clicking through a scene and
  // still fast enough that a two-second debounce never expires on its own.
  for (let i = 0; i < 12; i++) {
    await lookup({ query: `pending${i}`, language: "en", target: "tr", sentence: "" });
    clock += 1000;
  }

  globalThis.setTimeout = realTimeout;
  Date.now = realNow;
  daemonAnswers = null;
  daemonUp = true;

  t(
    "a reader who never pauses still gets the cache written down",
    delays.length === 12 && delays[0] === 2000 && delays[delays.length - 1] === 0,
    `delays ${JSON.stringify(delays)}`,
  );
}

/* --- which languages a search asks for ----------------------------------------
 *
 * There are two lists. The options page writes one into the extension's storage
 * and reads it straight back, so the field shows the reader's own answer. The
 * daemon has another in a config file on disk that the options page never
 * touches, and status() reports THAT one while a daemon is running. So saving
 * "tr, en" and then starting the daemon searched in the daemon's order instead,
 * with the field still showing what the reader chose - and the order is what
 * decides which of the pair is the language being learnt.
 */
{
  const provider = await import("../src/provider.js");
  daemonUp = true;
  daemonAnswers = (url) =>
    String(url).endsWith("/health") ? { default_languages: ["en", "de"] } : null;
  await provider.daemonUp({ force: true });

  const heldProvider = (await chrome.storage.local.get("sso:provider"))["sso:provider"];
  const heldUsed = (await chrome.storage.local.get("sso:usedLanguages"))["sso:usedLanguages"];
  await chrome.storage.local.set({ "sso:usedLanguages": [] });

  await chrome.storage.local.set({ "sso:provider": { apiKey: "", languages: ["tr", "en"] } });
  const chosen = await provider.preferredLanguages();
  t(
    "the list the reader saved is the one searched for, daemon running or not",
    chosen[0] === "tr" && chosen[1] === "en",
    JSON.stringify(chosen),
  );

  await chrome.storage.local.set({ "sso:provider": { apiKey: "" } });
  const unset = await provider.preferredLanguages();
  t(
    "and a reader who never saved one gets the daemon's list rather than a built-in default",
    unset[0] === "en" && unset.includes("de"),
    JSON.stringify(unset),
  );

  await chrome.storage.local.set({ "sso:provider": heldProvider, "sso:usedLanguages": heldUsed });
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

/* --- the subtitles the page carries for itself ---------------------------------
 *
 * A streaming player is handed every language a title has, timed to its own
 * picture. The content script overhears the list (src/sites/primevideo.js) and
 * answers `sso:pageSubtitles` with it; what is tested here is what the worker
 * does with that answer - which is everything from "no search at all" to
 * "the page's for one language and the search's for the other" - and that the
 * file it fetches is read into the same cues a download is.
 */
{
  const { parseTtml, toMs } = await import("../src/subtitles/ttml.js");

  const ttml = (lines) => `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000" xml:lang="en-US">
<head><styling>
  <style xml:id="plain" tts:fontStyle="normal"/>
  <style xml:id="ital" tts:fontStyle="italic"/>
</styling></head>
<body style="plain"><div>
${lines}
</div></body></tt>`;

  const read = parseTtml(ttml(`
  <p begin="00:00:01.500" end="00:00:03.000" region="r0">Hello,<br/>world &amp; friends</p>
  <p begin="00:00:04.000" end="00:00:05.000"><span style="ital">Whispered</span> aloud</p>
  <p begin="00:00:06.000" end="00:00:07.000" style="ital">All
      italic</p>
  <p begin="00:00:08.000" end="00:00:09.000">♪♪</p>
  <p begin="00:00:10.000" dur="2s">With dur</p>
  <p begin="150000000t" end="160000000t">Ticks</p>
  <p begin="00:00:20:15" end="00:00:21:00">Frames</p>
  <p begin="bogus" end="00:00:30.000">Dropped</p>
  <p begin="00:00:12.000" end="00:00:13.000"><span tts:fontWeight="bold">Bold</span> and <span tts:fontStyle="italic">it</span></p>`));
  const texts = read.map((cue) => cue.text);
  t("a TTML paragraph is a cue on the title's own clock",
    read[0]?.startMs === 1500 && read[0]?.endMs === 3000, JSON.stringify(read[0]));
  t("a <br/> is a line break and an entity is its character",
    texts[0] === "Hello,\nworld & friends", JSON.stringify(texts[0]));
  t("a style named in the head reaches the span that names it",
    texts[1] === "<i>Whispered</i> aloud", JSON.stringify(texts[1]));
  t("a style on the paragraph covers the whole line, and its newlines collapse",
    texts[2] === "<i>All\nitalic</i>", JSON.stringify(texts[2]));
  t("a cue with nothing to read is not a cue, the same rule as SRT",
    !texts.includes("♪♪"), JSON.stringify(texts));
  t("dur, ticks and frames are read; a time nobody can read costs one cue",
    read.some((c) => c.text === "With dur" && c.endMs === 12000) &&
      read.some((c) => c.text === "Ticks" && c.startMs === 15000) &&
      read.some((c) => c.text === "Frames" && c.startMs === 20500) &&
      !texts.includes("Dropped"),
    JSON.stringify(read.map((c) => [c.startMs, c.endMs, c.text])));
  t("styles written on the span itself are read too",
    texts.includes("<b>Bold</b> and <i>it</i>"), JSON.stringify(texts));
  t("the spec's other spellings of a time",
    toMs("1.5s") === 1500 && toMs("750ms") === 750 && toMs("2m") === 120000 && toMs("00:01:00") === 60000 && toMs("12") === null,
    `${toMs("1.5s")} ${toMs("750ms")} ${toMs("2m")} ${toMs("00:01:00")} ${toMs("12")}`);

  /* And the worker's side of it. The page carries EN, EN [CC], TR and a forced
   * track; the reader wants EN then TR. */
  const site = "Prime Video";
  const track = (code, kind, url) => ({
    id: `page:T1:${code}:${kind}`, language: code.split("-")[0], code, kind, displayName: code, url,
  });
  const onPage = {
    site, titleId: "T1",
    tracks: [
      track("en-us", "sdh", "https://cdn.example/en-cc.dfxp"),
      track("en-us", "subtitle", "https://cdn.example/en.dfxp"),
      track("tr-tr", "subtitle", "https://cdn.example/tr.dfxp"),
      track("en-us", "forced", "https://cdn.example/en-forced.dfxp"),
    ],
  };
  pageFiles = {
    "https://cdn.example/en.dfxp": ttml(`<p begin="00:00:01.000" end="00:00:02.000">Page English</p>`),
    "https://cdn.example/en-cc.dfxp": ttml(`<p begin="00:00:01.000" end="00:00:02.000">[door] Page English</p>`),
    "https://cdn.example/tr.dfxp": ttml(`<p begin="00:00:01.000" end="00:00:02.000">Sayfa Türkçesi</p>`),
  };
  const heldProvider = (await chrome.storage.local.get("sso:provider"))["sso:provider"];
  await chrome.storage.local.set({ "sso:provider": { apiKey: "", languages: ["en", "tr"] } });
  /* The daemon is up and answers the probe before anything asks it, or the
   * provider marks it down and every question below is answered from the
   * extension's own store - whose stub here has no disk behind it. */
  daemonUp = true;
  daemonAnswers = (url) => (String(url).endsWith("/health") ? { default_languages: ["en"] } : null);
  await (await import("../src/provider.js")).daemonUp({ force: true });

  const attaches = () => sentToTab.filter((m) => m.type === "sso:attach").map((m) => m.message.payload);
  let searches = 0;
  const counting = (answers) => (url) => {
    if (String(url).includes("/search")) searches += 1;
    return answers(url);
  };

  // Both languages on the page: no search, both attached, neither the [CC] nor the forced one.
  pageSubtitlesReply = () => onPage;
  searches = 0;
  let tried = await attempt("3000|Prime E1", counting(americans()));
  let got = attaches();
  t("a page carrying both languages is not searched for at all",
    searches === 0 && got.length === 2, `${searches} searches, ${got.length} attaches: ${JSON.stringify(tried)}`);
  t("the plain track wins over [CC], and the forced track is never picked",
    got[0]?.fileId === "page:T1:en-us:subtitle" && got[1]?.fileId === "page:T1:tr-tr:subtitle",
    JSON.stringify(got.map((a) => a.fileId)));
  t("the file is read into cues on the title's clock, labelled for the site",
    got[0]?.cues?.[0]?.text === "Page English" && got[0]?.cues?.[0]?.start === 1000 && got[0]?.label === "EN · Prime Video",
    JSON.stringify({ label: got[0]?.label, cue: got[0]?.cues?.[0] }));
  t("the Turkish one too",
    got[1]?.cues?.[0]?.text === "Sayfa Türkçesi" && got[1]?.language === "tr" && got[1]?.slot === 1,
    JSON.stringify(got[1] && { label: got[1].label, slot: got[1].slot }));

  // Only English on the page: the page's for EN, the search's for TR.
  const enOnly = { ...onPage, tracks: onPage.tracks.filter((one) => one.language !== "tr") };
  const withTurkish = (url) => {
    const answer = americans()(url);
    if (String(url).includes("/search")) {
      answer.results.push({ file_id: 77, language: "tr", season: 3, episode: 13, movie_name: "The Americans", release: "The.Americans.S03E13.TR", match_score: 0.9 });
    }
    return answer;
  };
  pageSubtitlesReply = () => enOnly;
  searches = 0;
  tried = await attempt("3001|Prime E2", counting(withTurkish));
  got = attaches();
  t("a page carrying one language is searched for the other",
    searches === 1 && got.length === 2 && got[0]?.fileId === "page:T1:en-us:subtitle" && got[1]?.fileId === 77,
    `${searches} searches: ${JSON.stringify(got.map((a) => [a.slot, a.fileId]))} ${JSON.stringify(tried.said)}`);

  // Only English on the page, and the search cannot say which episode: EN goes up, and the refusal is said for TR alone.
  const noEpisode = (url) => {
    const answer = americans()(url);
    if (String(url).includes("/search")) {
      answer.used = { query: "The Americans", languages: ["en", "tr"] };
      answer.results.push({ file_id: 78, language: "tr", season: 1, episode: 2, movie_name: "The Americans", release: "The.Americans.S01E02.TR", match_score: 0.9 });
    }
    return answer;
  };
  pageInfoReply = () => ({ ok: true, candidates: [{ source: "json-ld-series", text: "The Americans", episode: null }] });
  pageSubtitlesReply = () => enOnly;
  tried = await attempt("3002|Prime E3", noEpisode);
  got = attaches();
  t("with the episode unknown, the page's English still goes up and the refusal is about the other language",
    got.length === 1 && got[0]?.fileId === "page:T1:en-us:subtitle" && tried.said.some((m) => /^Only EN: for the other language/.test(m)),
    JSON.stringify({ attached: got.map((a) => a.fileId), said: tried.said }));

  // The panel's path: a fetch by id goes to the page, not to OpenSubtitles.
  pageSubtitlesReply = () => onPage;
  const fetched = await ask({ type: "sso:daemon", op: "fetch", args: { fileId: "page:T1:tr-tr:subtitle" } }, sender);
  t("the panel can fetch a page track by its id",
    fetched?.served_by === "page" && fetched.cues?.[0]?.text === "Sayfa Türkçesi" && fetched.meta?.words === 2,
    JSON.stringify(fetched));
  const stale = await ask({ type: "sso:daemon", op: "fetch", args: { fileId: "page:T1:de-de:subtitle" } }, sender);
  t("and a track the page no longer offers is an error, not a silent nothing",
    /no longer offers/.test(stale?.error || ""), JSON.stringify(stale));

  /* A trailer. Prime Video plays one in the hero of every detail page, long
   * and large enough to be the page's video; on 2026-09-13 the log shows a
   * plan for a trailer three times in thirty seconds of browsing, two of
   * them searched and attached from OpenSubtitles. Under ten minutes an
   * automatic run uses what the page carries and searches for nothing. */
  pageSubtitlesReply = () => null;
  searches = 0;
  pageInfoReply = () => seriesPage;
  daemonAnswers = counting(americans());
  tabStatusReply = { ok: true, hasVideo: true, attached: false, seconds: 95 };
  sentToTab.length = 0;
  await ask({ type: "sso:programme", mark: "95|Trailer" }, sender);
  t("a programme under ten minutes is not searched for by itself, and nothing is said",
    searches === 0 && !sentToTab.some((m) => m.type === "sso:attach") && toasts().length === 0,
    `${searches} searches, said ${JSON.stringify(toasts())}`);
  {
    const log = await import("../src/trace.js");
    const plan = async () => (await log.entries()).filter((e) => e.kind === "autoAttach" && e.plan?.decision === "short").pop();
    await until(async () => Boolean(await plan()));
    t("and the plan in the log says why", /shorter than ten minutes/.test((await plan())?.plan?.reason || ""), JSON.stringify((await plan())?.plan?.reason));
  }
  // ...but what the page carries for it is still put up, without a search for the rest.
  pageSubtitlesReply = () => enOnly;
  searches = 0;
  sentToTab.length = 0;
  await ask({ type: "sso:programme", mark: "96|Trailer with captions" }, sender);
  got = attaches();
  t("a short programme's own track goes up and the other language is not searched for",
    searches === 0 && got.length === 1 && got[0]?.fileId === "page:T1:en-us:subtitle",
    `${searches} searches: ${JSON.stringify(got.map((a) => a.fileId))} ${JSON.stringify(toasts())}`);
  // Told again once the length grew past the bar: the same mark, searched this time.
  searches = 0;
  sentToTab.length = 0;
  tabStatusReply = { ok: true, hasVideo: true, attached: false, seconds: 5400 };
  await ask({ type: "sso:programme", mark: "96|Trailer with captions", again: "grew" }, sender);
  t("a programme told again after its length grew is searched for, mark and all",
    searches === 1, `${searches} searches ${JSON.stringify(toasts())}`);
  await ask({ type: "sso:programme", mark: "96|Trailer with captions" }, sender);
  t("and without `again` the same mark is still one programme",
    searches === 1, `${searches} searches`);
  tabStatusReply = { ok: true, hasVideo: true, attached: false, seconds: 95 };
  // The shortcut on the same short programme is a question, and is searched.
  pageSubtitlesReply = () => null;
  searches = 0;
  sentToTab.length = 0;
  await ask({ type: "sso:command", command: "auto-attach" }, sender);
  t("pressed for, a short programme is searched like any other",
    searches === 1, `${searches} searches ${JSON.stringify(toasts())}`);
  daemonAnswers = null;
  pageInfoReply = () => ({ ok: true });

  // Nothing to warm for the next episode while the page is providing.
  tabStatusReply = { ok: true, hasVideo: true, attached: true, tracks: [{ attached: true, fileId: "page:T1:en-us:subtitle" }] };
  searches = 0;
  daemonAnswers = counting(americans());
  await ask({ type: "sso:warmNext", next: { title: "The Americans", season: 3, episode: 14 }, committed: true }, sender);
  t("the next episode is not prefetched while the page carries its own subtitles",
    searches === 0, `${searches} searches`);
  const log = await import("../src/trace.js");
  const warm = async () => (await log.entries()).filter((e) => e.kind === "warmNext").pop();
  await until(async () => (await warm())?.decision === "page-provides");
  t("and the log says why", (await warm())?.decision === "page-provides", JSON.stringify(await warm()));

  /* The other two formats an ear can name. Netflix serves WebVTT when asked
   * and TTML when not; Disney+ serves a playlist of WebVTT segments. */
  const { parseVtt, joinSegments, segmentUrls } = await import("../src/subtitles/vtt.js");
  const vtt = parseVtt(`WEBVTT
X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000

NOTE a comment block

STYLE
::cue { color: white }

1
00:00:01.500 --> 00:00:03.000 line:85% align:center
Hello,
world &amp; friends

00:00:04.000 --> 00:00:05.000
<i>Whispered</i> <c.yellow>aloud</c>

01:00:06.000 --> 01:00:07.000
<v Roslin>- Yes.</v>
- No.

00:00:08.000 --> 00:00:09.000
♪♪

00:00:09.000 --> 00:00:08.000
Backwards

00:10.000 --> 00:11.000
Short stamp
`);
  const vttTexts = vtt.map((cue) => cue.text);
  t("a WebVTT cue is a cue on the title's clock, its settings and header blocks ignored",
    vtt[0]?.startMs === 1500 && vtt[0]?.endMs === 3000 && vttTexts[0] === "Hello,\nworld & friends", JSON.stringify(vtt[0]));
  t("italics stay, a class tag and a voice tag go, a short stamp is read, an hour is an hour",
    vttTexts[1] === "<i>Whispered</i> aloud" && vttTexts.includes("- Yes.\n- No.") && vtt.find((c) => c.text === "Short stamp")?.startMs === 10000 &&
      vtt.find((c) => c.text === "- Yes.\n- No.")?.startMs === 3606000,
    JSON.stringify(vtt.map((c) => [c.startMs, c.text])));
  t("a cue with nothing to read, or with its end before its start, costs one cue",
    !vttTexts.includes("♪♪") && !vttTexts.includes("Backwards") && vtt.length === 4, JSON.stringify(vttTexts));
  const joined = joinSegments([
    parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne\n\n00:00:59.000 --> 00:01:01.000\nAcross\n"),
    parseVtt("WEBVTT\n\n00:00:59.000 --> 00:01:01.000\nAcross\n\n00:01:02.000 --> 00:01:03.000\nTwo\n"),
  ]);
  t("a cue written into both segments it spans is one cue",
    joined.map((c) => c.text).join() === "One,Across,Two", JSON.stringify(joined));
  t("a media playlist's segments are resolved against the playlist, comments and blanks skipped",
    segmentUrls("#EXTM3U\n#EXTINF:6.0,\nseg-1.vtt\n\n#EXTINF:6.0,\n../seg-2.vtt\n#EXT-X-ENDLIST\n", "https://cdn.example/r/s/tr/sub-main.m3u8").join() ===
      "https://cdn.example/r/s/tr/seg-1.vtt,https://cdn.example/r/s/seg-2.vtt",
    JSON.stringify(segmentUrls("#EXTM3U\nseg-1.vtt\n", "https://cdn.example/r/s/tr/sub-main.m3u8")));

  // The worker, given a Disney+ track: playlist, then every segment, joined.
  pageFiles = {
    "https://cdn.example/r/s/tr/sub-main.m3u8": "#EXTM3U\n#EXTINF:60.0,\nseg-1.vtt\n#EXTINF:60.0,\nseg-2.vtt\n#EXT-X-ENDLIST\n",
    "https://cdn.example/r/s/tr/seg-1.vtt": "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:02.000\nBir\n\n00:00:59.000 --> 00:01:01.000\nSınırda\n",
    "https://cdn.example/r/s/tr/seg-2.vtt": "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:59.000 --> 00:01:01.000\nSınırda\n\n00:01:02.000 --> 00:01:03.000\nİki\n",
    "https://cdn.example/nf/tr.vtt": "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nNetflix Türkçesi\n",
  };
  pageSubtitlesReply = () => ({
    site: "Disney+", titleId: "D1",
    tracks: [
      { ...track("tr", "subtitle", "https://cdn.example/r/s/tr/sub-main.m3u8"), id: "page:D1:tr:subtitle", format: "hls-vtt" },
      { ...track("tr", "subtitle", "https://cdn.example/nf/tr.vtt"), id: "page:D1:tr:sdh", format: "vtt" },
    ],
  });
  const hls = await ask({ type: "sso:daemon", op: "fetch", args: { fileId: "page:D1:tr:subtitle" } }, sender);
  t("a playlist of segments is fetched segment by segment and read as one file",
    hls?.served_by === "page" && hls.cues?.map((c) => c.text).join() === "Bir,Sınırda,İki" && hls.cues[2].start === 62000,
    JSON.stringify(hls));
  const plain = await ask({ type: "sso:daemon", op: "fetch", args: { fileId: "page:D1:tr:sdh" } }, sender);
  t("and a WebVTT file is read as itself",
    plain?.cues?.[0]?.text === "Netflix Türkçesi", JSON.stringify(plain));

  /* DASH: the manifest names the text tracks; each is a file or a run of
   * segments, and stpp segments carry a TTML document each. */
  const { textRepresentations, durationSeconds, ttmlDocumentsIn } = await import("../src/subtitles/dash.js");
  const mpd = await (await import("node:fs/promises")).readFile(new URL("./fixtures/tabii/master.mpd", import.meta.url), "utf-8");
  const reps = textRepresentations(mpd, "https://cdn.example/tabii/ep1/master.mpd?token=SECRET");
  t("an MPD's text adaptation sets are read, video and audio left alone",
    reps.map((r) => `${r.id}/${r.lang}/${r.mimeType}`).join() === "t-en/en/application/mp4,t-tr/tr/text/vtt,t-en-forced/en/application/ttml+xml",
    JSON.stringify(reps.map((r) => [r.id, r.lang, r.mimeType, r.codecs, r.role])));
  t("a segment timeline becomes the run of URLs the player would fetch, initialization first, against the MPD's BaseURL",
    reps[0].segments.join() === "https://cdn.example/tabii/ep1/s/t-en/init.mp4?token=SECRET,https://cdn.example/tabii/ep1/s/t-en/1.m4s?token=SECRET,https://cdn.example/tabii/ep1/s/t-en/2.m4s?token=SECRET",
    JSON.stringify(reps[0].segments));
  t("a representation's own BaseURL is one whole file, and the roles are read",
    reps[1].file === "https://cdn.example/tabii/ep1/s/tr/all.vtt?token=SECRET" && reps[2].role === "forced-subtitle" && reps[1].accessibility === "2",
    JSON.stringify([reps[1].file, reps[2].role, reps[1].accessibility]));
  const numbered = textRepresentations(`<MPD mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="text/vtt" lang="de"><SegmentTemplate media="$RepresentationID$-$Number%03d$.vtt" timescale="1" duration="4" startNumber="0"/><Representation id="x"/></AdaptationSet></Period></MPD>`, "https://cdn.example/d/m.mpd");
  t("a fixed segment duration is counted out over the presentation's length, with the number's width",
    numbered[0]?.segments.join() === "https://cdn.example/d/x-000.vtt,https://cdn.example/d/x-001.vtt,https://cdn.example/d/x-002.vtt" && durationSeconds("PT1H2M3.5S") === 3723.5,
    JSON.stringify(numbered));
  const stpp = new TextEncoder().encode(`\u0000\u0000\u0000\u0018ftypisom\u0000\u0000\u0000\u0000mdat<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:00:01.000" end="00:00:02.000">Segment one</p></div></body></tt>`);
  t("the TTML document inside an stpp segment is taken out of its bytes",
    ttmlDocumentsIn(stpp).length === 1 && ttmlDocumentsIn(stpp)[0].startsWith("<tt"), JSON.stringify(ttmlDocumentsIn(stpp)));

  // The worker, given DASH tracks: the stpp run, the VTT file, and the way it says no to wvtt.
  pageFiles = {
    "https://cdn.example/tabii/ep1/master.mpd?token=SECRET": mpd,
    "https://cdn.example/tabii/ep1/s/t-en/init.mp4?token=SECRET": new TextEncoder().encode("ftypisom no document here"),
    "https://cdn.example/tabii/ep1/s/t-en/1.m4s?token=SECRET": new TextEncoder().encode(`mdat<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:00:01.000" end="00:00:02.000">One</p></div></body></tt>`),
    "https://cdn.example/tabii/ep1/s/t-en/2.m4s?token=SECRET": new TextEncoder().encode(`mdat<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:00:11.000" end="00:00:12.000">Two</p></div></body></tt>`),
    "https://cdn.example/tabii/ep1/s/tr/all.vtt?token=SECRET": "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBir\n",
    "https://cdn.example/w.mpd": `<MPD mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="application/mp4" codecs="wvtt" lang="en"><SegmentTemplate media="w-$Number$.m4s" timescale="1" duration="5"/><Representation id="w"/></AdaptationSet></Period></MPD>`,
  };
  pageSubtitlesReply = () => ({
    site: "tabii", titleId: "4242",
    tracks: [
      { ...track("en", "subtitle", "https://cdn.example/tabii/ep1/master.mpd?token=SECRET"), id: "page:4242:en:subtitle", format: "dash", dash: { representation: "t-en", adaptation: "2" } },
      { ...track("tr", "subtitle", "https://cdn.example/tabii/ep1/master.mpd?token=SECRET"), id: "page:4242:tr:subtitle", format: "dash", dash: { representation: "t-tr", adaptation: "3" } },
      { ...track("en", "sdh", "https://cdn.example/w.mpd"), id: "page:4242:en:sdh", format: "dash", dash: { representation: "w", adaptation: "0" } },
    ],
  });
  const stppRead = await ask({ type: "sso:daemon", op: "fetch", args: { fileId: "page:4242:en:subtitle" } }, sender);
  t("a DASH text track of stpp segments is read document by document, on the title's clock",
    stppRead?.cues?.map((c) => c.text).join() === "One,Two" && stppRead.cues[1].start === 11000, JSON.stringify(stppRead));
  const vttRead = await ask({ type: "sso:daemon", op: "fetch", args: { fileId: "page:4242:tr:subtitle" } }, sender);
  t("a DASH text track that is one WebVTT file is read as that file",
    vttRead?.cues?.[0]?.text === "Bir", JSON.stringify(vttRead));
  const wvttRead = await ask({ type: "sso:daemon", op: "fetch", args: { fileId: "page:4242:en:sdh" } }, sender);
  t("WebVTT in MP4 samples is refused by name rather than read as nothing",
    /WebVTT inside MP4/.test(wvttRead?.error || ""), JSON.stringify(wvttRead));
  pageSubtitlesReply = () => ({ site: "tabii", titleId: "4242", tracks: [{ ...track("de", "subtitle", "texttrack:0:0"), id: "page:4242:de:subtitle", format: "cues", cues: [{ startMs: 1000, endMs: 2000, text: "Hallo" }, { startMs: 3000, endMs: 4000, text: "Welt" }, { startMs: "x", endMs: 5, text: 1 }] }] });
  const offTrack = await ask({ type: "sso:daemon", op: "fetch", args: { fileId: "page:4242:de:subtitle" } }, sender);
  t("cues read off the browser's own text track need no fetch, and a bad one costs one cue",
    offTrack?.cues?.map((c) => c.text).join() === "Hallo,Welt" && offTrack.cues[1].start === 3000, JSON.stringify(offTrack));
  pageFiles = { "https://www.youtube.com/api/timedtext?v=x&fmt=vtt": "" };
  pageSubtitlesReply = () => ({ site: "YouTube", titleId: "x", tracks: [{ ...track("en", "subtitle", "https://www.youtube.com/api/timedtext?v=x&fmt=vtt"), id: "page:x:en:subtitle", format: "vtt" }] });
  const empty = await ask({ type: "sso:daemon", op: "fetch", args: { fileId: "page:x:en:subtitle" } }, sender);
  t("an empty answer says what to do about it rather than 'no lines'",
    /turn the player's own captions on/.test(empty?.error || ""), JSON.stringify(empty));

  /* A <track> the document carries, the standard way. The catalogue app's
   * URL has no extension, so the bytes say which of the three it is; and its
   * cues are on the element's clock, which is the film's less the offset the
   * page states - the frame sends the shift, the worker adds it. */
  pageFiles = {
    "http://localhost:5173/subtitle?path=a.mkv&stream=2&shift=1500": "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBir\n",
    "http://localhost:5173/subtitle?path=b.srt": "1\n00:00:01,000 --> 00:00:02,000\nOne\n\n2\n00:00:03,000 --> 00:00:04,000\nTwo\n",
    "http://localhost:5173/subtitle?path=c.ttml": ttml(`<p begin="00:00:01.000" end="00:00:02.000">Eins</p>`),
  };
  pageSubtitlesReply = () => ({ site: "localhost", titleId: "tt1", tracks: [
    { ...track("tr", "subtitle", "http://localhost:5173/subtitle?path=a.mkv&stream=2&shift=1500"), id: "page:tt1:tr:subtitle", format: "auto", shiftMs: 1500000 },
    { ...track("en", "subtitle", "http://localhost:5173/subtitle?path=b.srt"), id: "page:tt1:en:subtitle", format: "auto" },
    { ...track("de", "subtitle", "http://localhost:5173/subtitle?path=c.ttml"), id: "page:tt1:de:subtitle", format: "auto" },
  ] });
  const shiftedVtt = await ask({ type: "sso:daemon", op: "fetch", args: { fileId: "page:tt1:tr:subtitle" } }, sender);
  t("a track with no extension is read by its first bytes, and the element clock's shift is added to every cue",
    shiftedVtt?.cues?.[0]?.text === "Bir" && shiftedVtt.cues[0].start === 1501000 && shiftedVtt.cues[0].end === 1502000,
    JSON.stringify(shiftedVtt?.cues));
  const autoSrt = await ask({ type: "sso:daemon", op: "fetch", args: { fileId: "page:tt1:en:subtitle" } }, sender);
  const autoTtml = await ask({ type: "sso:daemon", op: "fetch", args: { fileId: "page:tt1:de:subtitle" } }, sender);
  t("SRT and TTML bodies are told apart the same way, and an unshifted track stays where it was",
    autoSrt?.cues?.map((c) => c.text).join() === "One,Two" && autoSrt.cues[0].start === 1000 && autoTtml?.cues?.[0]?.text === "Eins",
    JSON.stringify([autoSrt?.cues, autoTtml?.cues]));

  daemonAnswers = null;
  pageSubtitlesReply = () => null;
  pageFiles = {};
  tabStatusReply = { ok: true, hasVideo: true, attached: false };
  await chrome.storage.local.set({ "sso:provider": heldProvider });
}

/* --- a subtitle translated by the daemon, as a job -------------------------------
 *
 * Four ops and one list, all daemon-only: the extension's own store has no
 * model behind it. What is checked is that each op reaches the daemon's
 * endpoint with the body it was given, and that a daemon that is not there
 * answers in the { transportError } shape every caller of api.daemon reads.
 */
{
  const seen = [];
  daemonUp = true;
  daemonAnswers = (url, method) => {
    const path = new URL(url).pathname + new URL(url).search;
    seen.push(`${method} ${path}`);
    if (path === "/health") return { default_languages: ["en", "tr"], translate_model: "gemma3:4b", translate_seconds_per_cue: 0.5 };
    if (path === "/translate") return { job: "13-abc-tr", status: "queued", done: 0, total: 3, generated_file_id: 90000000000001 };
    if (path === "/translate/13-abc-tr?cues=1") return { job: "13-abc-tr", status: "done", done: 3, total: 3, cues: [{ start: 0, end: 900, text: "satır 1" }] };
    if (path === "/translate/13-abc-tr" && method === "POST") return { job: "13-abc-tr", status: "queued", done: 0, total: 2, retrying: true };
    if (path === "/translate/13-abc-tr") return { job: "13-abc-tr", status: "running", done: 2, total: 3 };
    return null;
  };
  await (await import("../src/provider.js")).daemonUp({ force: true });

  const started = await ask({ type: "sso:daemon", op: "translate", args: { body: { source_id: "13", language: "en", target: "tr", cues: [{ start: 0, end: 900, text: "line 1" }] } } }, sender);
  t("translate posts the body to /translate and answers with the job",
    started?.job === "13-abc-tr" && started.generated_file_id === 90000000000001, JSON.stringify(started));
  const progress = await ask({ type: "sso:daemon", op: "translateStatus", args: { job: "13-abc-tr" } }, sender);
  const full = await ask({ type: "sso:daemon", op: "translateStatus", args: { job: "13-abc-tr", cues: true } }, sender);
  t("translateStatus asks with and without the cues",
    progress?.done === 2 && full?.cues?.[0]?.text === "satır 1" && seen.includes("GET /translate/13-abc-tr") && seen.includes("GET /translate/13-abc-tr?cues=1"),
    JSON.stringify({ progress, full, seen }));
  const resumed = await ask({ type: "sso:daemon", op: "translateResume", args: { job: "13-abc-tr" } }, sender);
  t("translateResume posts to the job with nothing but its key",
    resumed?.retrying === true && resumed.total === 2 && seen.includes("POST /translate/13-abc-tr"), JSON.stringify({ resumed, seen }));
  const languages = await ask({ type: "sso:daemon", op: "languages", args: {} }, sender);
  t("languages answers the reader's list, best first",
    Array.isArray(languages?.languages) && languages.languages[0] === "en", JSON.stringify(languages));

  daemonUp = false;
  daemonAnswers = null;
  await (await import("../src/provider.js")).daemonUp({ force: true });
  const down = await ask({ type: "sso:daemon", op: "translate", args: { body: {} } }, sender);
  t("with the daemon down, translate answers in the shape every caller reads",
    typeof down?.transportError === "string" && down.transportError.length > 0, JSON.stringify(down));
  daemonUp = true;
}

/* --- phrasal verbs -----------------------------------------------------------
 *
 * The matcher, on its own. It is imported by the build script as well as by the
 * worker, so a table is ranked by counting the corpus with the same code that
 * will later match against it - which means these cases are also what the
 * table's order means.
 */
{
  const { buildIndex, findPhrases, surfaceForms } = await import("../src/study/phrases.js");
  /* `fuck up` and `hand off` are in here so the gap in "shut the fuck up" and
   * "take your hands off me" really does hold a verb that could take the same
   * particle - without them those two cases would prove nothing. */
  const index = buildIndex([
    "back off", "pick up", "put up", "put up with", "give in", "look at",
    "find out", "want out", "shut up", "take off", "fuck up", "hand off",
  ]);
  const of = (line) => findPhrases(line.split(" "), index);
  const said = (line) => of(line).map((hit) => `${hit.phrase}@${hit.words.join(",")}`).join(" ");

  t("a phrasal verb is found in every tense a line can say it in",
    ["he gives up", "he gave up", "he is giving up", "he give up"]
      .every((line) => findPhrases(line.split(" "), buildIndex(["give up"])).length === 1),
    JSON.stringify(surfaceForms("give")));

  t("an irregular verb gets no invented past tense",
    !surfaceForms("put").includes("putted") && surfaceForms("put").includes("put")
      && surfaceForms("walk").includes("walked"),
    JSON.stringify(surfaceForms("put")));

  /* Separable, and the object between them is not part of the phrase: a reader
   * shown "pick it up" as one mark learns that the pronoun belongs to it. */
  t("the particle is found away from its verb, and what sits between is not the phrase",
    said("she picked it up") === "pick up@1,3" && said("she picked the whole thing up") === "pick up@1,5",
    said("she picked it up") + " | " + said("she picked the whole thing up"));

  t("and not so far away that any two words count",
    of("she picked the whole damn thing up").length === 0,
    said("she picked the whole damn thing up"));

  /* ...and the gap may not hold the word that changes whose particle it is.
   *
   * Reported: "do you want to find out" was read as `want out`, which is two
   * words that are not a phrase, and it hid the one that is. A `to` in the gap
   * means the particle belongs to the infinitive after it. Measured over the
   * 175 English files in the cache, 214 of the 5178 separated matches span a
   * `to` and every one sampled was wrong. */
  t("a particle behind an infinitive belongs to the infinitive",
    said("do you want to find out") === "find out@4,5",
    said("do you want to find out"));

  t("and the same verb still takes its own particle with nothing between them",
    said("i want out") === "want out@1,2",
    said("i want out"));

  /* The rule that was measured and refused: rejecting any gap containing
   * another verb able to take the same particle would have thrown away 758
   * matches, these two among them. */
  t("a gap may hold another verb that could have taken the particle",
    said("shut the fuck up") === "shut up@0,3" && said("take your hands off me") === "take off@0,3",
    said("shut the fuck up") + " | " + said("take your hands off me"));

  /* "Put up with" is fixed - the object goes after the whole thing - so it
   * takes no gap, and where both could match the longer one wins. */
  t("the longer phrase wins the same words",
    said("i cannot put up with this") === "put up with@2,3,4",
    said("i cannot put up with this"));

  t("and a fixed three-word phrase is not found around an object",
    of("put the phone up with the others").map((h) => h.phrase).join(",") === "put up",
    said("put the phone up with the others"));

  t("two phrases in one line are both found and neither eats the other",
    said("back off and pick up the gun") === "back off@0,1 pick up@3,4",
    said("back off and pick up the gun"));

  t("a rank comes back with each one, which is what decides whether it is marked",
    of("back off").every((hit) => hit.rank === 0) && of("give in").every((hit) => hit.rank === 4),
    JSON.stringify(of("back off").concat(of("give in"))));
}

/* --- word rarity, against the table that ships --------------------------------
 *
 * The real file, read off disk, because the defect these cases guard was in the
 * data and not in the lookup. A stub table would have passed throughout.
 */
{
  const { rank } = await import("../src/study/rarity.js");
  const ranks = await rank(["i", "a", "it", "the", "i'll", "i've", "don't", "we'll", "abuzz"], "en");

  t("the commonest words in film dialogue are in the table",
    ranks.i !== null && ranks.i < 10 && ranks.a !== null && ranks.a < 10,
    `i=${ranks.i} a=${ranks.a}`);

  /* Reported by the study report, not by anyone watching: "i'll" was marked as
   * a rare word in 150 of the 175 English films in this machine's cache and
   * "i've" in 113. A contraction is ranked by the part before the apostrophe,
   * and the table's builder demanded two letters, so "i" was not in it - and a
   * word the table does not hold is read as rarer than the 30,000th. */
  t("a contraction is as common as the word it is made from",
    ranks["i'll"] !== null && ranks["i'll"] < 100 && ranks["i've"] !== null && ranks["i've"] < 100,
    `i'll=${ranks["i'll"]} i've=${ranks["i've"]}`);

  t("and so is one whose stem was always there",
    ranks["don't"] !== null && ranks["don't"] < 100 && ranks["we'll"] !== null && ranks["we'll"] < 100,
    `don't=${ranks["don't"]} we'll=${ranks["we'll"]}`);

  t("a genuinely rare word is still rare",
    ranks.abuzz === null || ranks.abuzz > 20000,
    `abuzz=${ranks.abuzz}`);

  const tr = await rank(["iyi", "ankara'ya"], "tr");
  t("the Turkish table answers the same way, suffix and all",
    tr.iyi !== null && tr.iyi < 200 && tr["ankara'ya"] !== null,
    JSON.stringify(tr));

  /* The table is composed and a .srt need not be. Saved in NFD, "ışık" is five
   * code points with the s carrying a separate combining cedilla, and
   * lowercasing does not put it back together - so a word the table holds
   * arrived in a spelling it does not, came back absent, and absent counts as
   * rarer than the last word in the file. */
  const decomposed = "ışık".normalize("NFD");
  const spellings = await rank([decomposed, "ışık"], "tr");
  t("a word spelled with combining marks ranks as the word it is",
    spellings[decomposed] !== null && spellings[decomposed] === spellings["ışık"],
    `NFD=${spellings[decomposed]} NFC=${spellings["ışık"]}`);
}

for (const r of results) console.log(r.ok ? "PASS" : "FAIL", "-", r.name, r.ok ? "" : `→ ${r.detail}`);

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
