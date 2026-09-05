#!/usr/bin/env bash

# Setup script for the local subtitle generator.
#
# This script creates a Python virtual environment, installs the
# dependencies listed in requirements.txt, and verifies that ffmpeg
# is available on the system.  It should be run from the project
# root (subgen/).

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$PROJECT_DIR/.venv"

echo "[SubGen] Checking for ffmpeg ..."
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Error: ffmpeg is not installed or not in your PATH." >&2
  echo "Please install ffmpeg via Homebrew: brew install ffmpeg" >&2
  exit 1
fi

if [ ! -d "$VENV_DIR" ]; then
  echo "[SubGen] Creating virtual environment in $VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi

echo "[SubGen] Activating virtual environment"
# shellcheck disable=SC1090
source "$VENV_DIR/bin/activate"

echo "[SubGen] Upgrading pip"
pip install --upgrade pip >/dev/null

echo "[SubGen] Installing requirements from requirements.txt"
# Wheels allowed. This asked pip for source distributions only, and
# faster-whisper publishes none for the pinned 1.2.1 - so the install ended at
# the first line of the file with "no matching distribution found", listing
# every version up to 1.2.0 as if the pin were the problem. ctranslate2, which
# comes with it, would want a C++ toolchain and a long build even where a
# source distribution exists.
pip install -r "$PROJECT_DIR/requirements.txt"

echo "[SubGen] Setup complete.  To use the tool, run:"
echo "  source $VENV_DIR/bin/activate && ./run.sh <file_or_directory>"