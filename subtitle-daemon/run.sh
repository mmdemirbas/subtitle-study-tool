#!/usr/bin/env bash
# Start the subtitle daemon. Any arguments are passed straight through.
#
# Uses uv when available so the run is isolated from system Python. There are
# no runtime dependencies, so a bare python3 works just as well as a fallback.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if command -v uv >/dev/null 2>&1; then
  exec uv run --quiet subtitle-daemon "$@"
fi

PYTHONPATH="src${PYTHONPATH:+:$PYTHONPATH}" exec python3 -m subtitle_daemon "$@"
