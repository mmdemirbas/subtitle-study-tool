/* Phrasal verbs: the words a learner cannot look up one at a time.
 *
 * The rarity table answers "is this word rare in film dialogue", and that
 * question cannot see the thing English learners actually get stuck on. "Put up
 * with" is made of three of the commonest words in the language and means
 * something none of them mean; every one of its parts is ranked in the first
 * few hundred, so nothing is ever marked and the reader is left to work out
 * that the three words are one word.
 *
 * So this is a second marking rule beside the first, and it is deliberately the
 * same shape: a table decides WHAT to mark, ranked by how common it is in film
 * dialogue, and the meaning is asked for separately with the line it was said
 * in. What differs is the unit and the repetition rule - see markWords.
 *
 * The matcher is here rather than in the content script for the reason
 * rarity.js gives: the table is fetched once in the service worker instead of
 * once per frame of every tab. It is also imported by tools/build-phrases.mjs,
 * which counts the corpus with the same code that will match against it - a
 * build that ranked phrases its runtime cannot find would produce a table whose
 * order describes nothing.
 */

/* The closed set of particles, and the two entries NOT in it.
 *
 * `to` is missing on purpose. Wiktionary files "have to", "go to", "need to",
 * "talk to" and "get to" as phrasal verbs, and in dialogue they are the
 * infinitive marker or a plain preposition many more times than they are a
 * particle. Measured over the 174 English subtitle files in this machine's
 * cache: five of the eight commonest matches in the whole corpus were
 * `to`-forms, at 1412, 1315, 881, 704 and 539 occurrences, and not one of them
 * is a thing a learner needs pointed out.
 *
 * `into`, `onto` and `upon` stay, because those genuinely form particles
 * ("run into", "hold onto") and are not grammatical machinery. */
export const PARTICLES = [
  "about", "across", "after", "against", "ahead", "along", "apart", "around",
  "aside", "at", "away", "back", "by", "down", "for", "forward", "from", "in",
  "into", "off", "on", "onto", "out", "over", "past", "round", "through",
  "together", "under", "up", "upon", "with",
];

/* Heads that carry grammar rather than meaning. `be on`, `have in`, `do for`
 * and `go to` are the copula and the auxiliaries with a preposition after them,
 * and marking them teaches nobody anything. `get` and `let` are here for the
 * same reason: "get to", "let in" and their relatives were nine of the corpus's
 * commonest matches, all of them structure. */
export const GRAMMAR_HEADS = ["be", "have", "do", "go", "get", "let"];

/* The irregular verbs a phrasal verb is built on, and only those.
 *
 * This is not a complete list of English irregulars and does not need to be: a
 * head verb that never appears in the lexicon costs nothing to omit, and one
 * that does appear has to be findable in every tense a line can use it in.
 * "Gave up", "given up" and "giving up" are the same phrase and a reader who
 * hears one of them has met all three. */
export const IRREGULAR = {
  bear: ["bore", "borne"], beat: ["beat", "beaten"], become: ["became"],
  begin: ["began", "begun"], bend: ["bent"], bet: ["bet"], bite: ["bit", "bitten"],
  blow: ["blew", "blown"], break: ["broke", "broken"], bring: ["brought"],
  build: ["built"], burn: ["burnt"], buy: ["bought"], catch: ["caught"],
  choose: ["chose", "chosen"], come: ["came"], cut: ["cut"], deal: ["dealt"],
  dig: ["dug"], draw: ["drew", "drawn"], drink: ["drank", "drunk"],
  drive: ["drove", "driven"], eat: ["ate", "eaten"], fall: ["fell", "fallen"],
  feed: ["fed"], feel: ["felt"], fight: ["fought"], find: ["found"],
  fly: ["flew", "flown"], forget: ["forgot", "forgotten"], freeze: ["froze", "frozen"],
  give: ["gave", "given"], grow: ["grew", "grown"], hang: ["hung"], hear: ["heard"],
  hide: ["hid", "hidden"], hit: ["hit"], hold: ["held"], keep: ["kept"],
  know: ["knew", "known"], lay: ["laid"], lead: ["led"], leave: ["left"],
  lend: ["lent"], lie: ["lay", "lain"], light: ["lit"], lose: ["lost"],
  make: ["made"], mean: ["meant"], meet: ["met"], pay: ["paid"], put: ["put"],
  read: ["read"], ride: ["rode", "ridden"], ring: ["rang", "rung"],
  rise: ["rose", "risen"], run: ["ran", "run"], say: ["said"], see: ["saw", "seen"],
  sell: ["sold"], send: ["sent"], set: ["set"], shake: ["shook", "shaken"],
  shine: ["shone"], shoot: ["shot"], show: ["showed", "shown"], shut: ["shut"],
  sing: ["sang", "sung"], sit: ["sat"], sleep: ["slept"], speak: ["spoke", "spoken"],
  spend: ["spent"], stand: ["stood"], steal: ["stole", "stolen"], stick: ["stuck"],
  strike: ["struck"], swear: ["swore", "sworn"], sweep: ["swept"],
  take: ["took", "taken"], teach: ["taught"], tear: ["tore", "torn"], tell: ["told"],
  think: ["thought"], throw: ["threw", "thrown"], wake: ["woke", "woken"],
  wear: ["wore", "worn"], win: ["won"], write: ["wrote", "written"],
};

