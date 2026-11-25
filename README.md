<p align="center">
  <img src="site/brand-mark.svg" alt="claude-box" width="84" height="84">
</p>

# claude-box

Isolated execution of **Claude Code** in Docker: access to a single folder only (`/workspace`),
with state and plugins preserved between runs.

<p align="center">
  <img src="docs/screenshots/02-chat.png" alt="claude-box: a web chat session with tool calls, the session sidebar and the Today panel" width="900">
</p>

## Running

```bash
./claude-box            # build (cached) and start the web UI, print its address
./claude-box --status   # is it running, where, which console sessions
./claude-box --stop     # stop it (running sessions come back on the next start)
./claude-box --restart  # rebuild (cached) and recreate the container
./claude-box --setup    # re-run the first-run setup
./claude-box --install  # print how to add claude-box to PATH (changes nothing)
```

<p align="center">
  <img src="docs/screenshots/00-start.png" alt="./claude-box starts the web UI; docker ps shows the claude-box-web container" width="760">
</p>

claude-box is a web UI: open the printed address (`https://localhost:8443`, which also enables clipboard
and notifications) and work with Claude in the browser — as a chat or in a real terminal.
The old `--web` / `--build` flags are still accepted and do the same as a plain `./claude-box`.

**First start.** `claude-box` asks one question in the terminal:

1. creates `.env` from `.env.example` if there is none (tokens and the rest live there);
2. asks for the **projects folder** — the host folder with your projects, mounted as `/workspace`
   (default `workspace/` next to the script, git-ignored, created if missing) and saves it as `PROJECT_DIR`;
3. prints a **one-time sign-in link** (`https://localhost:8443/?key=…`, valid 15 minutes, works once),
   plus the same key on plain http (`http://localhost:7681/?key=…`): the https one uses a self-signed
   certificate the browser warns about until you trust it, the http one has no warning (localhost is a
   secure context either way). Open either: the browser is signed in, and the first visit asks for a **login and password** (for your
   phone, other computers and the public tunnel), then offers to **connect GitHub** (the same device
   code as `gh auth login --web`; optional, also in Settings).

Every start prints a fresh link; `./claude-box --login` prints one without restarting anything.
The login and password can be changed later in **Settings → Access**; they are kept as a scrypt hash
in `home/.claude/web-auth.json`. An older `WEB_TERMINAL_PASSWORD` in `.env` still works until one is
set in the UI. `--tunnel` refuses to start until a login exists.

Later starts ask nothing; `./claude-box --setup` asks for the folder again. Without a terminal (a script,
CI) it does not ask: a missing `.env` or projects folder is an error with a hint.

To call `claude-box` from anywhere, add it to PATH (`./claude-box --install` shows how).

## What's already set up inside

