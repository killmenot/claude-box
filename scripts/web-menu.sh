#!/usr/bin/env bash
# ttyd landing: for each connection (tab) — an fzf picker of tmux sessions.
# "New session" / entering a new name -> pick a folder -> tmux new-session running claude there;
# selecting an existing one -> tmux attach; "Rename session…" -> rename-session.
# Renaming is a separate menu item (not a hotkey): F2/Ctrl-R is intercepted by
# the browser. This way different tabs hold different claude sessions.
#
# Deep-link/registry: the claude-notify hook keeps the records and tokens (web-sessions.json).
# We set ?id= in the browser RELIABLY ourselves — OSC 5379 in stdout before attach (see emit_token),
# rather than through the pane tty from the hook. Argument $1 (ttyd --url-arg from ?id=) is the session token:
# alive → attach, dead (after a restart) → recreate in cwd and claude --resume. new:<name> — create.
set -uo pipefail

NEW='•  New session'
REN='•  ✎ Rename session…'

# next free name web-N (if the user did not enter their own)
next_name() {
  local i=1
  while tmux has-session -t "web-$i" 2>/dev/null; do i=$((i + 1)); done
  printf 'web-%s' "$i"
}

# Identity of a session for the deep link is the @cbtoken stamp, NOT the tmux name: next_name()
# hands out the lowest free web-N, so after a restart (or a rename) an old record's name can be
# taken by an unrelated session. The stamp is put on by claude-notify (hook) and by the resume
# path below; `claude-web-registry owns` is what checks it.
stamp_token() { tmux set-option -t "$1" @cbtoken "$2" 2>/dev/null || true; }
session_token() { tmux show-option -t "$1" -qv @cbtoken 2>/dev/null; }