const VOWEL = /[aeiou]/;

/** Every form of a head verb a line can carry, the lemma included. */
export function surfaceForms(verb) {
  const found = new Set([verb]);
  for (const form of IRREGULAR[verb] || []) found.add(form);
  const last = verb.slice(-1);
  const before = verb.slice(-2, -1);

  found.add(
    /(s|sh|ch|x|z)$/.test(verb) ? `${verb}es`
      : last === "y" && !VOWEL.test(before) ? `${verb.slice(0, -1)}ies`
        : `${verb}s`,
  );
  /* No -ed for an irregular. "Putted", "gived" and "telled" are not words, and
   * an index holding them would match a typo rather than a tense. */
  if (!IRREGULAR[verb]) {
    found.add(
      last === "e" ? `${verb}d`
        : last === "y" && !VOWEL.test(before) ? `${verb.slice(0, -1)}ied`
          : `${verb}ed`,
    );
  }
  found.add(last === "e" && verb.length > 2 ? `${verb.slice(0, -1)}ing` : `${verb}ing`);
  return [...found];
}

/** Which phrases each surface form could start. */
export function buildIndex(phrases) {
  const index = new Map();
  phrases.forEach((phrase, rank) => {
    const [verb, ...particles] = phrase.split(" ");
    for (const form of surfaceForms(verb)) {
      if (!index.has(form)) index.set(form, []);
      index.get(form).push({ phrase, particles, rank });
    }
  });
  return index;
}

/* How far the particle may sit from its verb.
 *
 * English separates them: "pick it up", "put the fire out", "turn the whole
 * thing off". Three words is what covers a pronoun, a short noun phrase and an
 * adjective, and stopping there is what keeps "look at the man standing up"
 * from reading as "look up".
 *
 * Only for a single particle. "Put up with" and its relatives are fixed - the
 * object goes after the whole thing - so allowing a gap there would match "put
 * the phone up with the others". */
export const MAX_GAP = 3;

/* ...and what may not be inside it.
 *
 * `to` in the gap means the particle belongs to an infinitive that follows,
 * not to the verb before it. "Do you want to find out" is `find out` with
 * `want` in front of it, and reading it as `want out` puts a mark on two words
 * that are not a phrase and hides the one that is - reported exactly that way.
 *
 * Measured over the 175 English files in this machine's cache: 5178 of 17521
 * matches have something between the verb and its particle, and 214 of those
 * span a `to`. Every one sampled was wrong - "hate to put you on" read as
 * `hate on`, "used to look up" as `use up`, "chance to save people on" as
 * `chance on`.
 *
 * The wider rule this replaces was measured and refused: rejecting a gap that
 * merely CONTAINS another verb able to take the same particle would have
 * thrown away 758 matches including "shut the fuck up" and "take your hands
 * off", which are both right. A gap may hold anything except the one word that
 * changes whose particle it is. */
const NOT_IN_GAP = "to";

