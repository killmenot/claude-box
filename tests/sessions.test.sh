#!/usr/bin/env bash
# Test for claude-sessions (scripts/sessions.js): the project directory name must be
# encoded exactly the way Claude Code does it — every character outside [A-Za-z0-9]
# becomes '-', not only the path separator.
# Run: bash tests/sessions.test.sh
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
fail=0
check(){ if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1: expected [$2] got [$3]"; fail=1; fi; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node not found"; exit 0; }

tmp="$(mktemp -d)"
cleanup(){ rm -rf "$tmp"; }
trap cleanup EXIT
export HOME="$tmp"

# Seed one session file per project directory, named the way Claude Code names it.
seed() {                      # seed <encoded-dir> <session-id> <first user message>
  local d="$HOME/.claude/projects/$1"
  mkdir -p "$d"
  printf '{"type":"user","message":{"content":"%s"},"timestamp":"2026-06-28T10:00:00Z"}\n' \
    "$3" > "$d/$2.jsonl"
}

seed -workspace-plain            sess-plain "plain folder"
seed -workspace-foo-bar          sess-dot   "dotted folder"
seed -workspace-a-b              sess-under "underscored folder"
seed '-workspace---test444'      sess-utf   "non-ascii folder"

run(){ node "$ROOT/scripts/sessions.js" "$1" | cut -f1 | head -n1; }

check "plain path (regression)"      sess-plain "$(run /workspace/plain)"
check "dot in folder name"           sess-dot   "$(run /workspace/foo.bar)"
check "underscore in folder name"    sess-under "$(run /workspace/a_b)"
check "non-ascii folder name"        sess-utf   "$(run /workspace/еуtest444)"

prev="$(node "$ROOT/scripts/sessions.js" --preview /workspace/foo.bar sess-dot)"
case "$prev" in *"dotted folder"*) check "--preview resolves dotted path" ok ok ;;
                *)                 check "--preview resolves dotted path" ok "[$prev]" ;; esac

echo
[ "$fail" -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
