"""Speaker labels, sound descriptions and music markers inside cue text.

Caption files are not only dialogue. The subtitles this tool downloaded carry
47 `[Ormon]`, 30 `[sighs]`, 13 `[indistinct chatter]` - speaker attributions
and sound descriptions, mixed into the same line as speech. Rendered flat they
compete with the dialogue for attention; the reader has to parse brackets to
work out what is being said and what is being described.

So they are classified here and handed to the renderer as their own runs:

- **speaker** - who is talking. Coloured, so a conversation is followable at a
  glance without reading the name every time.
- **sound** - what is heard. Dimmed, because it is context rather than speech,
  and given a symbol where one fits.
- **music** - lyrics and score, marked in the wild with note characters.

The symbol matters beyond decoration. Seeing the same glyph next to "sighs"
every time attaches meaning to the word faster than reading it does, which is
the point when the subtitles are being used to learn the language.

Classification is a heuristic over two signals: a lexicon of sound words, and
whether dialogue follows in the same cue. `[Ormon] Get down!` has speech after
it and no lexicon hit, so it is a speaker. `[sighs]` stands alone and hits the
lexicon, so it is a sound. `[yoga instructor] Breathe.` has no lexicon hit and
is followed by speech, so it is a speaker despite being lowercase.
"""

from __future__ import annotations

import re
import unicodedata

SPEAKER = "speaker"
SOUND = "sound"
MUSIC = "music"

# Two-word phrases whose meaning is not the sum of their parts, so they have to
# be checked before the single-word table. "clears throat" is not "throat";
# "car horn" is not "car".
_PHRASE_SYMBOLS: dict[str, str] = {
    "clears throat": "😗", "clear throat": "😗",
    "car horn": "📣", "horn honk": "📣",
    "glass shatter": "🔨", "glass break": "🔨",
    "over phone": "📞", "over radio": "📻", "over pa": "📢", "over intercom": "📢",
    "foreign language": "🌐", "speaking foreign": "🌐",
    "alarm clock": "⏰",
    "heart beat": "💓", "heart monitor": "💓",
}

