#!/bin/sh
# Start claude the way the box's chats do:
# - with the default model picked in Settings > Models (web-models.js writes it as exports to
#   ~/.claude/web-provider.env); chat sessions get their provider's env from the server instead;
# - in a task folder (tasks/<slug>/ with .task.json), every repo of the task as an extra directory,
#   so each repo's CLAUDE.md and skills load (the same as web-chat.js does for chats).
# Console (tmux) sessions start through this.
f="${HOME:-/home/node}/.claude/web-provider.env"
# the box browser's window for this session (web-browser.js): the tmux session's name
if [ -z "${CB_SESSION:-}" ] && [ -n "${TMUX:-}" ]; then
  CB_SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null) && export CB_SESSION
fi
[ -r "$f" ] && . "$f"
if [ -f .task.json ]; then
  for d in */; do
    d="${d%/}"
    [ -e "$d/.git" ] && set -- --add-dir "$PWD/$d" "$@"
  done
  export CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1
fi
exec claude "$@"
