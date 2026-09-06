"""Entry point: `python -m subtitle_daemon` or the `subtitle-daemon` script."""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import subprocess
import sys
import urllib.error
import urllib.request

from . import config as config_module
from .config import DEFAULT_PORT
from .server import PortInUseError, serve

logger = logging.getLogger(__name__)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="subtitle-daemon",
        description="Find, download and cache subtitles for whatever is playing.",
    )
    parser.add_argument("--port", type=int, help=f"port to listen on (default {DEFAULT_PORT})")
    parser.add_argument("--verbose", "-v", action="store_true", help="log every request")
    parser.add_argument(
        "--replace",
        action="store_true",
        help="stop a daemon already running on the port, then take it over",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    settings = config_module.load()
    if args.port:
        settings = dataclasses.replace(settings, port=args.port)

    if args.replace and not _stop_existing(settings.port):
        return 1

    try:
        serve(settings)
    except PortInUseError:
        _explain_port_in_use(settings.port)
        return 1
    return 0


def _explain_port_in_use(port: int) -> None:
    """Say what is on the port and how to deal with it.

    The default failure here is an EADDRINUSE traceback, which does not say
    whether the occupant is a forgotten copy of this daemon or something else
    entirely - and those want opposite responses.
    """
    holder = _identify(port)
    pids = _pids_on_port(port)

    logger.error("Cannot start: port %d is already in use by %s.", port, holder)
    if pids:
        logger.error("Held by PID %s.", ", ".join(str(pid) for pid in pids))

    logger.error("Fix it with one of:")
    logger.error("    ./run.sh --replace          stop that one and take over")
    logger.error("    ./run.sh --port 8792        run alongside it on another port")
    if pids:
        logger.error("    kill %s", " ".join(str(pid) for pid in pids))


def _identify(port: int) -> str:
    """Ask whatever is on the port whether it is one of us."""
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/health", timeout=2
        ) as response:
            payload = json.loads(response.read())
    except (urllib.error.URLError, OSError, ValueError):
        return "another program"

    if not isinstance(payload, dict) or "has_api_key" not in payload:
        return "another program"
    return (
        "a subtitle-daemon that is already running"
        f" ({payload.get('cached_subtitles', 0)} subtitles cached,"
        f" {'signed in' if payload.get('authenticated') else 'anonymous'})"
    )


def _stop_existing(port: int) -> bool:
    """Terminate whatever holds the port. True if the port is now free."""
    pids = _pids_on_port(port)
    if not pids:
        return True

    if _identify(port) == "another program":
        # Refuse to kill something that is not ours just because it took the
        # port first. --replace means "replace my daemon", not "kill anything".
        logger.error(
            "Port %d is held by something that is not a subtitle-daemon (PID %s). "
            "Not touching it - use --port to run elsewhere.",
            port,
            ", ".join(str(pid) for pid in pids),
        )
        return False

    for pid in pids:
        logger.info("Stopping existing daemon (PID %d)", pid)
        try:
            subprocess.run(["kill", str(pid)], check=True, capture_output=True)
        except (subprocess.CalledProcessError, OSError) as err:
            logger.error("Could not stop PID %d: %s", pid, err)
            return False

    # Give the socket a moment to close before the caller rebinds.
    for _ in range(20):
        if not _pids_on_port(port):
            return True
        _sleep_briefly()
    logger.error("PID %s did not exit; port %d is still held.", pids, port)
    return False


def _pids_on_port(port: int) -> list[int]:
    """PIDs listening on a TCP port, via lsof. Empty if lsof is unavailable."""
    try:
        result = subprocess.run(
            ["lsof", "-nP", "-tiTCP:%d" % port, "-sTCP:LISTEN"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    return [int(line) for line in result.stdout.split() if line.strip().isdigit()]


def _sleep_briefly() -> None:
    import time

    time.sleep(0.1)


if __name__ == "__main__":
    sys.exit(main())
