# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repository.

## Language conventions

- **All code comments MUST be written in English.** No Russian (or other
  non-English) comments in any source file — shell, JS, Dockerfile, YAML, HTML, CSS, etc.
- **All user-facing strings in code MUST be in English** too: shell `echo`/`printf`
  output, menu items, prompts, error messages, web UI text, log lines.
- **Documentation (README, INSTALL, etc.) is in English.**
- This applies to new code and to any file you touch — if you edit a file that still
  has non-English text, translate it as part of your change.

## Project shape (quick orientation)

- `claude-box` — host entry point: first-run setup, then brings up the web UI (`--tunnel`, `--stop`, `--status`).
- `scripts/` — the in-container web server in Node (`web-serve.js` entrypoint, `web-sidecar.js`, session registry,
  metrics, search, preview) plus two shell pieces: `web-menu.sh` (ttyd console picker) and `notify.sh` (Claude hook).
  `scripts/web-chat.js` — web chat mode: Claude Agent SDK sessions streamed to the launcher over `/chat/ws`.
  `scripts/web-panel.js` — the right-hand Today panel: GitHub via `gh`, calendar/Jira/Slack via a read-only cheap-model MCP run, served at `/panel`.
  `scripts/cb-session.js` — CLI for agents: start / poll chat sessions through `/chat/api/*`.
  `scripts/web-wire.js` — records what the background agents (Inbox, Today) send to the model and get back: a per-run local HTTPS proxy, served at `/wire`.
  `scripts/web-auth.js` — the web login: one-time sign-in key from `./claude-box`, session cookies, login/password set in the UI (`/auth`).
  `scripts/web-git.js` — GitHub sign-in from the UI via `gh auth login --web` device codes (`/git`).
  `scripts/web-models.js` — model providers (Claude, GLM, Abliteration, custom) and each chat's model; keys in `~/.claude/web-providers.json` (`/models`).
  `scripts/web-tasks.js` — task workspaces (`/workspace/tasks/<slug>` with a git worktree per repo of `/workspace/repos`, kept fresh by a fetch timer), served at `/tasks`.
  `scripts/cb-mcp.js` — the box's own MCP server (`claude-box`): `show_artifact` for the artifact panel; `scripts/web-artifact.js` serves those files sandboxed at `/artifact/`.
  `scripts/web-browser.js` — the session's Browser tab: one Chromium for the box (only with `./claude-box --browser`) on Xvfb, shown via x11vnc on a unix socket + noVNC at `/browser/`; Claude's playwright MCP drives it over CDP.
  `scripts/web-code.js` — the session's Code tab: code-server (only with `./claude-box --vscode`) on a private unix socket, proxied at `/code/`.
  `scripts/claude-default.sh` — starts console `claude` with the default model and, in a task folder, its repos as `--add-dir`.
- `claude-defaults/` — seeded into `~/.claude` at startup: `settings.json` (once), `mcp.json` (merged every start),
  `skills/<name>/` (copied every start unless the user deleted the `.claude-box-managed` marker), e.g. `skills/pr-review`.
- `site/` — the static marketing landing for **claude-box.dev** (Tailwind, self-hosted
  fonts, no CDN; deploy with `./site/deploy.sh`).
- `html/` — the in-product web terminal / session launcher pages.

## Tests

- **Run the tests on macOS and on Linux separately — both must pass** before saying a change works:
  `bash tests/run.sh` (this machine) and `bash tests/run.sh --linux` (inside the test box's image).
  Report the two results separately.
- **Tests and live checks use the test box: `.env.test`** (`./claude-box --env test`, its own
  `home-test/`). `tests/run.sh --linux` takes that box's image; build or refresh it with
  `./claude-box --env test` (or `--env test --restart`). To see a change in the real UI, restart the
  test box. The other `.env.*` files are the user's working boxes: never start, restart or stop them
  for a check unless the user asks. Never read any `.env*` file (the test one included).
- The host here is often a Mac: `./claude-box` and `tests/claude-box.test.sh` run on BSD tools there
  (`stat`, `sed -i`, `script`, `uname`). Keep both portable: no GNU-only flags without a fallback.
- Server-side code (`scripts/*.js`) runs only inside the Linux image; a test that needs Linux or a
  tool the host lacks (tmux, `/proc`) skips on the host instead of failing.

## Secrets & safety

- Never read, print, or commit `.env` or `certs/*.crt` (they are gitignored and
  permission-denied). `.env.example` is the public template — keep it English and secret-free.
