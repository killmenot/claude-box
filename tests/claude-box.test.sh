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

# --- 1. first run: projects folder, model (default Claude), integrations; login comes via the browser ---
out="$(tty_run '\n\n\n')"
key_file="$repo/home/.claude/web-login-key"
check "first run: .env created"                    yes "$([ -f "$repo/.env" ] && echo yes)"
check "first run: .env is private"                 600 "$(mode "$repo/.env")"
check "first run: projects default to ./workspace" "$repo/workspace" "$(val PROJECT_DIR)"
check "first run: projects folder created"         yes "$([ -d "$repo/workspace" ] && echo yes)"
check "first run: layout dirs created"             yes "$([ -d "$repo/workspace/tasks" ] && [ -d "$repo/workspace/tmp" ] && [ -d "$repo/workspace/repos" ] && [ -d "$repo/workspace/sessions" ] && echo yes)"
check "first run: model asked in wizard"           0 "$(printf '%s' "$out" | grep -c 'Choose \[1/2/3\]')"
check "first run: jira asked in wizard"            0 "$(printf '%s' "$out" | grep -c 'Enable the Jira')"
check "first run: other settings kept"             7681 "$(val WEB_TERMINAL_PORT)"
check "first run: container uid saved (BOX_UID)"    "$(id -u)" "$(val BOX_UID)"
check "first run: container gid saved (BOX_GID)"    "$(id -g)" "$(val BOX_GID)"
check "first run: image built"                     1 "$(grep 'compose -f docker-compose.yml build' "$tmp/docker.log" | grep -vc -- '--print')"
check "first run: web started"                     1 "$(grep -c 'compose -f docker-compose.yml up -d web' "$tmp/docker.log")"
key="$(cat "$key_file" 2>/dev/null)"
check "first run: one-time key written"            32 "${#key}"
check "first run: key file is private"             600 "$(mode "$key_file")"
check "first run: prints the sign-in link"         1 "$(printf '%s' "$out" | grep -c "https://localhost:8443/?key=$key")"
check "first run: says the login is picked in the UI" 1 "$(printf '%s' "$out" | grep -c 'pick a login and password')"

# --- 2. second run: nothing to ask, a fresh key every start ---
: > "$tmp/docker.log"
out="$(tty_run '')"
check "second run: no questions"                   0 "$(printf '%s' "$out" | grep -c 'Press Enter\|Password')"
check "second run: no auth hint"                   0 "$(printf '%s' "$out" | grep -c 'auth is not configured')"
check "second run: web started"                    1 "$(grep -c 'up -d web' "$tmp/docker.log")"
check "second run: a new key"                      no "$([ "$(cat "$key_file")" = "$key" ] && echo yes || echo no)"
check "second run: prints the https address"       2 "$(printf '%s' "$out" | grep -c 'https://localhost:8443')"   # the address + the sign-in link
check "second run: no plain http address"          0 "$(printf '%s' "$out" | grep -c 'http://localhost')"
printf 'WEB_TLS=0\n' >> "$repo/.env"
out="$(tty_run '')"
check "TLS off: prints the http address instead"   1 "$(printf '%s' "$out" | grep -c 'http://localhost:7681/?key=')"
check "TLS off: no https address"                  0 "$(printf '%s' "$out" | grep -c 'https://localhost')"
sed -i.bak '/^WEB_TLS=0$/d' "$repo/.env" && rm -f "$repo/.env.bak"   # -i.bak: GNU and BSD sed alike

# --login: a fresh link, docker untouched
: > "$tmp/docker.log"
out="$(bash "$repo/claude-box" --login </dev/null 2>&1)"
check "--login: prints a link"                     1 "$(printf '%s' "$out" | grep -c "?key=$(cat "$key_file")")"
check "--login: docker untouched"                  0 "$(wc -l < "$tmp/docker.log" | tr -d ' ')"
# --tunnel without any login: refused, the UI still comes up locally
out="$(tty_run '' --tunnel)"
check "--tunnel without a login: refused"          1 "$(printf '%s' "$out" | grep -c 'Tunnel not started: there is no login yet')"
printf '{"user":"alice","salt":"00","hash":"ab"}' > "$repo/home/.claude/web-auth.json"
out="$(tty_run '' --tunnel)"
check "--tunnel with a UI login: allowed"          0 "$(printf '%s' "$out" | grep -c 'Tunnel not started')"

# --- 3. --setup: a custom projects folder ---
out="$(tty_run "~/code/projects\n" --setup)"
check "setup: tilde path expanded and created"     "$HOME/code/projects" "$(val PROJECT_DIR)"
check "setup: still a single PROJECT_DIR line"     1 "$(grep -c '^PROJECT_DIR=' "$repo/.env")"

