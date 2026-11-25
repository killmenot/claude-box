#!/usr/bin/env bash
# Tests for the host entry point ./claude-box: first-run setup (.env, projects folder, sign-in link) and the
# docker calls it makes. docker is a stub that only logs its arguments; a pty (script(1)) stands
# in for the user's terminal. Run: bash tests/claude-box.test.sh
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
fail=0
check(){ if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1: expected [$2] got [$3]"; fail=1; fi; }
command -v script >/dev/null 2>&1 || { echo "SKIP: script(1) not found"; exit 0; }

tmp="$(cd "$(mktemp -d)" && pwd -P)"   # the real path: on macOS /var is a symlink to /private/var
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home"; mkdir -p "$HOME"
repo="$tmp/repo"; mkdir -p "$repo"
cp "$ROOT/claude-box" "$ROOT/docker-compose.yml" "$ROOT/docker-compose.no-proxy.yml" "$repo/"
# a minimal template in the shape of the real one: placeholder workspace, commented-out password
printf '%s\n' 'PROJECT_DIR=/path/to/your/project' 'WEB_TERMINAL_PORT=7681' '# WEB_TERMINAL_PASSWORD=' > "$repo/.env.example"
bin="$tmp/bin"; mkdir -p "$bin"
printf '#!/bin/sh\necho "docker $*" >> "%s/docker.log"\n' "$tmp" > "$bin/docker"; chmod +x "$bin/docker"
export PATH="$bin:$PATH"
# the docker calls, without the --env-file every compose call carries (checked on its own below)
dlog(){ sed -E 's/ --env-file [^ ]+//' "$tmp/docker.log"; }
# `uname -s` picks the network mode (auto): pinned to Linux (host network, no overlay) so the
# expected docker calls are the same on every machine; the auto-mode checks below switch it
fake_uname(){ printf '#!/bin/sh\necho %s\n' "$1" > "$bin/uname"; chmod +x "$bin/uname"; }
fake_uname Linux

# run claude-box on a pty, feeding <input>; prints the transcript. util-linux script (Linux) takes
# the command as -c; BSD script (macOS) takes it as arguments and drops input that arrives before
# the pty is up, so there the input is sent a moment later.
if script -qec true /dev/null >/dev/null 2>&1; then
  tty_run(){ printf '%b' "$1" | script -qec "bash '$repo/claude-box' ${2:-}" /dev/null 2>&1; }
else
  # shellcheck disable=SC2086  # $2: optional flags, split on purpose
  tty_run(){ { sleep 0.5; printf '%b' "$1"; sleep 0.5; } | script -q /dev/null bash "$repo/claude-box" ${2:-} 2>&1; }
fi
# file mode as octal: GNU stat (-c) or BSD stat (-f)
mode(){ stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
val(){ grep -E "^$1=" "$repo/.env" | tail -n1 | cut -d= -f2-; }

# --- 1. first run: the projects folder and the git identity are asked; the web login is set later in the browser ---
# the host's own git identity is the default the setup offers
printf '[user]\n\tname = Host User\n\temail = host@example.com\n' > "$HOME/.gitconfig"
out="$(tty_run '\n\n\n')"
key_file="$repo/home/.claude/web-login-key"
check "first run: .env created"                    yes "$([ -f "$repo/.env" ] && echo yes)"
check "first run: .env is private"                 600 "$(mode "$repo/.env")"
check "first run: projects default to ./workspace" "$repo/workspace" "$(val PROJECT_DIR)"
check "first run: projects folder created"         yes "$([ -d "$repo/workspace" ] && echo yes)"
check "first run: no password asked"               0 "$(printf '%s' "$out" | grep -c 'Password (Enter\|Repeat password')"
check "first run: no password in .env"             "" "$(val WEB_TERMINAL_PASSWORD)"
check "first run: other settings kept"             7681 "$(val WEB_TERMINAL_PORT)"
check "first run: container uid saved (BOX_UID)"    "$(id -u)" "$(val BOX_UID)"
check "first run: auth hint shown (none configured)" 1 "$(printf '%s' "$out" | grep -c 'auth is not configured')"
check "first run: git name defaults to the host's" "Host User" "$(val GIT_USER_NAME)"
check "first run: git email defaults to the host's" "host@example.com" "$(val GIT_USER_EMAIL)"
check "first run: container gid saved (BOX_GID)"    "$(id -g)" "$(val BOX_GID)"
check "first run: image built"                     1 "$(dlog | grep 'compose -f docker-compose.yml build' | grep -vc -- '--print')"
check "first run: web started"                     1 "$(dlog | grep -c 'compose -f docker-compose.yml up -d web')"
key="$(cat "$key_file" 2>/dev/null)"
check "first run: one-time key written"            32 "${#key}"
check "first run: key file is private"             600 "$(mode "$key_file")"
check "first run: prints the sign-in link"         1 "$(printf '%s' "$out" | grep -c "https://localhost:8443/?key=$key")"
check "first run: http link with the same key"     1 "$(printf '%s' "$out" | grep -c "http://localhost:7681/?key=$key")"
check "first run: says the login is picked in the UI" 1 "$(printf '%s' "$out" | grep -c 'pick a login and password')"

# --- 2. second run: nothing to ask, a fresh key every start ---
: > "$tmp/docker.log"
out="$(tty_run '')"
check "second run: no questions"                   0 "$(printf '%s' "$out" | grep -c 'Press Enter\|Password\|Commit name')"
check "second run: no auth hint"                   0 "$(printf '%s' "$out" | grep -c 'auth is not configured')"
check "second run: web started"                    1 "$(dlog | grep -c 'up -d web')"
check "second run: a new key"                      no "$([ "$(cat "$key_file")" = "$key" ] && echo yes || echo no)"
check "second run: prints the https address"       2 "$(printf '%s' "$out" | grep -c 'https://localhost:8443')"   # the address + the sign-in link
check "second run: plain http address too"         2 "$(printf '%s' "$out" | grep -c 'http://localhost:7681')"    # the address + the sign-in link
printf 'WEB_TLS=0\n' >> "$repo/.env"
out="$(tty_run '')"
check "TLS off: prints the http address instead"   1 "$(printf '%s' "$out" | grep -c 'http://localhost:7681/?key=')"
check "TLS off: no https address"                  0 "$(printf '%s' "$out" | grep -c 'https://localhost')"
sed -i.bak '/^WEB_TLS=0$/d' "$repo/.env" && rm -f "$repo/.env.bak"   # -i.bak: GNU and BSD sed alike

# --login: a fresh link, docker untouched
: > "$tmp/docker.log"
out="$(bash "$repo/claude-box" --login </dev/null 2>&1)"
check "--login: https and http links, one key"     2 "$(printf '%s' "$out" | grep -c "?key=$(cat "$key_file")")"
check "--login: docker untouched"                  0 "$(wc -l < "$tmp/docker.log" | tr -d ' ')"
# --tunnel without any login: refused, the UI still comes up locally
out="$(tty_run '' --tunnel)"
check "--tunnel without a login: refused"          1 "$(printf '%s' "$out" | grep -c 'Tunnel not started: there is no login yet')"
printf '{"user":"alice","salt":"00","hash":"ab"}' > "$repo/home/.claude/web-auth.json"
out="$(tty_run '' --tunnel)"
check "--tunnel with a UI login: allowed"          0 "$(printf '%s' "$out" | grep -c 'Tunnel not started')"

# --- 3. --setup: a custom projects folder ---
out="$(tty_run "~/code/projects\nBox Bot\nnot-an-email\nbot@example.com\n" --setup)"
check "setup: tilde path expanded and created"     "$HOME/code/projects" "$(val PROJECT_DIR)"
check "setup: still a single PROJECT_DIR line"     1 "$(grep -c '^PROJECT_DIR=' "$repo/.env")"
check "setup: git name changed"                    "Box Bot" "$(val GIT_USER_NAME)"
check "setup: a non-email is asked again"          1 "$(printf '%s' "$out" | grep -c 'is not an email address')"
check "setup: git email changed"                   "bot@example.com" "$(val GIT_USER_EMAIL)"
check "setup: one GIT_USER_EMAIL line"             1 "$(grep -c '^GIT_USER_EMAIL=' "$repo/.env")"
rm -f "$HOME/.gitconfig"

# --- 4. non-interactive without .env: fail with a hint, no docker ---
rm "$repo/.env"; : > "$tmp/docker.log"
bash "$repo/claude-box" </dev/null >/dev/null 2>&1; rc=$?
check "no tty, no .env: exit 1"                    1 "$rc"
check "no tty, no .env: docker untouched"          0 "$(wc -l < "$tmp/docker.log" | tr -d ' ')"

# --- 5. flags ---
printf 'PROJECT_DIR=%s\nWEB_TERMINAL_PASSWORD=abcdefgh\n' "$repo/workspace" > "$repo/.env"
: > "$tmp/docker.log"
bash "$repo/claude-box" --no-proxy </dev/null >/dev/null 2>&1
check "--no-proxy: proxy overlay used"             1 "$(dlog | grep -c 'up -d web' | tr -d ' ')"
check "--no-proxy: overlay file passed"            1 "$(dlog | grep -c 'docker-compose.no-proxy.yml up -d web')"
: > "$tmp/docker.log"
bash "$repo/claude-box" --stop </dev/null >/dev/null 2>&1
check "--stop: removes the web container"          1 "$(dlog | grep -c 'compose -f docker-compose.yml rm -sf web')"

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
check "owner guard: no rm attempted"                    0 "$(dlog | grep -c 'rm -sf web')"
# network mode: auto on Linux stays host; WEB_BIND=ports adds the overlay
mkdir -p "$HOME/workspace"
printf '#!/bin/sh
echo "docker $*" >> "%s/docker.log"
exit 0
' "$tmp" > "$bin/docker"; chmod +x "$bin/docker"
printf 'PROJECT_DIR=%s
WEB_TERMINAL_PASSWORD=abcdefgh
' "$HOME/workspace" > "$repo/.env"
fake_uname Linux
: > "$tmp/docker.log"
bash "$repo/claude-box" </dev/null >/dev/null 2>&1
check "linux auto: no ports overlay"               0 "$(dlog | grep -c 'docker-compose.ports.yml')"
fake_uname Darwin
: > "$tmp/docker.log"
bash "$repo/claude-box" </dev/null >/dev/null 2>&1
check "macOS auto: ports overlay on up"            1 "$(dlog | grep -c 'docker-compose.ports.yml up -d web')"
fake_uname Linux
printf 'PROJECT_DIR=%s
WEB_TERMINAL_PASSWORD=abcdefgh
WEB_BIND=ports
' "$HOME/workspace" > "$repo/.env"
: > "$tmp/docker.log"
bash "$repo/claude-box" </dev/null >/dev/null 2>&1
check "WEB_BIND=ports: overlay passed to compose"  1 "$(dlog | grep -c 'docker-compose.ports.yml up -d web' | tr -d ' ')"
# compose renders a bake definition (build --print) -> bake builds it with network.host granted
printf '#!/bin/sh
echo "docker $*" >> "%s/docker.log"
case "$*" in *"build --print"*) echo "{\\"target\\":{}}" ;; *"buildx bake"*) cat > "%s/bake.json" ;; esac
exit 0
' "$tmp" "$tmp" > "$bin/docker"; chmod +x "$bin/docker"
: > "$tmp/docker.log"
bash "$repo/claude-box" </dev/null >/dev/null 2>&1
check "build: bake gets --allow=network.host"      1 "$(dlog | grep -c 'buildx bake --allow=network.host -f - web')"
check "build: bake reads compose's definition"     '{"target":{}}' "$(cat "$tmp/bake.json" 2>/dev/null)"
check "build: no plain compose build"              0 "$(dlog | grep ' compose .* build ' | grep -vc -- '--print')"
check "start: no forced recreate"                  0 "$(dlog | grep -c -- '--force-recreate')"
: > "$tmp/docker.log"
bash "$repo/claude-box" --restart </dev/null >/dev/null 2>&1
check "--restart: builds through bake"             1 "$(dlog | grep -c 'buildx bake')"
check "--restart: recreates the container"         1 "$(dlog | grep -c 'up -d --force-recreate web')"