# Stems, not words. A token matches a stem when it starts with it and the
# remainder is a plausible inflection - so one entry covers "click", "clicks",
# "clicked" and "clicking" without any of them being listed.
#
# This replaced an exhaustive word list, which was never going to be finishable:
# caption houses write "exhales deeply", "exhales sharply", "suspenseful music
# continuing", and any list is one adverb behind.
_STEM_SYMBOLS: dict[str, str] = {
    # breath and voice
    "sigh": "😮‍💨", "exhal": "😮‍💨", "breath": "😮‍💨", "pant": "😮‍💨", "puff": "😮‍💨",
    "inhal": "😤", "gasp": "😲", "yawn": "🥱", "gulp": "😬", "swallow": "😬",
    "chuckl": "😄", "laugh": "😂", "giggl": "😄", "snicker": "😄", "chortl": "😄",
    "cry": "😢", "cries": "😢", "sob": "😭", "sniffl": "😢", "whimper": "😢", "weep": "😢",
    "groan": "😣", "grunt": "😣", "moan": "😣", "wince": "😣", "strain": "😣",
    "scream": "😱", "shriek": "😱", "yell": "🗯️", "shout": "🗯️", "holler": "🗯️",
    "whisper": "🤫", "hush": "🤫",
    "cough": "😷", "sneez": "🤧", "snor": "😴", "wheez": "😷", "spit": "😖",
    "scoff": "😒", "grumbl": "😒", "huff": "😒", "sigh": "😮‍💨", "tut": "😒",
    "stammer": "😬", "stutter": "😬", "sputter": "😬",
    "growl": "😾", "snarl": "😾", "roar": "🦁", "hiss": "🐍",
    # speech present but not transcribed
    "chatter": "💬", "indistinct": "💬", "murmur": "💬", "mutter": "💬", "mumbl": "💬",
    "chat": "💬", "talk": "💬", "speak": "💬", "voice": "💬", "dialogue": "💬",
    "conversation": "💬", "arguing": "💬", "argu": "💬", "shush": "🤫",
    # people
    "applau": "👏", "clap": "👏", "cheer": "🎉", "crowd": "👥", "audience": "👥",
    "footstep": "👣", "step": "👣", "walk": "👣", "run": "🏃", "shuffl": "👣",
    "baby": "👶", "infant": "👶", "child": "👧", "kid": "👧",
    # doors, buildings, objects
    "knock": "🚪", "door": "🚪", "creak": "🚪", "slam": "🚪", "lock": "🔒", "key": "🔑",
    "glass": "🔨", "shatter": "🔨", "smash": "🔨", "break": "🔨",
    "paper": "📄", "rustl": "📄", "page": "📄",
    "elevator": "🛗", "toilet": "🚽", "flush": "🚽", "faucet": "🚰",
    # machines and signals
    "click": "🔘", "clink": "🔘", "clank": "🔗", "rattl": "🔗", "jingl": "🔑",
    "buzz": "📳", "vibrat": "📳", "beep": "🔔", "ring": "🔔", "ding": "🔔",
    "chime": "🔔", "bell": "🔔", "alarm": "🚨", "siren": "🚨", "alert": "🚨",
    "phone": "📞", "cell": "📞", "telephon": "📞", "dial": "📞",
    "notification": "📱", "text": "📱", "message": "📱",
    "typ": "⌨️", "keyboard": "⌨️", "camera": "📷", "shutter": "📷",
    "static": "📻", "radio": "📻", "televis": "📺", "screen": "📺",
    "clock": "🕰️", "tick": "🕰️", "whir": "⚙️", "machin": "⚙️", "motor": "⚙️",
    "electric": "⚡", "spark": "⚡", "zap": "⚡",
    # vehicles
    "engine": "🚗", "car": "🚗", "tire": "🚗", "brake": "🚗", "truck": "🚚",
    "horn": "📣", "honk": "📣", "helicopter": "🚁", "chopper": "🚁",
    "train": "🚆", "airplane": "✈️", "plane": "✈️", "jet": "✈️", "boat": "🚢", "ship": "🚢",
    # violence
    "gunshot": "🔫", "gunfire": "🔫", "gun": "🔫", "shot": "🔫", "shoot": "🔫",
    "explo": "💥", "blast": "💥", "boom": "💥", "bang": "💥", "crash": "💥",
    "thud": "💥", "thump": "💥", "clatter": "💥", "impact": "💥",
    "punch": "👊", "hit": "👊", "kick": "🦵", "struggl": "😣", "fight": "🥊",
    "grunt": "😣", "stab": "🔪", "knife": "🔪",
    # weather and nature
    "thunder": "⛈️", "storm": "⛈️", "lightning": "⚡", "rain": "🌧️", "drizzl": "🌧️",
    "wind": "💨", "whoosh": "💨", "breeze": "💨", "wave": "🌊", "water": "💧",
    "splash": "💦", "drip": "💧", "fire": "🔥", "flame": "🔥", "burn": "🔥",
    "bird": "🐦", "chirp": "🐦", "dog": "🐕", "bark": "🐕", "growl": "😾",
    "cat": "🐈", "meow": "🐈", "horse": "🐴", "whinn": "🐴", "insect": "🦟",
    # music
    "music": "🎵", "song": "🎵", "melody": "🎵", "tune": "🎵", "theme": "🎵",
    "sing": "🎤", "hum": "🎶", "whistl": "🎶", "guitar": "🎸", "piano": "🎹",
    "drum": "🥁", "orchestra": "🎻", "violin": "🎻",
    # body
    "heartbeat": "💓", "pulse": "💓", "footfall": "👣",
    # added after measuring against a corpus of 8 subtitles; each of these
    # occurred in real caption files and was going unmatched
    "explosion": "💥", "explod": "💥", "detonat": "💥",
    "whine": "📢", "whin": "📢", "feedback": "📢", "screech": "🚗",
    "clamor": "👥", "clamour": "👥", "commotion": "👥", "chant": "👥",
    "ringtone": "📱", "dialtone": "📞",
    "pray": "🙏", "plead": "🙏", "beg": "🙏",
    "echo": "🔊", "reverberat": "🔊", "rumbl": "🌋", "creaking": "🚪",
    "cackl": "😈", "snort": "😄", "sniff": "😢", "gag": "🤢", "retch": "🤢",
    "riff": "🎸", "strum": "🎸", "cymbal": "🥁", "trumpet": "🎺", "sax": "🎷",
    "applaud": "👏", "knuckle": "👊", "crack": "💥",
    "revv": "🚗", "rev": "🚗", "accelerat": "🚗",
    "zipper": "🤐", "clatter": "🍽️", "sizzl": "🍳", "boil": "🍳",
    "gunfight": "🔫", "reload": "🔫", "cock": "🔫",
    "wail": "😭", "howl": "🐺", "squeal": "🐷", "buzzer": "🔔",
    "band": "🎵", "stereo": "🔊", "speaker": "🔊", "headphone": "🎧",
    "whoop": "🎉", "exclaim": "🗯️", "inaudible": "💬", "hoot": "🦉",
}