# --- 3c. certificate trust (sudo stubbed; CERT_TRUST preset in .env) ---
rm "$repo/.env"; mkdir -p "$repo/home/web-certs"; echo dummy-cert > "$repo/home/web-certs/web.crt"
export DOCKER_SOCK_FILE="$tmp/dockersock"; touch "$tmp/dockersock"
export CA_CERT_DST="$tmp/ca-store/claude-box.crt"; mkdir -p "$tmp/ca-store"
printf "#!/bin/sh
if [ \"\$1\" = install ]; then cp \"\$4\" \"\$5\"; fi
echo \"sudo \$*\" >> \"%s/sudo.log\"
exit 0
" "$tmp" > "$bin/sudo"; chmod +x "$bin/sudo"
printf 'PROJECT_DIR=%s\nCERT_TRUST=1\n' "$repo/workspace" > "$repo/.env"
: > "$tmp/sudo.log"
out="$(tty_run '')"
check "cert: preset 1 installs into the host store"   1 "$(grep -c update-ca-certificates "$tmp/sudo.log" | tr -d ' ')"
check "cert: dst holds the certificate"              yes "$([ -f "$tmp/ca-store/claude-box.crt" ] && echo yes)"
check "cert: unchanged cert skips reinstall"          1 "$(grep -c update-ca-certificates "$tmp/sudo.log" | tr -d ' ')"
echo dummy2 > "$repo/home/web-certs/web.crt"
printf 'PROJECT_DIR=%s\nCERT_TRUST=no\n' "$repo/workspace" > "$repo/.env"
out="$(tty_run '')"
check "cert: preset no skips install"                1 "$(grep -c update-ca-certificates "$tmp/sudo.log" | tr -d ' ')"
unset DOCKER_SOCK_FILE CA_CERT_DST
rm -f "$bin/sudo"
rm -f "$bin/sudo"

# --- 4. non-interactive without .env: fail with a hint, no docker ---
rm "$repo/.env"; : > "$tmp/docker.log"
bash "$repo/claude-box" </dev/null >/dev/null 2>&1; rc=$?
check "no tty, no .env: exit 1"                    1 "$rc"
check "no tty, no .env: docker untouched"          0 "$(wc -l < "$tmp/docker.log" | tr -d ' ')"

# --- 5. flags ---
printf 'PROJECT_DIR=%s\nWEB_TERMINAL_PASSWORD=abcdefgh\n' "$repo/workspace" > "$repo/.env"
: > "$tmp/docker.log"
bash "$repo/claude-box" --no-proxy </dev/null >/dev/null 2>&1
check "--no-proxy: proxy overlay used"             1 "$(grep -c 'up -d web' "$tmp/docker.log" | tr -d ' ')"
check "--no-proxy: overlay file passed"            1 "$(grep -c 'docker-compose.no-proxy.yml up -d web' "$tmp/docker.log")"
: > "$tmp/docker.log"
bash "$repo/claude-box" --stop </dev/null >/dev/null 2>&1
check "--stop: removes the web container"          1 "$(grep -c 'rm -sf web' "$tmp/docker.log")"

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
check "linux auto: no ports overlay"               0 "$(grep -c 'docker-compose.ports.yml' "$tmp/docker.log")"
fake_uname Darwin
: > "$tmp/docker.log"
bash "$repo/claude-box" </dev/null >/dev/null 2>&1
check "macOS auto: ports overlay on up"            1 "$(grep -c 'docker-compose.ports.yml up -d web' "$tmp/docker.log")"
fake_uname Linux
printf 'PROJECT_DIR=%s
WEB_TERMINAL_PASSWORD=abcdefgh
WEB_BIND=ports
' "$HOME/workspace" > "$repo/.env"
: > "$tmp/docker.log"
bash "$repo/claude-box" </dev/null >/dev/null 2>&1
check "WEB_BIND=ports: overlay passed to compose"  1 "$(grep -c 'docker-compose.ports.yml up -d web' "$tmp/docker.log" | tr -d ' ')"
# compose renders a bake definition (build --print) -> bake builds it with network.host granted
printf '#!/bin/sh
echo "docker $*" >> "%s/docker.log"
case "$*" in *"build --print"*) echo "{\\"target\\":{}}" ;; *"buildx bake"*) cat > "%s/bake.json" ;; esac
exit 0
' "$tmp" "$tmp" > "$bin/docker"; chmod +x "$bin/docker"
: > "$tmp/docker.log"
bash "$repo/claude-box" </dev/null >/dev/null 2>&1
check "build: bake gets --allow=network.host"      1 "$(grep -c 'buildx bake --allow=network.host -f - web' "$tmp/docker.log")"
check "build: bake reads compose's definition"     '{"target":{}}' "$(cat "$tmp/bake.json" 2>/dev/null)"
check "build: no plain compose build"              0 "$(grep ' compose .* build ' "$tmp/docker.log" | grep -vc -- '--print')"
check "start: no forced recreate"                  0 "$(grep -c -- '--force-recreate' "$tmp/docker.log")"
: > "$tmp/docker.log"
bash "$repo/claude-box" --restart </dev/null >/dev/null 2>&1
check "--restart: builds through bake"             1 "$(grep -c 'buildx bake' "$tmp/docker.log")"
check "--restart: recreates the container"         1 "$(grep -c 'up -d --force-recreate web' "$tmp/docker.log")"
bash "$repo/claude-box" --bogus </dev/null >/dev/null 2>&1; rc=$?
check "unknown option: exit 2"                     2 "$rc"

echo
[ "$fail" -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
