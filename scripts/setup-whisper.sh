#!/usr/bin/env bash
# Build whisper.cpp into vendor/ and fetch the models the realtime path needs.
#
# Nothing here touches system Python. whisper.cpp is a C++ build; its only
# system dependencies are cmake and (for the streaming binary) SDL2, both via
# Homebrew. Everything else lands under vendor/ and models/, which are
# gitignored.
#
# Re-running is safe and cheap: existing builds and downloaded models are kept.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$REPO_ROOT/vendor"
WHISPER="$VENDOR/whisper.cpp"
MODELS="$REPO_ROOT/models"

# Where the pre-existing incubation checkout lives. If it is there we reuse its
# build and its 2.9 GB large-v3 download instead of paying for both again.
LEGACY="${LEGACY_WHISPER_DIR:-$HOME/dev/incubation/speech-to-text/whisper.cpp}"

# Models to have on hand. large-v3 is the quality reference; the turbo and small
# models are the ones fast enough to keep up with live audio.
MODELS_WANTED=("small" "large-v3-turbo")

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

require_brew_pkg() {
  local pkg="$1"
  if brew list --formula "$pkg" >/dev/null 2>&1; then
    log "$pkg already installed"
  else
    log "installing $pkg via Homebrew"
    brew install "$pkg"
  fi
}

# --- dependencies -----------------------------------------------------------

command -v brew >/dev/null 2>&1 || { warn "Homebrew is required"; exit 1; }
require_brew_pkg cmake
require_brew_pkg sdl2   # needed for the whisper-stream realtime binary

# --- source -----------------------------------------------------------------

mkdir -p "$VENDOR" "$MODELS"

if [[ ! -d "$WHISPER/.git" ]]; then
  if [[ -d "$LEGACY/.git" ]]; then
    log "cloning from local checkout at $LEGACY (no network needed)"
    git clone "$LEGACY" "$WHISPER"
    # Point origin back at upstream so future pulls work.
    git -C "$WHISPER" remote set-url origin https://github.com/ggml-org/whisper.cpp.git
  else
    log "cloning whisper.cpp from GitHub"
    git clone https://github.com/ggml-org/whisper.cpp.git "$WHISPER"
  fi
else
  log "whisper.cpp already present at $WHISPER"
fi

# --- build ------------------------------------------------------------------
# WHISPER_SDL2=ON is what produces whisper-stream. The incubation build did not
# set it, which is why only whisper-cli and whisper-server existed there.

log "configuring build (Metal + SDL2)"
cmake -S "$WHISPER" -B "$WHISPER/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_SDL2=ON \
  -DGGML_METAL=ON

log "compiling (this takes a few minutes on first run)"
cmake --build "$WHISPER/build" -j --config Release

# --- models -----------------------------------------------------------------
# Reuse anything already downloaded in the legacy tree rather than re-fetching.

if [[ -d "$LEGACY/models" ]]; then
  for f in "$LEGACY"/models/ggml-*.bin; do
    [[ -e "$f" ]] || continue
    case "$(basename "$f")" in
      for-tests-*) continue ;;   # tiny stubs, not real weights
    esac
    dest="$MODELS/$(basename "$f")"
    if [[ ! -e "$dest" ]]; then
      log "linking existing model $(basename "$f") from legacy checkout"
      ln -s "$f" "$dest"
    fi
  done
fi

for m in "${MODELS_WANTED[@]}"; do
  if [[ -e "$MODELS/ggml-$m.bin" ]]; then
    log "model $m already present"
    continue
  fi
  log "downloading model $m"
  # The upstream script writes into the directory passed as its second argument.
  bash "$WHISPER/models/download-ggml-model.sh" "$m" "$MODELS"
done

# --- report -----------------------------------------------------------------

echo
log "binaries in $WHISPER/build/bin:"
ls "$WHISPER/build/bin" | grep -E '^whisper-' | sed 's/^/    /'
echo
log "models in $MODELS:"
# -L so symlinked models report the size of their target, not the link.
du -Lh "$MODELS"/ggml-*.bin 2>/dev/null | awk '{print "    " $2 " (" $1 ")"}'
echo
if [[ -x "$WHISPER/build/bin/whisper-stream" ]]; then
  log "whisper-stream is ready — realtime transcription can run"
else
  warn "whisper-stream was NOT built; check that SDL2 was found during configure"
fi