# Genre words that turn a music cue into a scored-moment cue. "suspenseful
# music continuing" is not the same information as "music".
_MUSIC_MOOD = {
    "dramatic", "tense", "ominous", "suspenseful", "suspense", "eerie", "sinister",
    "somber", "melancholy", "sad", "haunting", "foreboding", "unsettling",
}
_MUSIC_UPBEAT = {"upbeat", "cheerful", "lively", "playful", "jaunty", "triumphant"}

# Unnamed speakers. Caption houses attribute lines to a role when the character
# has no name, and these are speakers however the position heuristic reads.
# Measured: the corpus carried [girl] x6, [man] x5, [boy] x2, [woman] x2,
# [all] x2, [lawyer] x2, none of which is a sound.
_GENERIC_SPEAKERS = frozenset(
    """man woman boy girl child kid guy lady gentleman
    all both together everyone
    narrator announcer reporter anchor host interviewer interpreter translator
    operator dispatcher officer doctor nurse teacher lawyer judge waiter driver
    pilot soldier guard clerk cashier receptionist agent
    computer automated recording""".split()
)

# Words that mark an annotation as a description of sound rather than a name,
# even when they are not in the symbol table. Mostly present-participle verbs,
# which is how caption houses write them.
_SOUND_HINTS = re.compile(
    r"""\b(
        sighs?|gasps?|laughs?|chuckl\w+|cries|sobs?|groans?|grunts?|moans?
      | screams?|shouts?|yells?|whispers?|coughs?|sneezes?|snor\w+|scoffs?
      | speaking|speaks|voice|voices|chatter\w*|murmur\w*|mutter\w*|indistinct
      | music|singing|sings|humming|song|theme
      | ring\w*|beep\w*|buzz\w*|click\w*|clank\w*|creak\w*|rattl\w*|rustl\w*
      | bang\w*|crash\w*|thud\w*|explo\w+|gunshots?|gunfire|shot|shots
      | footsteps?|knock\w*|door|engine|siren|alarm|horn|tires?|brakes?
      | thunder|rain|wind|waves|barking|barks|meows|chirping
      | continues|fades?|stops|distant|muffled|echoing|static|silence
      | dings?|dinging|pants|panting|clicks?|buzzes|whirs?|hums?
      | applause|clapping|cheer\w*|panting|breathing|inhal\w+|exhal\w+
      | over\s+(?:phone|radio|pa|intercom|speaker)
    )\b""",
    re.IGNORECASE | re.VERBOSE,
)

# Bracketed or parenthesised spans. Square brackets dominate; parentheses are
# used by some caption houses for the same purpose.
_ANNOTATION = re.compile(r"\[([^\[\]\n]{1,80})\]|\(([^()\n]{1,80})\)")

# Music is marked with note characters rather than brackets, often unpaired.
_MUSIC_MARK = re.compile(r"[♪♫🎵🎶]")

# A trailing colon is how a speaker label is written without brackets:
# "SHARON: Get down!". Only recognised at the start of a line, in caps or
# title case, to avoid eating ordinary punctuation.
_BARE_SPEAKER = re.compile(r"^\s*([A-Z][A-Za-z0-9 .'À-ɏ-]{0,28}):\s")

# Colours for speaker names. Chosen to stay legible on a dark, semi-transparent
# subtitle backdrop over arbitrary video, and to remain distinguishable for the
# most common forms of colour blindness - no red/green pairing.
# Every annotation is coloured, not only the ones we can attribute to a person.
# A bracket is never ordinary speech, and saying so with hue is faster to read
# than dimming alone - dimming says "less important", colour says "different
# kind of thing". Named speakers then get their own hues out of the palette
# below, so identity reads on top of that distinction.
SOUND_COLOR = "#9fb8cc"  # cool slate: heard, not said
MUSIC_COLOR = "#c0a9e6"  # violet: scored, not spoken

