#!/usr/bin/env bash
# Runs every test suite. macOS and Linux are separate runs, and both must pass:
#   bash tests/run.sh           — on this machine (the host: macOS or Linux)
#   bash tests/run.sh --linux   — on Linux, inside the claude-box image (build it first: ./claude-box)
# The image is where the web server really runs (tmux, /proc), so the Linux run covers everything;
# the host run covers ./claude-box on the host's own tools (BSD userland on macOS). A suite that
# needs a tool the host lacks (tmux) skips, it does not fail.
set -uo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = --linux ]; then
  image="$(docker compose config --images web 2>/dev/null | head -n1)"
  if [ -z "$image" ] || ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "tests/run.sh: the claude-box image (${image:-?}) is not built; run ./claude-box first" >&2
    exit 2
  fi
  # Only the code goes in, read-only: never .env, certs/ or home/ (secrets, the live box's state).
  mounts=()
  for p in claude-box docker-compose.yml docker-compose.no-proxy.yml docker-compose.ports.yml \
           scripts tests html claude-defaults; do
    [ -e "$p" ] && mounts+=(-v "$PWD/$p:/src/$p:ro")
  done
  exec docker run --rm --network none "${mounts[@]}" -w /src --entrypoint bash "$image" tests/run.sh
fi

fail=0
run() { echo "== $*"; "$@" || fail=1; echo; }
run node --test tests/*.test.js
run bash tests/web-menu.test.sh
run bash tests/claude-box.test.sh
os="$(uname -s)"
if [ "$fail" = 0 ]; then echo "ALL SUITES PASS ($os)"; else echo "SOME SUITES FAILED ($os)"; exit 1; fi
