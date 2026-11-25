#!/usr/bin/env bash
# Runs every test suite. macOS and Linux are separate runs, and both must pass:
#   bash tests/run.sh           — on this machine (the host: macOS or Linux)
#   bash tests/run.sh --linux   — on Linux, inside the test box's image (.env.test; build: ./claude-box --env test)
# The image is where the web server really runs (tmux, /proc), so the Linux run covers everything;
# the host run covers ./claude-box on the host's own tools (BSD userland on macOS). A suite that
# needs a tool the host lacks (tmux) skips, it does not fail.
set -uo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = --linux ]; then
  # The image only brings the tools (node, tmux, jq, script); the code comes from this checkout.
  # Which image: CLAUDE_BOX_IMAGE; else the test box's (.env.test: build it with
  # ./claude-box --env test); without .env.test, the one of .env, else the newest claude-box*.
  image_of() { CLAUDE_BOX_ENV_FILE="$PWD/$1" docker compose --env-file "$1" config --images web 2>/dev/null | head -n1; }
  image="${CLAUDE_BOX_IMAGE:-}"
  if [ -z "$image" ] && [ -f .env.test ]; then
    image="$(image_of .env.test)"
    if [ -z "$image" ] || ! docker image inspect "$image" >/dev/null 2>&1; then
      echo "tests/run.sh: the test box's image (${image:-?}) is not built; run ./claude-box --env test" >&2
      exit 2
    fi
  fi
  [ -n "$image" ] || [ ! -f .env ] || image="$(image_of .env)"
  [ -n "$image" ] && docker image inspect "$image" >/dev/null 2>&1 \
    || image="$(docker images --filter 'reference=claude-box*' --format '{{.Repository}}:{{.Tag}}' | head -n1)"
  if [ -z "$image" ] || ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "tests/run.sh: no claude-box image found; run ./claude-box --env test (or set CLAUDE_BOX_IMAGE)" >&2
    exit 2
  fi
  echo "Linux run in image $image"
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
