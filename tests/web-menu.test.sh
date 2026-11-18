#!/usr/bin/env bash
# Tests for the deep-link path: web-menu.sh helpers + the registry's session-ownership check.
# Two defects are covered here:
#   1. tmux session names (web-N) are recycled by next_name(), so a stale record could attach a
#      deep link to a completely unrelated live session. Identity is the @cbtoken stamp now.
#   2. the registry stores the cwd reported by the hook (Claude's CURRENT dir, which drifts when
#      the session cd's deeper), while `claude --resume` looks for the session file in the project
#      dir of the launch directory.
# Run: bash tests/web-menu.test.sh
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
fail=0
check(){ if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1: expected [$2] got [$3]"; fail=1; fi; }

command -v tmux >/dev/null 2>&1 || { echo "SKIP: tmux not found"; exit 0; }
command -v jq   >/dev/null 2>&1 || { echo "SKIP: jq not found";   exit 0; }

tmp="$(mktemp -d)"
export HOME="$tmp"
export TMUX_TMPDIR="$tmp"           # a private tmux server: never touch the developer's own
cleanup(){ tmux kill-server 2>/dev/null; rm -rf "$tmp"; }
trap cleanup EXIT

bin="$tmp/bin"; mkdir -p "$bin"
chmod +x "$ROOT/scripts/web-registry.sh"
ln -sf "$ROOT/scripts/web-registry.sh" "$bin/claude-web-registry"
export PATH="$bin:$PATH"

# --- helpers from web-menu.sh (sourced as a library, without starting the picker) ---
CLAUDE_WEB_MENU_LIB=1 . "$ROOT/scripts/web-menu.sh"

# ---------------------------------------------------------------- resume_cwd
ws="$tmp/ws/risksengine"
mkdir -p "$ws/lambda-risk-datasource" "$tmp/ws/plain"
enc(){ printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g'; }
seed(){ mkdir -p "$HOME/.claude/projects/$(enc "$1")"; : > "$HOME/.claude/projects/$(enc "$1")/$2.jsonl"; }

seed "$ws" cid-drift                       # session was launched in .../risksengine
seed "$tmp/ws/plain" cid-exact             # session was launched right where the hook saw it

check "resume_cwd: cwd drifted into a subfolder" \
  "$ws" "$(resume_cwd cid-drift "$ws/lambda-risk-datasource")"
check "resume_cwd: recorded cwd is the project dir" \
  "$tmp/ws/plain" "$(resume_cwd cid-exact "$tmp/ws/plain")"
resume_cwd cid-missing "$ws/lambda-risk-datasource" >/dev/null 2>&1
check "resume_cwd: no session file anywhere -> failure" 1 "$?"
# a session file whose directory is gone (deleted scratch dir) must not be offered as a cwd
seed "$tmp/ws/gone" cid-gone
resume_cwd cid-gone "$tmp/ws/gone" >/dev/null 2>&1
check "resume_cwd: project dir no longer on disk -> failure" 1 "$?"

# ---------------------------------------------------------------- session ownership
reg="$HOME/.claude/web-sessions.json"
mkdir -p "$HOME/.claude"
cat > "$reg" <<'EOF'
{"tok-old" :{"token":"tok-old" ,"claudeSessionId":"cid-old" ,"cwd":"/w/a","name":"web-1","state":"done","tmuxSession":"web-1","lastActivity":1},
 "tok-new" :{"token":"tok-new" ,"claudeSessionId":"cid-new" ,"cwd":"/w/b","name":"web-1","state":"done","tmuxSession":"web-1","lastActivity":2},
 "tok-solo":{"token":"tok-solo","claudeSessionId":"cid-solo","cwd":"/w/c","name":"solo" ,"state":"done","tmuxSession":"solo" ,"lastActivity":3}}
EOF

tmux new-session -d -s web-1 'sleep 300'
tmux new-session -d -s solo  'sleep 300'
tmux set-option -t web-1 @cbtoken tok-new

check "owns: stamped session belongs to its own token"      "web-1" "$(claude-web-registry owns tok-new)"
claude-web-registry owns tok-old >/dev/null 2>&1
check "owns: recycled name held by a stranger -> not ours"  1 "$?"
check "owns: unstamped session, single claimant of the name" "solo" "$(claude-web-registry owns tok-solo)"
tmux new-session -d -s dead-name 'sleep 300'; tmux kill-session -t dead-name
claude-web-registry owns tok-solo >/dev/null 2>&1 && rc=0 || rc=1
check "owns: still ours after an unrelated session died"    0 "$rc"

# ---------------------------------------------------------------- list: live flag
live_of(){ claude-web-registry list | jq -r --arg t "$1" '.[]|select(.token==$t)|.live'; }
check "list: token owning the live session is live"   true  "$(live_of tok-new)"
check "list: token whose name was recycled is dead"   false "$(live_of tok-old)"
check "list: unstamped single claimant is live"       true  "$(live_of tok-solo)"

# ---------------------------------------------------------------- delete: never kill a stranger
claude-web-registry delete tok-old >/dev/null
tmux has-session -t web-1 2>/dev/null && rc=0 || rc=1
check "delete: a stale record does not kill someone else's session" 0 "$rc"
check "delete: the stale record itself is gone" "" "$(jq -r '.["tok-old"] // empty' "$reg")"
claude-web-registry delete tok-new >/dev/null
tmux has-session -t web-1 2>/dev/null && rc=0 || rc=1
check "delete: the owning record does kill its session" 1 "$rc"

[ "$fail" -eq 0 ] && echo "PASS" || echo "FAILURES"
exit "$fail"
