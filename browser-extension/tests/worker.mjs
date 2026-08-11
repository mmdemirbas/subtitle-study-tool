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
const listeners = { message: [], removed: [] };
const store = {};
const sentToTab = [];
let tabStatusReply = { ok: true, hasVideo: true, attached: false };

globalThis.indexedDB = {
  open: () => {
    const request = {};
    queueMicrotask(() => request.onerror?.());
    return request;
  },
};

globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: "test", content_scripts: [{ js: [], css: [] }] }),
    getURL: (p) => `chrome-extension://test/${p}`,
    onInstalled: { addListener() {} },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    lastError: null,
  },
  commands: { onCommand: { addListener() {} } },
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
      if (message.type === "sso:ping") return { ok: true };
      return { ok: true };
    },
  },
  scripting: { async insertCSS() {}, async executeScript() {} },
  webNavigation: { async getAllFrames() { return [{ frameId: 0 }]; } },
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

// 4. Switched on, the last episode's subtitles come off before the search.
await ask({ type: "sso:daemon", op: "autoSiteSet", args: { enabled: true } }, sender);
tabStatusReply = { ok: true, hasVideo: true, attached: true };
sentToTab.length = 0;
await ask({ type: "sso:programme", mark: "2400|Ep 5" }, sender);
t("the last episode's subtitles are taken off first",
  sentToTab.some((m) => m.type === "sso:detach"),
  sentToTab.map((m) => m.type).join(","));

// 5. The same programme reported by every frame is handled once.
sentToTab.length = 0;
await ask({ type: "sso:programme", mark: "2400|Ep 5" }, sender);
t("the same episode is not handled twice",
  !sentToTab.some((m) => m.type === "sso:detach"),
  sentToTab.map((m) => m.type).join(","));

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

// 8. The deck is one storage key, and every writer has to take its turn.
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

chrome.storage.local.get = instant.get;
chrome.storage.local.set = instant.set;

for (const r of results) console.log(r.ok ? "PASS" : "FAIL", "-", r.name, r.ok ? "" : `→ ${r.detail}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