- **Claude authentication** — `CLAUDE_CODE_OAUTH_TOKEN` in `.env` (obtained via `claude setup-token`), or a GLM / Anthropic-compatible provider (see [Using GLM](#using-glm-zai-instead-of-anthropic)).
- **Settings** — the host's `settings.json` is copied (auto mode, theme, etc.).
- **superpowers plugin** — lives in `home/.claude/plugins/`, active right away.
- **MCP servers** — user-scope, seeded from `claude-defaults/mcp.json` into `~/.claude.json` at startup: `atlassian`, `github`, `sentry`, `context7`, `kubernetes`, `figma`, `playwright`, `grafana`. Remote ones (`atlassian`/`sentry`/`figma`) are authorized once via `/mcp`; `github` takes `GH_TOKEN`, `context7` takes `CONTEXT7_API_KEY`, `grafana` takes `GRAFANA_URL`+`GRAFANA_SERVICE_ACCOUNT_TOKEN` from `.env`.
- **git** — identity set in `home/.gitconfig`.
- **Completion signals** — when Claude finishes a response (or is waiting for input/permission), a bell rings and the tab title changes to `✅/❓/⏳ <session>`; from another tab you can see which Claude has become free. To disable — `CLAUDE_NOTIFY_DISABLE=1` in `.env` (hooks already seeded remain until you manually clear `home/.claude/settings.json`).
- **Web terminal (Console)** — the in-browser terminal is ttyd on `127.0.0.1:7682`, behind the same port and login as the rest of the UI; it opens a picker of tmux sessions (different tabs = different claude sessions, which survive closing the tab; a new one asks for its folder). Port / login / password — `WEB_TERMINAL_PORT` / `WEB_TERMINAL_USER` / `WEB_TERMINAL_PASSWORD` in `.env`. Several concurrent sessions share `~/.claude.json` (a shared `./home`); simultaneous active work in the same folder/session from different tabs is not recommended.
- **Several boxes on one machine** — each checkout is one box (its own `home/`, sessions and settings). Two of them can share a docker daemon (two users of one Mac, or two checkouts) only with their own names and ports, because the container uses the host network: set `CLAUDE_BOX_NAME` (container `<name>-web`, image `<name>`, compose project `<name>`), `WEB_TERMINAL_PORT`, `WEB_TLS_PORT` and `TTYD_PORT` in the second box's `.env`. The first run asks for them when another box is already there, and `claude-box` refuses to start or stop a same-named container that another checkout owns.
- **Web chat (HTML mode)** — the launcher shows a Claude Code-style sidebar of sessions grouped by folder. Each session opens as a native web chat by default: messages stream in over a WebSocket (`/chat/ws`), Markdown/code render as real HTML (select and copy normally), tool calls show as collapsible rows with their results and diffs, and permission requests / Claude's questions appear as buttons. Under the hood the sidecar drives Claude through the **Claude Agent SDK** (`scripts/web-chat.js`), on the same session files as the CLI. The **Chat / Console** switch in the top bar hands the same session over to the classic terminal (`claude --resume` in tmux, for slash commands and anything TUI-only) and back — one owner at a time, so switching to the console stops the chat process and switching back closes the console. New sessions start from a folder picker; the classic console menu is still one click away. Idle chat processes stop after `WEB_CHAT_IDLE_MINUTES` (default 60) and resume on the next message. Files can be attached with the paperclip, by pasting (e.g. a screenshot) or by dropping them on the chat (up to 20 files / 30 MB per message): they are saved under `~/.claude/web-uploads/` (override with `WEB_CHAT_UPLOADS`), images are also sent inline, and every file is listed by path so Claude can read it. Typing `/` in the composer lists the slash commands and skills of that folder with their descriptions and argument hints (↑/↓, Enter or Tab to pick); the list comes from Claude itself and is cached in `~/.claude/web-commands.json`. The **Tools:** button in the composer folds tool calls into one line per run (compact), shows them all, or hides them. Self-paced loops survive restarts: on startup the sidecar finds chat sessions whose last `ScheduleWakeup` was not a stop and re-sends its prompt when the wakeup is due (`WEB_RESUME_LOOPS=0` disables, `WEB_RESUME_LOOPS_MAX_HOURS` — default 12 — limits how old a loop may be).
- **Workspace — a file manager** — the Workspace page browses `/workspace`: click a folder to go in (breadcrumbs and the browser's Back button go up), click a file to open it in a tab (text, images, PDF; anything else downloads). **Start session** (on hover, or **Start session in this dir** for the open folder) starts Claude in that folder. Each folder row lists the sessions started in it (the newest three, then **+N**); click one to open it. The **Size** column shows folder sizes as well, counted with `du` in the background (each folder has a time limit, results are cached for a few minutes). **Clone from Git** lists the repos your GitHub account can reach (own, shared, your organizations'), searchable as you type; a pasted URL works too. Drop files — or whole folders — from your computer onto the list or onto a folder to upload them (no size limit by default, `WEB_UPLOAD_MAX_MB` sets one; existing names are asked about), or use **Upload**. Drag rows onto a folder or a breadcrumb to move them (⌥/Alt copies); select several with the checkboxes, ⌘/Ctrl-click or Shift-click, then Copy / Cut and **Paste here** in another folder, Rename, Download or Delete (⌫ with ⌘/Ctrl, or Delete). Delete moves things to `/workspace/.trash/<time>/`, so they can be restored. Dotfiles are listed too. Every path is confined to the workspace (no `..`, no symlinks out of it).
- **Tasks — one folder per task** — **New task** in the sidebar opens a picker: your Jira issues in work (from the Today panel, filtered as you type), **Search all of Jira** (a short read-only run through the Jira connector), **Create a Jira issue** with just a title (the task's session creates it first thing), or a plain task with no Jira. Tasks are listed as folders under `tasks/` in Workspace, each row with its title, key, branch and state. **New temp session** starts a throwaway chat in a fresh `/workspace/tmp/<date-time>/`. The task's repos are picked in the same dialog from your GitHub repos; each one is cloned once into `/workspace/repos/` (the base repos, never edited directly) and reused by later tasks; every task gets `/workspace/tasks/<KEY-title>/` with a `.task.json` (id, title, link, branch) and its own clone of each repo it needs, on a branch named after the task. Its Claude session runs in that folder; opening the task again opens the newest session there. Status dots show what is safe to clean up: uncommitted changes, commits not pushed, or nothing unsaved. **Archive** saves the branch into the base repo and removes the clones (the folder keeps `.task.json`, sessions stay), **Reopen** clones again and checks the branch out, **Forget** removes an archived task's folder. A link opens or creates a task from anywhere (a task tracker, a bookmarklet, Slack): `/?task=PROJ-123&title=…&url=…&repos=api,specs` — a Jira-style key becomes the id and branch prefix; any other id (e.g. `tracker:<id>`) works too. A link to a task that does not exist yet and has no `repos=` opens the prefilled **New task** form, so the repos are picked on the server itself. Plain clones rather than git worktrees, so a task folder works the same from the host, where `/workspace` has a different path.
- **Today panel (right)** — the ◧ button in the top bar opens a panel that gathers the day in one place. **Needs me** on top: 3–5 items where you have to act (a question in Slack, a review requested from you, your PR with failing CI or changes requested, a meeting about to start, a blocking Jira issue), plus live ones — sessions waiting for your answer and meetings starting within 15 minutes. Below, collapsible: **Calendar** (the rest of today), **GitHub** (review requests addressed to you, those that came through a team, and your open PRs with CI state, review decision and a dot for new activity; PRs checked by the PR reviewer show its status), **Jira** (your issues that are not done — a click opens or creates the task workspace), **Slack** (mentions, thread replies and DMs of the last 24 hours) and **Gmail** (unread mail from people, no notifications). Each block shows only when its source is connected (the MCP connector exists; GitHub: `gh` is logged in). **✕** on an item hides it until something about it changes — a draft PR comes back when it is ready for review or its CI / review state changes, a Jira issue when its status changes, a meeting when it moves; "N hidden · show" lists them to bring one back. Hidden items are kept on the server (`~/.claude/web-panel-hidden.json`), so every browser sees the same. GitHub comes straight from `gh` (refreshed every minute). Calendar, Jira, Slack and Gmail come through Claude's MCP connectors: a short **read-only** run on a cheap model (`WEB_PANEL_MODEL`, default `claude-haiku-5-5`; any MCP call that is not a read is refused) collects them and picks the "Needs me" items, on ↻ and on the interval picked at the bottom of the panel (5 min … 1 h, or only on ↻; `WEB_PANEL_MINUTES`, default 15, is the initial value) while the panel has been opened in the last two hours. A run takes about a minute and costs a few cents of usage. `WEB_PANEL=0` turns the agent part off. The snapshot is kept in `~/.claude/web-panel.json`.
- **Sessions started by an agent (`cb-session`)** — inside the box, `cb-session new --cwd DIR --prompt TEXT [--title T] [--mode auto] [--category NAME]` starts a chat session that works on its own and prints its token; `cb-session status TOKEN` reports its state (`running`, `requires_action`, `idle`, …), cost and last answer. They are ordinary chat sessions — listed in the sidebar (filed under `--category` if given), open and continue like any other. This is how one agent can hand work out to many sessions, e.g. a reviewer that starts one session per pull request. Backed by `POST /chat/api/new` and `GET /chat/api/status?token=` (same login as the UI).
- **Sessions survive a container restart** — the web container keeps the list of running sessions on disk (`home/.claude/web-live-sessions.json`, refreshed every 15s and on shutdown). On the next start every one of them is brought back automatically (`claude --resume` in its original folder, same tmux name), so the launcher shows them live again. The web service also has `restart: unless-stopped`, so it comes back by itself after a Docker/host restart. A session is remembered once Claude has fired its first hook in it (i.e. after the first prompt). Set `WEB_RESTORE_SESSIONS=0` in `.env` to turn this off.

## Tests

macOS and Linux are separate runs, and both must pass:

```bash
bash tests/run.sh               # every suite on this machine (macOS or Linux)
bash tests/run.sh --linux       # every suite on Linux, inside the claude-box image (run ./claude-box first)
```

The Linux run is where the web server really lives (tmux, `/proc`); the host run checks `./claude-box`
against the host's own tools (BSD userland on macOS). Suites that need a tool the host lacks (tmux) skip.
The suites on their own:

```bash
node --test tests/*.test.js     # web server modules: registry, search, preview, metrics, startup
bash tests/web-menu.test.sh     # console deep links / resume (needs tmux, jq)
bash tests/claude-box.test.sh   # host entry point: first-run setup, docker calls (docker is stubbed)
```

---

## Running on macOS

Works out of the box: `./claude-box` detects Docker Desktop and switches the network mode to
explicit port mapping (`WEB_BIND=ports`), so the UI opens at `https://localhost:8443` on the Mac.
No plugins needed. On Linux (and WSL2) nothing changes — the container keeps sharing the host
network directly.

Caveat of the mapped mode: the container cannot reach services bound to the Mac's `127.0.0.1`
(Tailscale socket, local databases). Address those via `host.docker.internal`, the LAN or the
tailnet IP. Force a mode explicitly with `WEB_BIND=ports` or `WEB_BIND=host` in `.env`
(host networking on macOS requires an engine with real host support, e.g. OrbStack).

---

## Using GLM (z.ai) instead of Anthropic

claude-box works with any Anthropic-compatible provider. To run on **GLM**, put this block in `.env`
— Claude Code picks it up in the web chat and in the console alike:

```env
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=<your z.ai key>
ANTHROPIC_DEFAULT_SONNET_MODEL=GLM-5.3-Flash
ANTHROPIC_DEFAULT_OPUS_MODEL=GLM-5.3-Flash
ANTHROPIC_DEFAULT_HAIKU_MODEL=GLM-5.3-Flash
```

`CLAUDE_CODE_OAUTH_TOKEN` must stay **empty** in this mode. Model names are whatever your z.ai plan
exposes (e.g. `GLM-5.3`, `GLM-5.3-Flash`). Restart with `./claude-box --restart`.
The same block can instead live in `home/.claude/settings.json` as `"env": { ... }` — the `.env`
variant is preferred, keeping secrets in one place.

---

## How to get a `GH_TOKEN` (for `gh` — creating PRs, etc.)

`gh` (GitHub CLI) requires a token to work. The simplest way is to set it via the
`GH_TOKEN` variable in `.env` (it's picked up automatically, so `gh auth login` isn't needed).
The easier way is **Connect GitHub** in the UI (first visit or Settings → GitHub): it runs `gh auth login --web`
for you, shows the code to enter at github.com/login/device, and fills in the commit name and email.

### Classic token

1. **GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)**
   → **Generate new token (classic)**.
   Direct creation link: <https://github.com/settings/tokens/new>
   (list of all tokens: <https://github.com/settings/tokens>).
2. **Note** — a name (e.g. `claude-box`), **Expiration** — the lifetime.
3. Check the scopes:
   - ✅ **`repo`** — the whole block (Full control of private repositories). This is enough: pushing branches + creating PRs.
   - Everything else (read:org, workflow, packages, admin, gist, user, delete_repo, etc.) is **not needed** — leave it unchecked.
4. **Generate token** → copy it (it starts with `ghp_…`).
5. If your organization has SSO enabled — click **Enable SSO / Authorize** next to the token.

### Set the token

Open `.env`, uncomment the line and paste the token:

```env
GH_TOKEN=ghp_xxx
```

Restart claude-box (`./claude-box --restart`) — and `gh` is ready:

```bash
# in the web terminal:
gh auth status     # should show "Logged in ... (GH_TOKEN)"
gh pr create ...
```

> Alternative without `GH_TOKEN`: run `gh auth login` once inside the container —
> the authorization is saved in `home/.config/gh` and survives restarts.

### Token security

- The token lives in `.env` (permissions `600`) — this file **must not be committed** or shown.
- Use minimal permissions and a shorter lifetime.
- If the token leaks — revoke it on the same GitHub page and generate a new one.

---

## Connecting to JIRA (Atlassian MCP)

Jira/Confluence connect via Atlassian's official remote MCP server.

Authorization — **once**:

1. Start claude-box (`./claude-box`) and open a session in the **Console** (the terminal).
2. In Claude type `/mcp` → choose **atlassian** → **Authenticate**.
3. Claude will show an OAuth link — open it in a browser, log in to Atlassian, grant access.
4. The authorization is saved in the passed-through `home/` (`~/.claude`) — no need to log in again on restarts.

**Check:** `/mcp` shows `atlassian — connected`; you can ask Claude to search/read/comment on Jira issues.
