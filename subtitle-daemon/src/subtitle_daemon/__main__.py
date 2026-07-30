"""Entry point: `python -m subtitle_daemon` or the `subtitle-daemon` script."""

from __future__ import annotations

import argparse
import dataclasses
import logging
import sys

from . import config as config_module
from .server import serve


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="subtitle-daemon",
        description="Find, download and cache subtitles for whatever is playing.",
    )
    parser.add_argument("--port", type=int, help="port to listen on (default 8791)")
    parser.add_argument("--verbose", "-v", action="store_true", help="log every request")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    settings = config_module.load()
    if args.port:
        settings = dataclasses.replace(settings, port=args.port)

    serve(settings)
    return 0


if __name__ == "__main__":
    sys.exit(main())