# --- 6. --env: another env file is another box (own env file for compose, own home, own label) ---
printf '#!/bin/sh
echo "docker $* | env=$CLAUDE_BOX_ENV_FILE home=$BOX_HOME" >> "%s/docker.log"
exit 0
' "$tmp" > "$bin/docker"; chmod +x "$bin/docker"
printf 'PROJECT_DIR=%s\nWEB_TERMINAL_PASSWORD=abcdefgh\nCLAUDE_BOX_NAME=cb-ws1\n' "$HOME/workspace" > "$repo/.env.ws1"
for form in "--env ws1" "--env .env.ws1" "--env=ws1"; do
  : > "$tmp/docker.log"
  # shellcheck disable=SC2086  # the flag and its value, split on purpose
  bash "$repo/claude-box" $form </dev/null >/dev/null 2>&1
  check "$form: compose reads .env.ws1"            1 "$(grep -c -- "--env-file $repo/.env.ws1 up -d web" "$tmp/docker.log")"
  check "$form: container gets .env.ws1 + home-ws1" 1 "$(grep 'up -d web' "$tmp/docker.log" | grep -c "env=$repo/.env.ws1 home=./home-ws1$")"
done
check "--env ws1: home-ws1 created"                yes "$([ -d "$repo/home-ws1" ] && echo yes)"
check "--env ws1: sign-in key in home-ws1"         32 "$(wc -c < "$repo/home-ws1/.claude/web-login-key" | tr -d ' ' | awk '{print $1-1}')"
: > "$tmp/docker.log"
CLAUDE_BOX_ENV=ws1 bash "$repo/claude-box" </dev/null >/dev/null 2>&1
check "CLAUDE_BOX_ENV=ws1: same as --env ws1"      1 "$(grep -c -- "--env-file $repo/.env.ws1 up -d web" "$tmp/docker.log")"
: > "$tmp/docker.log"
bash "$repo/claude-box" </dev/null >/dev/null 2>&1
check "no --env: .env and home/"                   1 "$(grep 'up -d web' "$tmp/docker.log" | grep -c -- "--env-file $repo/.env .*env=$repo/.env home=./home$")"
mkdir -p "$tmp/elsewhere"; cp "$repo/.env.ws1" "$tmp/elsewhere/box.env"
: > "$tmp/docker.log"
( cd "$tmp" && bash "$repo/claude-box" --env elsewhere/box.env </dev/null >/dev/null 2>&1 )
check "--env a/path: that file, from the caller's folder" 1 "$(grep -c -- "--env-file $tmp/elsewhere/box.env up -d web" "$tmp/docker.log")"
bash "$repo/claude-box" --env example </dev/null >/dev/null 2>&1; rc=$?
check "--env example: refused (the template)"      2 "$rc"
bash "$repo/claude-box" --env </dev/null >/dev/null 2>&1; rc=$?
check "--env without a value: exit 2"              2 "$rc"
# a container of the same name that this checkout started from .env must not be replaced by .env.ws1
printf '#!/bin/sh
case "$*" in
  *working_dir*) echo "%s"; exit 0 ;;
  *claude-box.env*) echo "%s/.env"; exit 0 ;;
esac
echo "docker $*" >> "%s/docker.log"
exit 0
' "$repo" "$repo" "$tmp" > "$bin/docker"; chmod +x "$bin/docker"
: > "$tmp/docker.log"
bash "$repo/claude-box" --env ws1 </dev/null >"$tmp/out" 2>&1; rc=$?
check "env guard: .env's container not replaced"   1 "$rc"
check "env guard: names the other env file"        1 "$(grep -c "belongs to the box of $repo/.env" "$tmp/out")"
check "env guard: no up attempted"                 0 "$(dlog | grep -c 'up -d web')"
: > "$tmp/docker.log"
bash "$repo/claude-box" </dev/null >/dev/null 2>&1
check "env guard: its own env file passes"         1 "$(dlog | grep -c 'up -d web')"

bash "$repo/claude-box" --bogus </dev/null >/dev/null 2>&1; rc=$?
check "unknown option: exit 2"                     2 "$rc"

echo
[ "$fail" -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
