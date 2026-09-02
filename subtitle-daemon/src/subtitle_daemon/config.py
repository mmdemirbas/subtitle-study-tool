"""Configuration, resolved once at startup.

Credentials come from the environment or a gitignored config file, never from
the extension. The extension talks only to this daemon, so the API key never
reaches a web page.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

# OpenSubtitles requires a User-Agent naming the app and version. Requests with
# a generic or absent one get rejected.
USER_AGENT = "subtitle-study-tool v0.1.0"

API_BASE = "https://api.opensubtitles.com/api/v1"

REPO_ROOT = Path(__file__).resolve().parents[3]
DAEMON_ROOT = REPO_ROOT / "subtitle-daemon"
CONFIG_PATH = DAEMON_ROOT / "config.local.json"
CACHE_DIR = DAEMON_ROOT / "cache"
# Where the extension's running log lands. A directory the daemon owns, so the
# browser never has to download a file to get a record onto disk - see
# `/log` in server.py.
LOG_DIR = DAEMON_ROOT / "logs"

DEFAULT_PORT = 8791


@dataclass(frozen=True)
class Config:
    """Everything the daemon needs to know at startup."""

    api_key: str | None
    username: str | None
    password: str | None
    default_languages: tuple[str, ...]
    port: int
    # Study mode's three tiers of meaning, best first. Naming a model turns the
    # top one on; the URL defaults to a model running on this machine, and the
    # key is only for a hosted one. Without any of it a gloss still arrives,
    # from a context-free translator, which is what it was before. See
    # lookups.py for what the difference actually looks like.
    gloss_model: str | None = None
    gloss_url: str | None = None
    gloss_api_key: str | None = None
    google_api_key: str | None = None

    @property
    def has_api_key(self) -> bool:
        return bool(self.api_key)

    @property
    def can_login(self) -> bool:
        """Logging in raises the download quota from 5/day to at least 10/day."""
        return bool(self.api_key and self.username and self.password)


def load() -> Config:
    """Read config from config.local.json, with environment overrides.

    Environment wins so a one-off run can point at a different account without
    editing the file.
    """
    data: dict[str, object] = {}
    if CONFIG_PATH.exists():
        data = json.loads(CONFIG_PATH.read_text())

    def pick(env: str, key: str) -> str | None:
        value = os.environ.get(env) or data.get(key)
        return str(value) if value else None

    languages = os.environ.get("SUBTITLE_LANGUAGES") or data.get("default_languages")
    if isinstance(languages, str):
        parsed = tuple(part.strip() for part in languages.split(",") if part.strip())
    elif isinstance(languages, list):
        parsed = tuple(str(part) for part in languages)
    else:
        parsed = ("en", "tr")

    port_raw = os.environ.get("SUBTITLE_DAEMON_PORT") or data.get("port")

    return Config(
        api_key=pick("OPENSUBTITLES_API_KEY", "api_key"),
        username=pick("OPENSUBTITLES_USERNAME", "username"),
        password=pick("OPENSUBTITLES_PASSWORD", "password"),
        default_languages=parsed,
        port=int(port_raw) if port_raw else DEFAULT_PORT,
        gloss_model=pick("GLOSS_MODEL", "gloss_model"),
        gloss_url=pick("GLOSS_URL", "gloss_url"),
        gloss_api_key=pick("GLOSS_API_KEY", "gloss_api_key"),
        google_api_key=pick("GOOGLE_API_KEY", "google_api_key"),
    )
