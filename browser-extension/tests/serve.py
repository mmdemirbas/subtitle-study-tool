#!/usr/bin/env python3
"""Serve the extension for the test pages, telling the browser not to cache.

`python3 -m http.server` is one line shorter and quietly wrong for this job.
The browser's memory cache does not revalidate a URL it has already seen in a
session, and the page URL is not the script URL - so reloading a test page
reloads the page and keeps the previous `content.js`. The suite then reports on
code that is no longer on disk, in green.

The page can defend its own <script src> tags with a cache-buster, and
harness.html does. It cannot defend what a module imports: fallback.html
imports provider.js, which imports cache.js, and nothing in the page ever names
that URL. Only the server can answer for every file, which is why this exists.

    python3 tests/serve.py            # then open http://127.0.0.1:8997/tests/
"""

import functools
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8997
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoStore(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *args):  # the pages report their own results
        pass


if __name__ == "__main__":
    handler = functools.partial(NoStore, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as httpd:
        print(f"serving {ROOT} on http://127.0.0.1:{PORT} (no-store)")
        print(f"  http://127.0.0.1:{PORT}/tests/harness.html")
        print(f"  http://127.0.0.1:{PORT}/tests/fallback.html")
        httpd.serve_forever()
