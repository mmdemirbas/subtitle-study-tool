"""Inline markup in subtitle text.

Subtitles carry formatting in several dialects at once, and a renderer that
prints the raw string shows the reader `<i>` and `{\\an8}` as if they were
dialogue. This turns a cue into styled runs the caller can render safely.

Three dialects appear in practice:

- HTML-ish: ``<i>``, ``<b>``, ``<u>``, ``<s>``, ``<font color="#ff0">``.
  By far the most common - the files in this repo use ``<i>`` and nothing else.
- Forum / BBCode: ``[i]``, ``[b]``, ``[u]``, ``[s]``, ``[color=red]``.
- SubStation overrides: ``{\\i1}`` … ``{\\i0}``, ``{\\an8}``, ``{\\pos(..)}``,
  and the older ``{y:i}`` form.

**Square brackets need care.** In real subtitles they are far more often
speaker labels and sound descriptions than markup: a caption file sampled here
contained 47 ``[Ormon]``, 30 ``[sighs]`` and 13 ``[indistinct chatter]``
against zero BBCode tags. So only the exact known tags are recognised;
everything else in brackets is dialogue and passes through untouched.

The output is a list of runs - flat spans of text plus the styles covering
them - rather than a string of markup. That way the caller builds DOM nodes and
sets text content, and no subtitle can inject markup into the page. Nesting is
flattened, since runs carry a set of styles rather than a tree.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import annotations

# Styles a run can carry. Deliberately small: these are the ones subtitles
# actually use, and each maps onto something a renderer can express safely.
ITALIC = "i"
BOLD = "b"
UNDERLINE = "u"
STRIKE = "s"

_TAG_NAMES = {
    "i": ITALIC,
    "em": ITALIC,
    "b": BOLD,
    "strong": BOLD,
    "u": UNDERLINE,
    "s": STRIKE,
    "strike": STRIKE,
    "del": STRIKE,
}

# Colour is the one attribute worth honouring - subtitles use it to tell
# speakers apart - but it lands in a style attribute, so it is validated
# strictly rather than passed through. Hex, or a name from the CSS list.
_HEX_COLOR = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_NAMED_COLORS = frozenset(
    """aqua aquamarine azure beige black blue brown chartreuse chocolate coral crimson cyan
    darkblue darkcyan darkgray darkgreen darkgrey darkmagenta darkorange darkred darkviolet
    deeppink dodgerblue firebrick fuchsia gold goldenrod gray green grey hotpink indigo ivory
    khaki lavender lightblue lightcyan lightgray lightgreen lightgrey lightpink lightyellow
    lime limegreen magenta maroon navy olive orange orangered orchid pink plum purple red
    salmon sandybrown seagreen sienna silver skyblue slateblue snow springgreen steelblue tan
    teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen""".split()
)

# SubStation \anN alignment. Only the vertical band matters to a renderer that
# centres horizontally: 7-9 are top, 4-6 middle, 1-3 bottom.
_VERTICAL_BY_ALIGNMENT = {
    1: "bottom", 2: "bottom", 3: "bottom",
    4: "middle", 5: "middle", 6: "middle",
    7: "top", 8: "top", 9: "top",
}

_TOKEN = re.compile(
    r"""
      (?P<html_open><\s*(?P<html_open_name>i|em|b|strong|u|s|strike|del)\s*>)
    | (?P<html_close><\s*/\s*(?P<html_close_name>i|em|b|strong|u|s|strike|del)\s*>)
    | (?P<font><\s*font\b(?P<font_attrs>[^>]*)>)
    | (?P<font_close><\s*/\s*font\s*>)
    | (?P<bb_open>\[(?P<bb_open_name>i|b|u|s)\])
    | (?P<bb_close>\[/(?P<bb_close_name>i|b|u|s)\])
    | (?P<bb_color>\[color\s*=\s*(?P<bb_color_value>[^\]]{1,32})\])
    | (?P<bb_color_close>\[/color\])
    | (?P<ssa>\{\\(?P<ssa_body>[^}]{0,200})\})
    | (?P<legacy>\{\s*y\s*:\s*(?P<legacy_body>[ibus]{1,4})\s*\})
    """,
    # Case-insensitive because `<I>` and `{Y:i}` both occur in the wild. This
    # also makes `[I]` a tag, which is a trade worth making: a bracketed single
    # letter is not a speaker label, and uppercase italics are real.
    re.VERBOSE | re.IGNORECASE,
)

_ANNOTATION_COLORS = {
    annotations.SOUND: annotations.SOUND_COLOR,
    annotations.MUSIC: annotations.MUSIC_COLOR,
}

_FONT_COLOR = re.compile(r"""\bcolor\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""", re.IGNORECASE)
_SSA_STYLE = re.compile(r"([ibus])([01])")
_SSA_ALIGN = re.compile(r"an([1-9])\b")


@dataclass(frozen=True)
class Run:
    """A span of text, the styles covering it, and what kind of text it is."""

    text: str
    styles: frozenset[str] = frozenset()
    color: str | None = None
    # None for dialogue; otherwise "speaker", "sound" or "music". See
    # annotations.py for how these are told apart and why it matters.
    kind: str | None = None
    symbol: str | None = None

    def as_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {"text": self.text}
        if self.styles:
            payload["styles"] = sorted(self.styles)
        if self.color:
            payload["color"] = self.color
        if self.kind:
            payload["kind"] = self.kind
        if self.symbol:
            payload["symbol"] = self.symbol
        return payload


@dataclass(frozen=True)
class Parsed:
    """A cue's text, once markup has been separated from dialogue."""

    runs: list[Run] = field(default_factory=list)
    vertical: str | None = None  # "top" | "middle" | "bottom", from {\anN}

    @property
    def plain(self) -> str:
        return "".join(run.text for run in self.runs)

    def as_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {"runs": [run.as_dict() for run in self.runs]}
        if self.vertical:
            payload["vertical"] = self.vertical
        return payload