SPEAKER_PALETTE = (
    "#7fb4ff",  # blue
    "#ffc857",  # amber
    "#8fe3a1",  # green
    "#ff9ecb",  # pink
    "#9ad9e0",  # cyan
    "#d3b3ff",  # violet
    "#ffb08a",  # orange
    "#e0e0a0",  # sand
)


def classify(text: str, *, followed_by_speech: bool) -> str:
    """Decide what a bracketed annotation is.

    `followed_by_speech` is the tiebreaker that no amount of word matching
    replaces: a label with dialogue after it is almost always naming who says
    it, and a bracket standing alone as the whole cue is almost always
    describing a sound.
    """
    inner = text.strip()
    if not inner:
        return SOUND
    if _MUSIC_MARK.search(inner):
        return MUSIC

    lowered = inner.lower()

    # A role in place of a name. "[man]", "[girl]", "[all]" attribute a line to
    # someone unnamed, and are speakers regardless of what follows.
    words = [word for word in re.split(r"[^\w]+", lowered) if word]
    if words and all(word in _GENERIC_SPEAKERS for word in words):
        return SPEAKER

    # A single capitalised word is a name until something says otherwise.
    # Without this guard a character called Bell, Rain or Fox is classified as
    # a doorbell, weather and wildlife respectively, because those are all real
    # sound stems.
    looks_like_a_name = (
        len(inner.split()) == 1 and inner[:1].isupper() and not _SOUND_HINTS.search(lowered)
    )

    if not looks_like_a_name and (_SOUND_HINTS.search(lowered) or symbol_for(inner)):
        # "[Ormon sighs]" names someone but describes a sound; sound wins,
        # because the sound is what is being conveyed.
        return MUSIC if _is_music(lowered) else SOUND

    if followed_by_speech:
        return SPEAKER

    # A bare capitalised name as the entire cue is still a speaker label - it
    # happens when the dialogue is on the following line.
    if inner[:1].isupper() and len(inner.split()) <= 3:
        return SPEAKER
    return SOUND


# Adverbs and aspect markers that describe *how much* or *when*, never *what*.
# Dropping them is what lets one stem cover "exhales", "exhales deeply" and
# "exhales sharply" without listing each.
_MODIFIERS = frozenset(
    """deeply sharply heavily softly loudly quietly slowly quickly gently harshly
    faintly slightly briefly again still continuing continues continue continued
    fading fades fade stopping stops stopped starting starts playing plays play
    distant distantly nearby muffled echoing faint low high soft loud
    indistinctly quietly repeatedly rapidly suddenly gradually
    the a an of in on at to and or over via through from with""".split()
)

# What may follow a stem for the token to count as an inflection of it. Without
# this, the stem "car" would match "carpet". The second alternative covers
# doubled consonants: thud -> thudding.
_VERB_INFLECTION = re.compile(
    r"^(?:s|es|ed|d|e|ing|ings|er|ers|y|ies|ly)?$|^[bcdfghjklmnpqrstvwxz](?:ing|ed)$"
)

# Nouns take only a plural. Allowing verb endings on them is not a theoretical
# problem: "train" + "ing" is a perfectly good inflection, so "training
# montage" was matching as a locomotive. Same shape for "caring" as a car,
# "winding" as weather and "boating" as a boat.
_NOUN_INFLECTION = re.compile(r"^(?:s|es|'s)?$")

# Entries that name a thing rather than an action. Everything else in the table
# is a verb and inflects freely.
_NOUN_STEMS = frozenset(
    """train car truck boat ship jet plane airplane helicopter chopper tire brake
    engine motor machin key keyboard page paper screen televis radio static camera
    phone cell telephon notification message text clock bell alarm siren alert
    door glass elevator toilet faucet lock
    cat dog bird horse insect baby infant child kid crowd audience voice dialogue
    conversation footstep footfall heartbeat pulse
    music song melody tune theme guitar piano drum orchestra violin
    water wind rain storm lightning fire flame wave
    gun gunshot gunfire knife""".split()
)


