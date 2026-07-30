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

# Symbols for the sounds that recur. Keys are matched against the annotation
# text word by word, longest phrase first, so "breathing heavily" beats
# "breathing". Kept to sounds that genuinely repeat - a symbol nobody sees
# twice teaches nothing and only adds noise.
_SOUND_SYMBOLS: dict[str, str] = {
    # breath and voice
    "sighs": "😮‍💨", "sigh": "😮‍💨", "exhales": "😮‍💨", "inhales": "😤",
    "breathing heavily": "😮‍💨", "panting": "😮‍💨", "gasps": "😲",
    "chuckles": "😄", "laughs": "😂", "laughing": "😂", "giggles": "😄",
    "cries": "😢", "crying": "😢", "sobs": "😭", "sniffles": "😢",
    "groans": "😣", "grunts": "😣", "moans": "😣", "screams": "😱",
    "shouts": "🗯️", "yells": "🗯️", "whispers": "🤫", "whispering": "🤫",
    "coughs": "😷", "clears throat": "😗", "sneezes": "🤧", "snoring": "😴",
    "grumbles": "😒", "scoffs": "😒", "stammers": "😬", "stutters": "😬",
    # speech that is present but not transcribed
    "indistinct chatter": "💬", "indistinct": "💬", "chatter": "💬",
    "chattering": "💬", "murmuring": "💬", "muttering": "💬",
    "speaking indistinctly": "💬", "overlapping dialogue": "💬",
    "in foreign language": "🌐", "speaking foreign language": "🌐",
    # people and crowds
    "applause": "👏", "clapping": "👏", "cheering": "🎉", "crowd": "👥",
    "footsteps": "👣", "knocking": "🚪", "knock": "🚪", "door opens": "🚪",
    "door closes": "🚪", "door creaks": "🚪",
    # machines and places
    "phone ringing": "📞", "phone rings": "📞", "ringing": "🔔", "beeping": "🔔",
    "alarm": "🚨", "siren": "🚨", "sirens": "🚨", "engine": "🚗",
    "car horn": "📣", "horn honking": "📣", "tires screeching": "🚗",
    "helicopter": "🚁", "train": "🚆", "airplane": "✈️", "elevator dings": "🛗",
    "typing": "⌨️", "camera shutter": "📷", "static": "📻", "radio": "📻",
    "tv": "📺", "clock ticking": "🕰️",
    # violence and impact
    "gunshot": "🔫", "gunshots": "🔫", "gunfire": "🔫", "explosion": "💥",
    "explodes": "💥", "crash": "💥", "crashing": "💥", "thud": "💥",
    "glass shattering": "🔨", "glass breaks": "🔨", "punch": "👊",
    "grunting": "😣", "struggling": "😣",
    # weather and nature
    "thunder": "⛈️", "rain": "🌧️", "wind": "💨", "waves": "🌊",
    "birds chirping": "🐦", "dog barking": "🐕", "dog barks": "🐕",
    "barking": "🐕", "cat meows": "🐈", "horse whinnies": "🐴",
    "insects buzzing": "🦟",
    # music
    "music": "🎵", "music playing": "🎵", "dramatic music": "🎬",
    "tense music": "🎬", "ominous music": "🎬", "upbeat music": "🎶",
    "soft music": "🎶", "singing": "🎤", "humming": "🎶",
    "theme music": "🎵", "music fades": "🎵", "song": "🎵",
}

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
    if lowered in _SOUND_SYMBOLS or _SOUND_HINTS.search(lowered):
        # "[Ormon sighs]" names someone but describes a sound; sound wins,
        # because that is what is being conveyed.
        return MUSIC if _is_music(lowered) else SOUND

    if followed_by_speech:
        return SPEAKER

    # A bare capitalised name as the entire cue is still a speaker label - it
    # happens when the dialogue is on the following line.
    if inner[:1].isupper() and len(inner.split()) <= 3:
        return SPEAKER
    return SOUND


def symbol_for(text: str) -> str | None:
    """A symbol for an annotation, or None when nothing fits.

    Longest phrase first, so "breathing heavily" is not answered by
    "breathing", and "dramatic music" is not answered by "music".
    """
    lowered = _normalise(text)
    if not lowered:
        return None

    for phrase in sorted(_SOUND_SYMBOLS, key=len, reverse=True):
        if re.search(rf"\b{re.escape(phrase)}\b", lowered):
            return _SOUND_SYMBOLS[phrase]
    return None


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
