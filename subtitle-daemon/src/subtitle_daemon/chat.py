"""One place that speaks OpenAI chat-completions, for every tier that needs it.

Two things in this daemon ask a model a question and expect JSON back: the
gloss tier, which asks what a word means in the line it was said in, and the
translator, which asks for a whole scene at once. They are different questions
with different prompts, different timeouts and different answer contracts - but
the wire between here and the model is the same wire, and it was written for
glossing first.

The shape is deliberate rather than incidental. Its research report put it
plainly: one base URL, one model string, one bearer key is the interoperable
shape, and everything from ollama on this machine to a hosted endpoint speaks
it. Keeping the transport in one function is what makes "run it locally" and
"run it against a hosted endpoint" a setting rather than a second code path.

What this does NOT do is decide anything about the answer. It returns whatever
JSON object came back, or None. The caller owns its own contract - `{"g": [...]}`
for a gloss, `{"lines": [...]}` for a translation - because a short array means
something different in each and the check that catches it belongs beside the
thing that knows what a right answer looks like.
"""

from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.request
from typing import Any

from .config import USER_AGENT

logger = logging.getLogger(__name__)

# A local runtime that reasons out loud wraps the thinking in tags and then the
# JSON. `chat_template_kwargs` asks it not to and the hosted ones ignore that
# key, so this is the belt to that pair of braces.
THINKING = re.compile(r"<think>.*?</think>", re.DOTALL)

DEFAULT_URL = "http://127.0.0.1:11434/v1/chat/completions"


def ask_json(
    *,
    url: str,
    model: str,
    key: str,
    system: str,
    user: str,
    timeout: float,
    what: str = "request",
) -> Any | None:
    """Ask for a JSON object and return it parsed, or None if anything went wrong.

    None means "could not be asked" and never "the model said nothing useful" -
    the callers distinguish those, and collapsing them turns a misconfigured URL
    into what looks like a model with no opinion.

    `what` names the caller in the log line. A key that is wrong looks, from the
    reader's side, exactly like a word with no translation and a film with no
    subtitle, so the only place it can be found is the log.
    """
    body = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            # Greedy. Both callers write their answer to disk the first time it
            # is given, so whichever sample landed first is the one kept for
            # good - and two identical requests agreeing is what makes it
            # possible to measure a change in the prompt rather than a change in
            # the draw.
            "temperature": 0,
            "response_format": {"type": "json_object"},
            # Honoured by the local runtimes and ignored by the hosted ones,
            # which is why THINKING exists as well.
            "chat_template_kwargs": {"enable_thinking": False},
        }
    ).encode("utf-8")

    headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
    # A model on this machine wants no Authorization header, and sending an
    # empty one is how you get a 401 from something that has no accounts.
    if key:
        headers["Authorization"] = f"Bearer {key}"

    request = urllib.request.Request(url, data=body, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = json.loads(response.read().decode("utf-8"))
        said = THINKING.sub("", raw["choices"][0]["message"]["content"]).strip()
        return json.loads(said)
    except (
        urllib.error.URLError,
        TimeoutError,
        ValueError,
        OSError,
        KeyError,
        IndexError,
        TypeError,
    ) as error:
        logger.warning("%s unavailable from %s: %s", what, url, error)
        return None
