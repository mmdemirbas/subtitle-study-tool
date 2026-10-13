#!/usr/bin/env bash
# The one entry point for this workspace: the daemon, the viewer, the tests and
# the setup scripts, each wrapping what its own directory already runs.
# `./ctl` lists them; ajans.toml declares them.
set -euo pipefail

# Where the caller stood, for the paths they hand to `transcribe`.
caller_dir="$PWD"
cd "$(dirname "$0")"

op_dev() { exec subtitle-daemon/run.sh "$@"; }

op_dev_viewer() {
	cd srt-viewer
	exec ./run-http-server-here.sh
}

# --port on `dev` is SUBTITLE_DAEMON_PORT here, or the first argument.
op_status() {
	local port="${1:-${SUBTITLE_DAEMON_PORT:-8794}}" body
	if ! body="$(curl -fsS --max-time 5 "http://127.0.0.1:$port/health")"; then
		printf '✗ nothing answers /health on 127.0.0.1:%s (./ctl dev starts the daemon)\n' "$port" >&2
		return 1
	fi
	printf '%s\n' "$body" | python3 -m json.tool
}

# One file per UTC day, named YYYY-MM-DD.jsonl, so the last in glob order is the
# newest. Arguments replace the default `-n 100 -f` and go to tail.
op_logs() {
	local logs=(subtitle-daemon/logs/*.jsonl)
	if [[ ! -e "${logs[0]}" ]]; then
		printf '! no log yet: the daemon writes subtitle-daemon/logs/<day>.jsonl when the extension sends one\n' >&2
		return 0
	fi
	local newest="${logs[${#logs[@]}-1]}"
	if [[ $# -gt 0 ]]; then exec tail "$@" "$newest"; fi
	printf '▸ %s\n' "$newest"
	exec tail -n 100 -f "$newest"
}

# ruff is configured in subtitle-daemon/pyproject.toml but not a dependency.
op_check() {
	cd subtitle-daemon
	if command -v ruff >/dev/null 2>&1; then
		ruff check "$@"
	else
		uvx ruff check "$@"
	fi
}

op_test_daemon() {
	cd subtitle-daemon
	uv run pytest "$@"
}

op_test_extension() {
	cd browser-extension
	node tests/worker.mjs "$@"
}

# Both scripts load playwright-core from PLAYWRIGHT_PATH (or from here), which
# this repository does not depend on; without it nothing is attempted.
op_test_browser() {
	cd browser-extension
	if ! node -e 'require.resolve("playwright-core", { paths: [process.env.PLAYWRIGHT_PATH, process.cwd()].filter(Boolean) })' 2>/dev/null; then
		printf '⏸ playwright-core is not resolvable: npm i playwright-core anywhere, then PLAYWRIGHT_PATH=<that>/node_modules ./ctl test browser\n' >&2
		return 75
	fi
	node tests/frames/run.mjs
	node tests/realinput.mjs
}

# tests/serve.py, not python3 -m http.server: see browser-extension/tests/README.md.
op_test_pages() {
	cd browser-extension
	exec python3 tests/serve.py "$@"
}

op_transcribe() {
	local root="$PWD"
	cd "$caller_dir"
	exec "$root/subgen/run.sh" "$@"
}

op_setup_daemon() {
	cd subtitle-daemon
	if [[ -e config.local.json ]]; then
		printf '✓ subtitle-daemon/config.local.json is already there; left as it is\n'
		return 0
	fi
	cp config.example.json config.local.json
	printf '✓ subtitle-daemon/config.local.json made from config.example.json\n'
	printf '! put an OpenSubtitles API key in it: subtitle-daemon/README.md, Setup\n' >&2
}

op_setup_whisper() { scripts/setup-whisper.sh "$@"; }

op_setup_subgen() { subgen/setup.sh "$@"; }

# >>> ajans runtime 2 >>>
# Written by `ajans contract sync`; edits here are overwritten. The operations
# are declared in ajans.toml and implemented above as op_<verb>[_<target>].

# Where this file is. A relative path was relative to where ctl was started,
# and the driver may have changed directory since - usually into its own, with
# `cd "$(dirname "$0")"` - so it is tried against here, then against where the
# last cd came from, and failing both the directory the driver changed into.
# A function rather than inline: bash 3.2 cannot parse a `case` inside `$(...)`.
_ajans_where() {
	local src="${BASH_SOURCE[0]}" base
	case "$src" in
		/*) ;;
		*)
			for base in "$PWD" "${OLDPWD:-}"; do
				if [[ -n "$base" && -f "$base/$src" ]]; then
					src="$base/$src"
					break
				fi
			done
			;;
	esac
	case "$src" in
		/*) ;;
		*) src="$PWD/${src##*/}" ;;
	esac
	(cd "$(dirname "$src")" && pwd)
}
_ajans_root="$(_ajans_where)"