# Path -> ~/.claude/projects directory name, exactly the way Claude Code encodes it:
# every character outside [A-Za-z0-9] becomes '-'.
proj_encode() { printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g'; }

# Directory to run `claude --resume <id>` from. The registry keeps the cwd reported by the hook,
# i.e. Claude's CURRENT directory — it drifts as soon as the session cd's into a subfolder, while
# the session file stays in the project dir of the directory Claude was LAUNCHED in. So we walk up
# from the recorded cwd and take the first level whose project dir actually holds <id>.jsonl.
resume_cwd() {
  local cid="$1" d="$2" enc
  [ -n "$cid" ] || return 1
  while [ -n "$d" ] && [ "$d" != "/" ] && [ "$d" != "." ]; do
    enc="$(proj_encode "$d")"
    if [ -f "$HOME/.claude/projects/$enc/$cid.jsonl" ] && [ -d "$d" ]; then
      printf '%s' "$d"; return 0
    fi
    d="$(dirname "$d")"
  done
  return 1
}

# existing sessions: "<name>  (N windows)", most recent on top
list_sessions() {
  tmux list-sessions -F '#{session_activity}#{session_name}  (#{session_windows} windows)' 2>/dev/null \
    | sort -rn | sed -E 's/^[0-9]+//'
}

# Emit the private OSC 5379 with the session token to stdout (ttyd -> browser -> index.html
# sets ?id=). More reliable than the claude-notify hook in the pane tty: stdout goes straight to xterm.
# The token comes from the session's own stamp. Only a session started before stamping existed has
# none — then we fall back to the registry, but ONLY if a single record claims that name: guessing
# among several would put someone else's ?id in the address bar, and the next visit to that link
# would resume the wrong conversation.
emit_token() {
  local sess="$1" token
  [ -n "$sess" ] || return 0
  token="$(session_token "$sess")"
  [ -n "$token" ] || token="$(claude-web-registry list 2>/dev/null \
    | jq -r --arg s "$sess" '[.[] | select(.tmuxSession==$s)] | if length == 1 then .[0].token else empty end' 2>/dev/null)"
  [ -n "$token" ] && printf '\033]5379;%s\007' "$token"
  return 0
}

# enter a live session (+ OSC with the token to the browser before attach)
enter() {
  emit_token "$1"
  exec tmux -u attach-session -t "$1"        # -u: force UTF-8
}

# enter via deep-link token through the registry (durable, survives a restart):
# tmux session alive -> attach; dead (after a restart) -> recreate + claude --resume.
enter_by_token() {
  local token="$1" rec cid cwd name sess nm rcwd state
  rec="$(claude-web-registry get "$token" 2>/dev/null)" || return 1
  cid="$(printf '%s'  "$rec" | jq -r '.claudeSessionId // empty')"
  cwd="$(printf '%s'  "$rec" | jq -r '.cwd // empty')"
  name="$(printf '%s' "$rec" | jq -r '.name // empty')"
  state="$(printf '%s' "$rec" | jq -r '.state // empty')"
  # Attach only to a session that PROVABLY belongs to this token (stamp, not name — see above).
  sess="$(claude-web-registry owns "$token" 2>/dev/null || true)"
  if [ -n "$sess" ]; then
    printf '\033]5379;%s\007' "$token"      # confirm ?id= in the browser
    exec tmux -u attach-session -t "$sess"
  fi
  rcwd="$(resume_cwd "$cid" "$cwd")" || return 1
  nm="${name:-resume}"
  tmux has-session -t "$nm" 2>/dev/null && nm="$nm-$token"
  tmux -u new-session -d -s "$nm" -c "$rcwd" "claude --resume '$cid'" 2>/dev/null || return 1
  stamp_token "$nm" "$token"
  # The record still points at the name this session had before the restart; re-point it now so the
  # launcher shows the card as live without waiting for the first hook of the resumed session.
  claude-web-registry upsert --claude-id "$cid" --cwd "$cwd" --name "$name" \
    --state "$state" --tmux "$nm" >/dev/null 2>&1 || true
  printf '\033]5379;%s\007' "$token"        # same token after resume
  exec tmux -u attach-session -t "$nm"
}

# Plain bash in the container (the launcher's "Terminal"): one persistent tmux session per folder,
# so reopening the terminal returns to the same shell with its history.
shell_and_enter() {
  local dir="${1:-/workspace}" nm
  case "$dir" in /workspace|/workspace/*) ;; *) dir=/workspace ;; esac   # stay inside the workspace
  [ -d "$dir" ] || dir=/workspace
  nm="shell"; [ "$dir" != /workspace ] && nm="shell-$(basename "$dir" | tr -c 'A-Za-z0-9_-' '-')"
  tmux has-session -t "=$nm" 2>/dev/null || tmux -u new-session -d -s "$nm" -c "$dir" bash -l 2>/dev/null || true
  exec tmux -u attach-session -t "$nm"
}

# Folder for a new console session: an fzf picker over the workspace subfolders (most recent on
# top) + the workspace root. Esc -> the root.
pick_dir() {
  local ws="${WORKSPACE_DIR:-/workspace}" d
  d="$( { printf '%s\n' "$ws"
          find "$ws" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%T@\t%p\n' 2>/dev/null \
            | sort -rn | cut -f2-; } \
        | fzf --height=60% --reverse --border=rounded --pointer='▶' \
              --color='pointer:208,prompt:208' --prompt='folder ▸ ' \
              --header='Enter — start Claude in this folder · Esc — workspace root' 2>/dev/null)"
  [ -n "$d" ] && [ -d "$d" ] || d="$ws"
  printf '%s' "$d"
}

# create a new session (claude in a picked folder) and enter it
new_and_enter() {
  local name="$1" dir
  dir="$(pick_dir)"
  printf '%s  starting new session: %s (%s)%s\n' "$O" "$name" "$dir" "$R"
  tmux -u new-session -d -s "$name" -c "$dir" claude 2>/dev/null || true
  enter "$name"
}

O=$'\033[38;5;208m'; R=$'\033[0m'

# Sourced with CLAUDE_WEB_MENU_LIB=1 (tests) -> expose the helpers, don't start the picker.
[ "${CLAUDE_WEB_MENU_LIB:-}" = "1" ] && return 0

# Deep-link: $1 = token (via ttyd --url-arg from ?id=) or new:<name> from the launcher.
if [ -n "${1:-}" ]; then
  case "$1" in
    new:*) nm="${1#new:}"; new_and_enter "${nm:-$(next_name)}";;   # explicit creation
    shell:*) shell_and_enter "${1#shell:}";;      # plain bash in the container (launcher "Terminal")
    *)     enter_by_token "$1";;            # token; not found -> fall through to the menu below
  esac
fi

# The picker runs in a loop: after renaming we show it again.
while true; do
  mapfile -t sessions < <(list_sessions)

  # No sessions yet — no need for the picker, start a new one right away.
  if [ "${#sessions[@]}" -eq 0 ]; then
    new_and_enter "$(next_name)"
  fi

  # --print-query: 1st line of stdout = query; 2nd = the selected line.
  out="$(printf '%s\n' "$NEW" "${sessions[@]}" "$REN" \
    | fzf --print-query --height=60% --reverse --border=rounded --pointer='▶' \
          --color='pointer:208,prompt:208' --prompt='session ▸ ' \
          --header='Enter — select/create · type a name for a new one · Esc — close')"
  rc=$?
  # Esc/Ctrl-C (>=130) -> just close the tab
  [ "$rc" -ge 130 ] && exit 0

  query="$(printf '%s\n' "$out" | sed -n 1p)"
  choice="$(printf '%s\n' "$out" | sed -n 2p)"

  # "Rename…" item: a second picker (which session) -> new name -> back to the menu.
  if [ "$choice" = "$REN" ]; then
    target="$(list_sessions | fzf --height=60% --reverse --border=rounded --pointer='▶' \
                --color='pointer:208,prompt:208' --prompt='rename ▸ ' \
                --header='choose a session · Esc — back')" || continue
    [ -z "$target" ] && continue
    old="${target%% *}"                 # the first token of the line is the session name
    printf '%s  rename "%s" (empty + Enter — cancel)%s\n' "$O" "$old" "$R"
    read -rp '  new name: ' newname
    if [ -n "$newname" ] && [ "$newname" != "$old" ]; then
      tmux rename-session -t "$old" "$newname" 2>/dev/null \
        || printf '  failed (name taken or invalid characters . :)\n' >&2
    fi
    continue
  fi

  # Enter: empty selection/"New session" -> new (name = query or web-N); otherwise attach.
  if [ -z "$choice" ] || [ "$choice" = "$NEW" ]; then
    new_and_enter "${query:-$(next_name)}"
  else
    enter "${choice%% *}"               # the first token of the line is the session name
  fi
done
