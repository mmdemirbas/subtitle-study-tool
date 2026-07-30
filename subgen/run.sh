#!/usr/bin/env bash

# Wrapper script to run the subtitle generator inside its virtual environment.
# All arguments passed to this script are forwarded to the Python CLI.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$PROJECT_DIR/.venv"

if [ ! -d "$VENV_DIR" ]; then
  echo "Error: virtual environment not found.  Run ./setup.sh first." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$VENV_DIR/bin/activate"

python3 "$PROJECT_DIR/src/cli.py" "$@"