def parse(text: str) -> Parsed:
    """Split cue text into styled runs, discarding markup the renderer cannot use."""
    runs: list[Run] = []
    # Counters rather than booleans: nested or repeated open tags are common,
    # and a single closing tag should not cancel two levels of italics.
    depth: dict[str, int] = {ITALIC: 0, BOLD: 0, UNDERLINE: 0, STRIKE: 0}
    # A stack, so a closing tag restores the enclosing colour. Entries may be
    # None: a colour that failed validation still needs a slot, or its closing
    # tag would pop somebody else's.
    colors: list[str | None] = []
    vertical: str | None = None
    buffer: list[str] = []

    def current_color() -> str | None:
        return colors[-1] if colors else None

    def push_color(value: str | None) -> None:
        # An unusable colour inherits whatever was already in effect rather
        # than blanking it.
        colors.append(value or current_color())

    def flush() -> None:
        if not buffer:
            return
        chunk = "".join(buffer)
        buffer.clear()
        active = frozenset(name for name, count in depth.items() if count > 0)
        runs.append(Run(text=chunk, styles=active, color=current_color()))

    position = 0
    for match in _TOKEN.finditer(text):
        buffer.append(text[position : match.start()])
        position = match.end()

        if match.group("html_open"):
            flush()
            depth[_TAG_NAMES[match.group("html_open_name").lower()]] += 1
        elif match.group("html_close"):
            flush()
            name = _TAG_NAMES[match.group("html_close_name").lower()]
            depth[name] = max(0, depth[name] - 1)
        elif match.group("bb_open"):
            flush()
            depth[_TAG_NAMES[match.group("bb_open_name").lower()]] += 1
        elif match.group("bb_close"):
            flush()
            name = _TAG_NAMES[match.group("bb_close_name").lower()]
            depth[name] = max(0, depth[name] - 1)
        elif match.group("font"):
            flush()
            push_color(_safe_color(_font_color(match.group("font_attrs"))))
        elif match.group("font_close") or match.group("bb_color_close"):
            flush()
            if colors:
                colors.pop()
        elif match.group("bb_color"):
            flush()
            push_color(_safe_color(match.group("bb_color_value")))
        elif match.group("ssa"):
            flush()
            body = match.group("ssa_body")
            for name, state in _SSA_STYLE.findall(body):
                mapped = _TAG_NAMES[name]
                depth[mapped] = depth[mapped] + 1 if state == "1" else max(0, depth[mapped] - 1)
            align = _SSA_ALIGN.search(body)
            if align:
                vertical = _VERTICAL_BY_ALIGNMENT[int(align.group(1))]
            # Everything else in an override block - \pos, \fad, \c, \blur - is
            # positioning or effects this renderer does not implement. Dropping
            # it is the point: it must not reach the screen as text.
        elif match.group("legacy"):
            flush()
            for letter in match.group("legacy_body").lower():
                depth[_TAG_NAMES[letter]] += 1

    buffer.append(text[position:])
    flush()

    # An empty run carries nothing; drop it rather than making callers filter.
    merged = _merge_adjacent([run for run in runs if run.text])
    return Parsed(runs=_mark_lyrics(_split_annotations(merged)), vertical=vertical)