/**
 * The phrasal verbs in one line's words, left to right and never overlapping.
 *
 * `words` are already folded to lower case by the caller, which is the same
 * folding the rarity path uses - see the note in study.js about Turkish. Each
 * hit carries where it starts and how many words it covers, because the overlay
 * has to mark those words and not the phrase's dictionary form.
 */
export function findPhrases(words, index) {
  const found = [];
  for (let at = 0; at < words.length; at++) {
    let best = null;
    for (const { phrase, particles, rank } of index.get(words[at]) || []) {
      const gaps = particles.length === 1 ? MAX_GAP : 0;
      for (let gap = 0; gap <= gaps; gap++) {
        let matched = true;
        for (let step = 0; step < particles.length; step++) {
          if (words[at + 1 + gap + step] !== particles[step]) {
            matched = false;
            break;
          }
        }
        if (!matched) continue;
        /* The gap is the words between the verb and its first particle. A `to`
         * in there hands the particle to the infinitive after it. */
        let infinitive = false;
        for (let step = 1; step <= gap; step++) {
          if (words[at + step] === NOT_IN_GAP) infinitive = true;
        }
        if (infinitive) continue;
        const span = 1 + gap + particles.length;
        /* The longest phrase wins, and among equals the tightest one. "Put up
         * with" beats "put up" on the same three words, and "pick up" beats
         * "pick up" found three words later. */
        if (!best || particles.length > best.particles || span < best.span) {
          /* Which words are the phrase, not which words it spans. "Pick it up"
           * is two words of phrase with an object sitting between them, and the
           * overlay must not underline the object - a reader shown "pick it up"
           * as one mark learns that the pronoun is part of it. */
          const own = [at];
          for (let step = 0; step < particles.length; step++) {
            own.push(at + 1 + gap + step);
          }
          best = { phrase, at, span, rank, particles: particles.length, words: own };
        }
        break;
      }
    }
    if (best) {
      found.push({
        phrase: best.phrase, at: best.at, span: best.span, rank: best.rank, words: best.words,
      });
      at += best.span - 1;
    }
  }
  return found;
}

/* --- the table, loaded once in the worker -----------------------------------
 *
 * Fetched as text rather than imported, and lazily, for the two reasons
 * rarity.js gives at length: dynamic import is disallowed on a service worker's
 * global scope, and most sessions never turn study mode on.
 *
 * One language ships a table. A phrasal verb is an English problem - the
 * construction barely exists in Turkish - so `phrasesIn` answers with nothing
 * for anything else rather than pretending the question applies. */
export const SUPPORTED = ["en"];

let index = null;
let loading = null;

async function table() {
  if (index) return index;
  if (!loading) {
    loading = load()
      .then((built) => {
        index = built;
        return built;
      })
      /* Not remembered as a failure. A table that ships and will not load is a
       * defect rather than a fact about the language, and the next cue asking
       * again costs one fetch instead of the session. */
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

async function load() {
  const url = chrome.runtime.getURL("src/study/phrases-en.generated.txt");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`phrase table: HTTP ${response.status}`);
  const phrases = (await response.text()).split("\n");
  if (phrases[phrases.length - 1] === "") phrases.pop();
  if (phrases.length === 0) throw new Error("the phrase table is empty");
  return buildIndex(phrases);
}

/**
 * The phrasal verbs in one line, with where each sits and how common it is.
 *
 * Crosses a message boundary, so plain objects only. `rank` is the line number
 * in the table, which is commonest-first - so a larger rank is a phrase the
 * reader is less likely to have met, and `null` never happens here because
 * everything matched came out of the table.
 */
export async function phrasesIn(words, language) {
  const lang = String(language || "").toLowerCase().slice(0, 2);
  if (!SUPPORTED.includes(lang)) return [];
  return findPhrases(words, await table());
}

/**
 * The same question for a whole film, in one message.
 *
 * `glossAhead` walks every line at attach so a meaning is a disk read by the
 * time it is needed, and asking per line would be five hundred round trips to
 * the worker for a file. The table is loaded once either way; what this saves
 * is the messages.
 */
export async function phrasesInLines(lines, language) {
  const lang = String(language || "").toLowerCase().slice(0, 2);
  if (!SUPPORTED.includes(lang)) return lines.map(() => []);
  const index = await table();
  return lines.map((words) => findPhrases(words, index));
}
