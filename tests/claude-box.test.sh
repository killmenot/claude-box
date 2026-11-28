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
check "second run: no questions"                   0 "$(printf '%s' "$out" | grep -c 'Press Enter\|Password')"
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
out="$(tty_run "~/code/projects\n" --setup)"
check "setup: tilde path expanded and created"     "$HOME/code/projects" "$(val PROJECT_DIR)"
check "setup: still a single PROJECT_DIR line"     1 "$(grep -c '^PROJECT_DIR=' "$repo/.env")"
rm -f "$HOME/.gitconfig"

# --- 3b. Docker access: root-equivalent, so asked and off unless the answer is y ---
export DOCKER_SOCK_FILE="$tmp/dockersock"; touch "$tmp/dockersock"
out="$(tty_run "\n\n" --setup)"
check "docker: Enter keeps it off"                 0 "$(val DOCKER_ACCESS)"
check "docker: the question says root-equivalent"  1 "$(printf '%s' "$out" | grep -c 'root-equivalent on this machine')"
out="$(tty_run "\ny\n" --setup)"
check "docker: y turns it on"                      1 "$(val DOCKER_ACCESS)"
check "docker: no group id stored (entrypoint's job)" 0 "$(grep -c '^DOCKER_GID=' "$repo/.env")"
unset DOCKER_SOCK_FILE

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
check "--no-proxy: proxy overlay used"             1 "$(dlog | grep -c 'up -d web' | tr -d ' ')"
check "--no-proxy: overlay file passed"            1 "$(dlog | grep -c 'docker-compose.no-proxy.yml up -d web')"
check "no tty: Docker access never granted"        no "$([ "$(val DOCKER_ACCESS)" = 1 ] && echo yes || echo no)"
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

check "no --browser: no browser overlay"           0 "$(dlog | grep -c 'docker-compose.browser.yml')"
check "no --browser: no weekly refresh"            0 "$(dlog | grep -c 'BROWSER_REFRESH')"
: > "$tmp/docker.log"
bash "$repo/claude-box" --browser </dev/null >/dev/null 2>&1
check "--browser: overlay on build and up"         1 "$(dlog | grep -c 'docker-compose.browser.yml.* up -d web')"
check "--browser: Chromium refreshed weekly"        1 "$(dlog | grep -c "BROWSER_REFRESH=$(date +%G-%V)")"
out="$(bash "$repo/claude-box" --browser --tunnel </dev/null 2>&1)"
check "--tunnel with --browser: warns"             1 "$(printf '%s' "$out" | grep -c 'tunnel with --browser')"

# --- EXTRA_HOSTS: a throwaway compose overlay with extra_hosts; the stub copies it while it exists ---
printf '#!/bin/sh
echo "docker $*" >> "%s/docker.log"
case "$*" in *"up -d web"*)
  for a in "$@"; do case "$a" in *claude-box-hosts.*) cp "$a" "%s/hosts.yml"; echo "$a" > "%s/hosts.path" ;; esac; done ;;
esac
exit 0
' "$tmp" "$tmp" "$tmp" > "$bin/docker"; chmod +x "$bin/docker"
printf 'PROJECT_DIR=%s\nWEB_TERMINAL_PASSWORD=abcdefgh\nEXTRA_HOSTS="swiftdrive.local, api.local=10.0.0.5 v6.local:::1"\n' "$HOME/workspace" > "$repo/.env"
: > "$tmp/docker.log"; rm -f "$tmp/hosts.yml" "$tmp/hosts.path"
out="$(bash "$repo/claude-box" </dev/null 2>&1)"
check "EXTRA_HOSTS: overlay passed on up"          1 "$(dlog | grep 'up -d web' | grep -c 'claude-box-hosts\.')"
check "EXTRA_HOSTS: rendered overlay" "$(printf 'services:\n  web:\n    extra_hosts:\n      swiftdrive.local: "host-gateway"\n      api.local: "10.0.0.5"\n      v6.local: "::1"')" "$(cat "$tmp/hosts.yml" 2>/dev/null)"
check "EXTRA_HOSTS: overlay removed after the run" no "$([ -e "$(cat "$tmp/hosts.path" 2>/dev/null)" ] && echo yes || echo no)"
check "EXTRA_HOSTS: listed in the summary"         1 "$(printf '%s' "$out" | grep -c 'extra hosts: swiftdrive.local, api.local, v6.local')"
printf 'PROJECT_DIR=%s\nWEB_TERMINAL_PASSWORD=abcdefgh\nEXTRA_HOSTS=bad"name\n' "$HOME/workspace" > "$repo/.env"
: > "$tmp/docker.log"
bash "$repo/claude-box" </dev/null >"$tmp/out" 2>&1; rc=$?
check "EXTRA_HOSTS: a bad name refuses to start"  1 "$rc"
check "EXTRA_HOSTS: says which entry"              1 "$(grep -c "bad host name in 'bad\"name'" "$tmp/out")"
check "EXTRA_HOSTS: nothing started"               0 "$(dlog | grep -c 'up -d web')"
printf 'PROJECT_DIR=%s\nWEB_TERMINAL_PASSWORD=abcdefgh\nEXTRA_HOSTS=\n' "$HOME/workspace" > "$repo/.env"
: > "$tmp/docker.log"
bash "$repo/claude-box" </dev/null >/dev/null 2>&1
check "EXTRA_HOSTS empty: no overlay"              0 "$(dlog | grep -c 'claude-box-hosts\.')"

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
