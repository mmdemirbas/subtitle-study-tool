#!/usr/bin/env bash

# The viewer is one HTML file and opens from the filesystem, but a file:// page
# cannot fetch its neighbours - so this is here for the subtitles beside it.
#
# Bound to the loopback address on purpose. Left off, python3 -m http.server
# listens on every address the machine has and publishes this directory, and
# the subtitle corpus with it, to anything on the network. Reach it from
# another device through a tunnel rather than by widening this.
python3 -m http.server 8080 --bind 127.0.0.1