def symbol_for(text: str) -> str | None:
    """A symbol for an annotation, or None when nothing fits.

    Matching is by stem rather than by word, so the table does not have to
    anticipate every inflection a caption house writes. Order of attempts:

    1. Two-word phrases whose meaning is not the sum of their parts.
    2. Music, where a mood word changes the answer - "suspenseful music" is a
       different signal from "music".
    3. Single tokens, left to right, after modifiers are removed. Caption style
       puts the subject first ("phone dings", "door creaks"), so the leftmost
       match is usually the informative one.

    Returning None is a normal outcome. A wrong symbol is worse than none: the
    whole point is that seeing the same glyph teaches the word.
    """
    # Phrases are matched before modifiers are stripped: several of them lead
    # with a word that is a modifier elsewhere. "OVER PA" was invisible when
    # this ran after stripping, because "over" had already gone.
    raw_tokens = _all_tokens(text)
    for index in range(len(raw_tokens) - 1):
        for phrase, symbol in _PHRASE_SYMBOLS.items():
            if _phrase_matches(phrase, raw_tokens[index], raw_tokens[index + 1]):
                return symbol

    tokens = _content_tokens(text)
    if not tokens:
        return None

    if any(_matches_stem(token, "music") or _matches_stem(token, "theme") for token in tokens):
        if any(token in _MUSIC_MOOD for token in tokens):
            return "🎬"
        if any(token in _MUSIC_UPBEAT for token in tokens):
            return "🎶"

    for token in tokens:
        symbol = _lookup(token)
        if symbol:
            return symbol
    return None


def _all_tokens(text: str) -> list[str]:
    return [word for word in re.split(r"[^\w']+", _normalise(text)) if word]


def _content_tokens(text: str) -> list[str]:
    """Words that carry meaning: normalised, with modifiers removed."""
    words = _all_tokens(text)
    kept = [word for word in words if word not in _MODIFIERS]
    # If a description is nothing but modifiers, keep them rather than matching
    # on an empty list.
    return kept or words


def _lookup(token: str) -> str | None:
    # Longest stem first, so "gunshot" is not answered by "gun", and
    # "footstep" is not answered by "step".
    for stem in sorted(_STEM_SYMBOLS, key=len, reverse=True):
        if _matches_stem(token, stem):
            return _STEM_SYMBOLS[stem]
    return None


def _matches_stem(token: str, stem: str) -> bool:
    if not token.startswith(stem):
        return False
    pattern = _NOUN_INFLECTION if stem in _NOUN_STEMS else _VERB_INFLECTION
    return bool(pattern.match(token[len(stem) :]))


def _phrase_matches(phrase: str, first: str, second: str) -> bool:
    left, right = phrase.split(" ", 1)
    return _matches_stem(first, left) and _matches_stem(second, right)


def speaker_color(name: str) -> str:
    """A stable colour for a speaker name.

    Deterministic, so the same character keeps the same colour across cues,
    across sessions and between the overlay and the study viewer. Case and
    accents are folded first, so "SHARON" and "Sharon" do not diverge.
    """
    key = _normalise(name)
    # Small deterministic hash. Not security-relevant; Python's own hash() is
    # salted per process and would change colours between runs.
    digest = 0
    for char in key:
        digest = (digest * 31 + ord(char)) & 0xFFFFFFFF
    return SPEAKER_PALETTE[digest % len(SPEAKER_PALETTE)]


def find_annotations(text: str) -> list[tuple[int, int, str, str]]:
    """Locate annotations in cue text.

    Returns (start, end, kind, inner_text) spans, in order. Includes bracketed
    spans, note-marked music, and bare `NAME:` speaker prefixes.
    """
    found: list[tuple[int, int, str, str]] = []

    for match in _ANNOTATION.finditer(text):
        inner = match.group(1) if match.group(1) is not None else match.group(2)
        rest = text[match.end() :].strip()
        # Speech after it, on this line or the next, means a speaker label.
        followed = bool(rest) and not rest.startswith(("[", "("))
        found.append((match.start(), match.end(), classify(inner, followed_by_speech=followed), inner))

    bare = _BARE_SPEAKER.match(text)
    if bare and not any(start <= bare.start(1) < end for start, end, _, _ in found):
        found.append((bare.start(1), bare.end(1) + 1, SPEAKER, bare.group(1)))

    for match in _MUSIC_MARK.finditer(text):
        if not any(start <= match.start() < end for start, end, _, _ in found):
            found.append((match.start(), match.end(), MUSIC, match.group(0)))

    found.sort(key=lambda span: span[0])
    return found


def _is_music(lowered: str) -> bool:
    return bool(re.search(r"\b(music|singing|sings|song|humming|theme)\b", lowered))


def _normalise(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text or "")
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", stripped.casefold()).strip()