_ajans_fn() {
	local name="op_$*"
	name="${name// /_}"
	name="${name//-/_}"
	printf '%s' "${name//./_}"
}

# Reads ajans.toml with the first python3 that has tomllib. Modes: list [verb], keys.
_ajans_toml() {
	local py
	if [[ ! -f "$_ajans_root/ajans.toml" ]]; then
		printf '✗ no ajans.toml beside %s\n' "$_ajans_root/ctl" >&2
		return 66
	fi
	for py in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
		if ! command -v "$py" >/dev/null 2>&1 || ! "$py" -c 'import tomllib' 2>/dev/null; then
			continue
		fi
		"$py" - "$_ajans_root/ajans.toml" "$@" <<'PY'
import re, sys, tomllib
try:
    with open(sys.argv[1], 'rb') as f:
        manifest = tomllib.load(f)
except tomllib.TOMLDecodeError as e:
    sys.exit(f'✗ ajans.toml: {e}')
ops, verbs = manifest.get('operations', {}), manifest.get('verbs', {})
mode, rest = sys.argv[2], sys.argv[3:]
if mode == 'keys':
    for key in ops:
        print('op_' + re.sub(r'[ .-]', '_', key))
elif rest:
    for key, op in ops.items():
        verb, _, target = key.partition(' ')
        if verb == rest[0] and target:
            print(f"{target}\t{op.get('summary', '')}")
else:
    seen = []
    for key in ops:
        verb = key.partition(' ')[0]
        if verb not in seen:
            seen.append(verb)
            print(f"{verb}\t{ops[verb]['summary'] if verb in ops else verbs.get(verb, '')}")
PY
		return
	done
	printf '✗ reading ajans.toml needs python3 3.11 or later (tomllib)\n' >&2
	return 69
}

_ajans_check() {
	local declared defined missing extra fn count noun
	declared="$(_ajans_toml keys)" || return
	declared="$(printf '%s\n' "$declared" | sort)"
	defined="$(declare -F | awk '$3 ~ /^op_/ { print $3 }' | sort)"
	missing="$(comm -23 <(printf '%s\n' "$declared") <(printf '%s\n' "$defined") | sed '/^$/d')"
	extra="$(comm -13 <(printf '%s\n' "$declared") <(printf '%s\n' "$defined") | sed '/^$/d')"
	if [[ -z "$missing" && -z "$extra" ]]; then
		count="$(printf '%s\n' "$declared" | grep -c .)"
		if [[ "$count" == 1 ]]; then noun=operation; else noun=operations; fi
		printf '✓ ajans.toml and ctl agree: %s %s\n' "$count" "$noun"
		return 0
	fi
	if [[ -n "$missing" ]]; then
		while IFS= read -r fn; do printf '✗ declared, no function: %s\n' "$fn" >&2; done <<<"$missing"
	fi
	if [[ -n "$extra" ]]; then
		while IFS= read -r fn; do printf '✗ function, not declared: %s\n' "$fn" >&2; done <<<"$extra"
	fi
	return 1
}

_ajans_main() {
	case "${1:-}" in
	'' | --list | -h | --help)
		_ajans_toml list
		return
		;;
	--check)
		_ajans_check
		return
		;;
	esac
	if [[ "${2:-}" == --list ]]; then
		_ajans_toml list "$1"
		return
	fi
	local fn
	if [[ $# -ge 2 ]]; then
		fn="$(_ajans_fn "$1 $2")"
		if declare -F "$fn" >/dev/null; then
			shift 2
			"$fn" "$@"
			return
		fi
	fi
	fn="$(_ajans_fn "$1")"
	if declare -F "$fn" >/dev/null; then
		shift
		"$fn" "$@"
		return
	fi
	if declare -F | awk -v p="$fn"_ '$3 ~ "^" p { found = 1 } END { exit !found }'; then
		printf '✗ %s needs a target: ./ctl %s --list\n' "$1" "$1" >&2
	else
		printf '✗ %s: not an operation of this project (./ctl --list)\n' "$*" >&2
	fi
	return 64
}

_ajans_main "$@"
# <<< ajans runtime <<<
