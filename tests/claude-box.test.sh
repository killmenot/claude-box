#!/usr/bin/env bash
# Tests for the host entry point ./claude-box: first-run setup (.env, workspace, web login) and the
# docker calls it makes. docker is a stub that only logs its arguments; a pty (script(1)) stands
# in for the user's terminal. Run: bash tests/claude-box.test.sh
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
fail=0
check(){ if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1: expected [$2] got [$3]"; fail=1; fi; }
command -v script >/dev/null 2>&1 || { echo "SKIP: script(1) not found"; exit 0; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home"; mkdir -p "$HOME"
repo="$tmp/repo"; mkdir -p "$repo"
cp "$ROOT/claude-box" "$ROOT/docker-compose.yml" "$ROOT/docker-compose.no-proxy.yml" "$repo/"
# a minimal template in the shape of the real one: placeholder workspace, commented-out password
printf '%s\n' 'PROJECT_DIR=/path/to/your/project' 'WEB_TERMINAL_PORT=7681' '# WEB_TERMINAL_PASSWORD=' > "$repo/.env.example"
bin="$tmp/bin"; mkdir -p "$bin"
printf '#!/bin/sh\necho "docker $*" >> "%s/docker.log"\n' "$tmp" > "$bin/docker"; chmod +x "$bin/docker"
export PATH="$bin:$PATH"

# run claude-box on a pty, feeding <input>; prints the transcript
tty_run(){ printf '%b' "$1" | script -qec "bash '$repo/claude-box' ${2:-}" /dev/null 2>&1; }
val(){ grep -E "^$1=" "$repo/.env" | tail -n1 | cut -d= -f2-; }

# --- 1. first run: defaults for workspace and login, a chosen password ---
# typed with pauses, like a person: the pty echoes anything that arrives before read -s turns echo off
out="$( { printf '\n\n'; sleep 1; printf 'secret123\n'; sleep 0.5; printf 'secret123\n'; } \
        | script -qec "bash '$repo/claude-box'" /dev/null 2>&1)"
check "first run: .env created"                    yes "$([ -f "$repo/.env" ] && echo yes)"
check "first run: .env is private"                 600 "$(stat -c %a "$repo/.env")"
check "first run: workspace defaults to ~/workspace" "$HOME/workspace" "$(val PROJECT_DIR)"
check "first run: workspace folder created"        yes "$([ -d "$HOME/workspace" ] && echo yes)"
check "first run: login defaults to claude"        claude "$(val WEB_TERMINAL_USER)"
check "first run: password saved"                  secret123 "$(val WEB_TERMINAL_PASSWORD)"
check "first run: template comment replaced, no duplicate" 1 "$(grep -c 'WEB_TERMINAL_PASSWORD' "$repo/.env")"
check "first run: other settings kept"             7681 "$(val WEB_TERMINAL_PORT)"
check "first run: container uid saved (BOX_UID)"    "$(id -u)" "$(val BOX_UID)"
check "first run: auth hint shown (none configured)" 1 "$(printf '%s' "$out" | grep -c 'auth is not configured')"
check "first run: container gid saved (BOX_GID)"    "$(id -g)" "$(val BOX_GID)"
check "first run: password not echoed"             0 "$(printf '%s' "$out" | grep -c secret123)"
check "first run: image built"                     1 "$(grep -c 'compose -f docker-compose.yml build' "$tmp/docker.log")"
check "first run: web started"                     1 "$(grep -c 'compose -f docker-compose.yml up -d web' "$tmp/docker.log")"

# --- 2. second run: nothing to ask ---
: > "$tmp/docker.log"
out="$(tty_run '')"
check "second run: no questions"                   0 "$(printf '%s' "$out" | grep -c 'Workspace folder\|Password')"
check "second run: no auth hint"                   0 "$(printf '%s' "$out" | grep -c 'auth is not configured')"
check "second run: web started"                    1 "$(grep -c 'up -d web' "$tmp/docker.log")"
check "second run: shows the login"                1 "$(printf '%s' "$out" | grep -c 'login: claude')"
check "second run: prints the https address"       1 "$(printf '%s' "$out" | grep -c 'https://localhost:8443')"
check "second run: no plain http address"          0 "$(printf '%s' "$out" | grep -c 'http://localhost')"
printf 'WEB_TLS=0\n' >> "$repo/.env"
out="$(tty_run '')"
check "TLS off: prints the http address instead"   1 "$(printf '%s' "$out" | grep -c 'http://localhost:7681')"
check "TLS off: no https address"                  0 "$(printf '%s' "$out" | grep -c 'https://localhost')"
sed -i '/^WEB_TLS=0$/d' "$repo/.env"

# --- 3. --setup: custom folder + login; a bad password is refused, Enter generates one ---
out="$(tty_run "~/code/projects\nalice\nbad pass\nshort\n\n" --setup)"
check "setup: tilde path expanded and created"     "$HOME/code/projects" "$(val PROJECT_DIR)"
check "setup: custom login"                        alice "$(val WEB_TERMINAL_USER)"
check "setup: space in password refused"           1 "$(printf '%s' "$out" | grep -c 'avoid spaces')"
check "setup: short password refused"              1 "$(printf '%s' "$out" | grep -c 'At least 8')"
pw="$(val WEB_TERMINAL_PASSWORD)"
check "setup: generated password is 20 alnum chars" 20 "$(printf '%s' "$pw" | tr -dc 'A-Za-z0-9' | wc -c | tr -d ' ')"
check "setup: generated password shown once"       1 "$(printf '%s' "$out" | grep -c "Generated password: $pw")"
check "setup: still a single PROJECT_DIR line"     1 "$(grep -c '^PROJECT_DIR=' "$repo/.env")"

# --- 4. non-interactive without .env: fail with a hint, no docker ---
rm "$repo/.env"; : > "$tmp/docker.log"
bash "$repo/claude-box" </dev/null >/dev/null 2>&1; rc=$?
check "no tty, no .env: exit 1"                    1 "$rc"
check "no tty, no .env: docker untouched"          0 "$(wc -l < "$tmp/docker.log" | tr -d ' ')"

# --- 5. flags ---
printf 'PROJECT_DIR=%s\nWEB_TERMINAL_PASSWORD=abcdefgh\n' "$HOME/workspace" > "$repo/.env"
: > "$tmp/docker.log"
bash "$repo/claude-box" --no-proxy </dev/null >/dev/null 2>&1
check "--no-proxy: proxy overlay used"             1 "$(grep -c 'up -d web' "$tmp/docker.log" | tr -d ' ')"
check "--no-proxy: overlay file passed"            2 "$(grep -c 'docker-compose.no-proxy.yml' "$tmp/docker.log")"
: > "$tmp/docker.log"
bash "$repo/claude-box" --stop </dev/null >/dev/null 2>&1
check "--stop: removes the web container"          1 "$(grep -c 'compose -f docker-compose.yml rm -sf web' "$tmp/docker.log")"

# owner guard: a container started by ANOTHER claude-box (different working dir) must not be stopped
printf '#!/bin/sh
if [ "$1" = inspect ]; then echo /other/box; exit 0; fi
echo "docker $*" >> "%s/docker.log"
exit 0
' "$tmp" > "$bin/docker"; chmod +x "$bin/docker"
: > "$tmp/docker.log"
bash "$repo/claude-box" --stop </dev/null >"$tmp/out" 2>&1; rc=$?
check "owner guard: foreign container refuses to stop"  1 "$rc"
check "owner guard: explains and names no rm"           1 "$(grep -c 'belongs to another claude-box' "$tmp/out")"
check "owner guard: no rm attempted"                    0 "$(grep -c 'rm -sf web' "$tmp/docker.log")"
bash "$repo/claude-box" --bogus </dev/null >/dev/null 2>&1; rc=$?
check "unknown option: exit 2"                     2 "$rc"

echo
[ "$fail" -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