def _mark_lyrics(runs: list[Run]) -> list[Run]:
    """Mark the words between the note marks as sung rather than spoken.

    After _split_annotations rather than inside it, and over the WHOLE cue
    rather than run by run, because the markup and the marks do not line up.
    The corpus writes `♪ <i>Happy birthday to you</i>`, which is two runs: the
    mark is in the first and every sung word is in the second. A pass that
    asked each run what was in it would find a mark with nothing after it and a
    lyric with no mark, and format neither.

    A run that already knows what it is keeps knowing. `[coughing]` inside a
    song is still a sound description, and the mark is still the mark.
    """
    text = "".join(run.text for run in runs)
    spans = annotations.find_lyrics(text)
    if not spans:
        return runs

    out: list[Run] = []
    at = 0
    for run in runs:
        start, end = at, at + len(run.text)
        at = end
        if run.kind:
            out.append(run)
            continue

        cursor = start
        for span_start, span_end in spans:
            begin, finish = max(span_start, cursor), min(span_end, end)
            if begin >= finish:
                continue
            if begin > cursor:
                out.append(Run(text[cursor:begin], run.styles, run.color))
            # The music colour, for the reason _split_annotations gives about
            # every other annotation: hue says "this is not the dialogue"
            # faster than anything else can, and a lyric shares the screen with
            # dialogue often enough that it has to. A colour the file set
            # itself still wins.
            out.append(
                Run(
                    text[begin:finish],
                    run.styles,
                    run.color or annotations.MUSIC_COLOR,
                    annotations.LYRIC,
                )
            )
            cursor = finish
        if cursor < end:
            out.append(Run(text[cursor:end], run.styles, run.color))

    return _merge_adjacent([run for run in out if run.text])


def _split_annotations(runs: list[Run]) -> list[Run]:
    """Separate speaker labels and sound descriptions into their own runs.

    Runs after this point are homogeneous: a run is entirely dialogue, or
    entirely one annotation. That is what lets a renderer dim the non-speech
    parts and colour the names without re-parsing the text.

    Formatting from the enclosing markup is carried through, so `<i>[sighs]</i>`
    stays italic as well as being marked as a sound.
    """
    out: list[Run] = []
    for run in runs:
        spans = annotations.find_annotations(run.text)
        if not spans:
            out.append(run)
            continue

        cursor = 0
        for start, end, kind, inner in spans:
            if start > cursor:
                out.append(Run(run.text[cursor:start], run.styles, run.color))

            # Every annotation gets a colour, because none of it is ordinary
            # speech and hue says that faster than dimming does. Named speakers
            # get their own hue on top, so identity reads as well as kind.
            # A colour set explicitly in the file outranks both - the author
            # meant that colour.
            color = run.color
            if color is None:
                color = _ANNOTATION_COLORS.get(kind)
                if kind == annotations.SPEAKER:
                    color = annotations.speaker_color(inner)

            out.append(
                Run(
                    text=run.text[start:end],
                    styles=run.styles,
                    color=color,
                    kind=kind,
                    symbol=annotations.symbol_for(inner),
                )
            )
            cursor = end

        if cursor < len(run.text):
            out.append(Run(run.text[cursor:], run.styles, run.color))

    return [run for run in out if run.text]


def to_vtt(parsed: Parsed) -> str:
    """Render runs as WebVTT cue text, escaping the dialogue itself."""
    parts: list[str] = []
    for run in parsed.runs:
        text = (
            run.text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        )
        # WebVTT has no strikethrough and no inline colour without a stylesheet,
        # so only the tags it defines are emitted; the rest degrade to plain.
        for style in (ITALIC, BOLD, UNDERLINE):
            if style in run.styles:
                text = f"<{style}>{text}</{style}>"
        parts.append(text)
    return "".join(parts)


def strip(text: str) -> str:
    """Cue text with all markup removed. Convenience for plain-text consumers."""
    return parse(text).plain


def _merge_adjacent(runs: list[Run]) -> list[Run]:
    """Join neighbouring runs that share formatting, so output stays compact."""
    merged: list[Run] = []
    for run in runs:
        previous = merged[-1] if merged else None
        # kind and symbol take part in the comparison: a speaker label and the
        # dialogue after it can share styling but must stay separate runs.
        if (
            previous
            and previous.styles == run.styles
            and previous.color == run.color
            and previous.kind == run.kind
            and previous.symbol == run.symbol
        ):
            merged[-1] = Run(previous.text + run.text, run.styles, run.color, run.kind, run.symbol)
        else:
            merged.append(run)
    return merged


def _font_color(attributes: str) -> str | None:
    match = _FONT_COLOR.search(attributes or "")
    if not match:
        return None
    return next((group for group in match.groups() if group), None)


def _safe_color(value: str | None) -> str | None:
    """Accept only colours that cannot escape a CSS value slot.

    Subtitle text is untrusted input heading for a style property, so this is
    an allowlist: a hex literal, or a name from the CSS colour list. Anything
    else - `red; background: url(...)`, `expression(...)`, an empty string - is
    dropped and the text renders unstyled.
    """
    if not value:
        return None
    candidate = value.strip().strip("\"'").lower()
    if _HEX_COLOR.match(candidate):
        return candidate
    if candidate in _NAMED_COLORS:
        return candidate
    # SubStation's &HBBGGRR& form, occasionally seen in converted files.
    ssa = re.fullmatch(r"&h([0-9a-f]{6})&?", candidate)
    if ssa:
        blue, green, red = ssa.group(1)[0:2], ssa.group(1)[2:4], ssa.group(1)[4:6]
        return f"#{red}{green}{blue}"
    return None
