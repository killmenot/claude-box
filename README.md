<p align="center">
  <img src="site/brand-mark.svg" alt="claude-box" width="84" height="84">
</p>

# claude-box

Isolated execution of **Claude Code** in Docker: access to a single folder only (`/workspace`),
Claude traffic via a foreign TLS proxy, with state and plugins preserved between runs.

> **Windows?** The project targets a Linux host. Installation and running under Windows (WSL2 + Docker
> Desktop, the `claude-box.bat` launcher, an icon) are covered in [INSTALL.md](INSTALL.md).

## Running

```bash
./claude-box            # build (cached) and start the web UI, print its address
./claude-box --tunnel   # + publish it on a public https URL (cloudflared without a token / ngrok)
./claude-box --no-proxy # run without the proxy from .env (the host's direct egress)
./claude-box --status   # is it running, where, which console sessions
./claude-box --stop     # stop it (running sessions come back on the next start)
./claude-box --setup    # re-run the first-run setup
./claude-box --install  # print how to add claude-box to PATH (changes nothing)
```

claude-box is a web UI: open the printed address (`http://localhost:7681`, or `https://localhost:8443`
for clipboard and notifications) and work with Claude in the browser — as a chat or in a real terminal.
The old `--web` / `--build` flags are still accepted and do the same as a plain `./claude-box`.

**First start.** `claude-box` sets itself up in the terminal:

1. creates `.env` from `.env.example` if there is none (tokens, proxy and the rest live there);
2. asks for the **workspace folder** — the host folder with your projects, mounted as `/workspace`
   (default `~/workspace`, created if missing) and saves it as `PROJECT_DIR`;
3. asks for the **web login and password** (`WEB_TERMINAL_USER`, default `claude`, and
   `WEB_TERMINAL_PASSWORD`; Enter generates a password and shows it once). The browser asks for them
   before showing the UI; they are also what `--tunnel` requires.

Later starts ask nothing; `./claude-box --setup` asks again. Without a terminal (a script, CI) it does
not ask: a missing `.env` or workspace is an error with a hint.

To call `claude-box` from anywhere, add it to PATH (`./claude-box --install` shows how).

> If the build fails with `x509: certificate signed by unknown authority`, that's about the proxy
> certificate on the host Docker daemon; for how to fix it on Linux/macOS/Windows see
> [“Build fails: x509…”](INSTALL.md#build-fails-x509-certificate-signed-by-unknown-authority) in INSTALL.md.

## What's already set up inside

- **Claude authentication** — `CLAUDE_CODE_OAUTH_TOKEN` in `.env` (obtained via `claude setup-token`).
- **Proxy** — Claude→Anthropic traffic goes through a foreign TLS proxy (`HTTPS_PROXY`); internal traffic (Tailscale/DB) goes directly (`NO_PROXY`).
- **Settings** — the host's `settings.json` is copied (auto mode, theme, etc.).
- **superpowers plugin** — lives in `home/.claude/plugins/`, active right away.
- **MCP servers** — user-scope, seeded from `claude-defaults/mcp.json` into `~/.claude.json` at startup: `atlassian`, `github`, `sentry`, `context7`, `kubernetes`, `figma`, `playwright`, `grafana`. Remote ones (`atlassian`/`sentry`/`figma`) are authorized once via `/mcp`; `github` takes `GH_TOKEN`, `context7` takes `CONTEXT7_API_KEY`, `grafana` takes `GRAFANA_URL`+`GRAFANA_SERVICE_ACCOUNT_TOKEN` from `.env`.
- **git** — identity set in `home/.gitconfig`.
- **Completion signals** — when Claude finishes a response (or is waiting for input/permission), a bell rings and the tab title changes to `✅/❓/⏳ <session>`; from another tab you can see which Claude has become free. To disable — `CLAUDE_NOTIFY_DISABLE=1` in `.env` (hooks already seeded remain until you manually clear `home/.claude/settings.json`).
- **Web terminal (Console)** — the in-browser terminal is ttyd on `127.0.0.1:7682`, behind the same port and login as the rest of the UI; it opens a picker of tmux sessions (different tabs = different claude sessions, which survive closing the tab; a new one asks for its folder). Port / login / password — `WEB_TERMINAL_PORT` / `WEB_TERMINAL_USER` / `WEB_TERMINAL_PASSWORD` in `.env`. Several concurrent sessions share `~/.claude.json` (a shared `./home`); simultaneous active work in the same folder/session from different tabs is not recommended.
- **Web chat (HTML mode)** — the launcher shows a Claude Code-style sidebar of sessions grouped by folder. Each session opens as a native web chat by default: messages stream in over a WebSocket (`/chat/ws`), Markdown/code render as real HTML (select and copy normally), tool calls show as collapsible rows with their results and diffs, and permission requests / Claude's questions appear as buttons. Under the hood the sidecar drives Claude through the **Claude Agent SDK** (`scripts/web-chat.js`), on the same session files as the CLI. The **Chat / Console** switch in the top bar hands the same session over to the classic terminal (`claude --resume` in tmux, for slash commands and anything TUI-only) and back — one owner at a time, so switching to the console stops the chat process and switching back closes the console. New sessions start from a folder picker; the classic console menu is still one click away. Idle chat processes stop after `WEB_CHAT_IDLE_MINUTES` (default 60) and resume on the next message. Files can be attached with the paperclip, by pasting (e.g. a screenshot) or by dropping them on the chat (up to 20 files / 30 MB per message): they are saved under `~/.claude/web-uploads/` (override with `WEB_CHAT_UPLOADS`), images are also sent inline, and every file is listed by path so Claude can read it. Typing `/` in the composer lists the slash commands and skills of that folder with their descriptions and argument hints (↑/↓, Enter or Tab to pick); the list comes from Claude itself and is cached in `~/.claude/web-commands.json`. The **Tools:** button in the composer folds tool calls into one line per run (compact), shows them all, or hides them. Self-paced loops survive restarts: on startup the sidecar finds chat sessions whose last `ScheduleWakeup` was not a stop and re-sends its prompt when the wakeup is due (`WEB_RESUME_LOOPS=0` disables, `WEB_RESUME_LOOPS_MAX_HOURS` — default 12 — limits how old a loop may be).
- **Workspace — a file manager** — the Workspace page browses `/workspace`: click a folder to go in (breadcrumbs and the browser's Back button go up), click a file to open it in a tab (text, images, PDF; anything else downloads). **Start session** (on hover, or **Start session here** for the open folder) starts Claude in that folder, **Terminal** opens bash there. Drop files — or whole folders — from your computer onto the list or onto a folder to upload them (no size limit by default, `WEB_UPLOAD_MAX_MB` sets one; existing names are asked about), or use **Upload**. Drag rows onto a folder or a breadcrumb to move them (⌥/Alt copies); select several with the checkboxes, ⌘/Ctrl-click or Shift-click, then Copy / Cut and **Paste here** in another folder, Rename, Download or Delete (⌫ with ⌘/Ctrl, or Delete). Delete moves things to `/workspace/.trash/<time>/`, so they can be restored. **hidden** shows dotfiles. Every path is confined to the workspace (no `..`, no symlinks out of it).
- **Tasks — one folder per task** — the Workspace page has a **Tasks** section. Base repos live in `/workspace/repos/` (add them under **Repos**: clone a URL, or copy an existing workspace folder locally); every task gets `/workspace/tasks/<KEY-title>/` with a `.task.json` (id, title, link, branch) and its own clone of each repo it needs, on a branch named after the task. Its Claude session runs in that folder; opening the task again opens the newest session there. Status dots show what is safe to clean up: uncommitted changes, commits not pushed, or nothing unsaved. **Archive** saves the branch into the base repo and removes the clones (the folder keeps `.task.json`, sessions stay), **Reopen** clones again and checks the branch out, **Forget** removes an archived task's folder. A link opens or creates a task from anywhere (DataBox, a bookmarklet, Slack): `/?task=LAM-5161&title=…&url=…&repos=api,specs` — a Jira-style key becomes the id and branch prefix; any other id (e.g. `databox:<id>`) works too. A link to a task that does not exist yet and has no `repos=` opens the prefilled **New task** form, so the repos are picked on the server itself. Plain clones rather than git worktrees, so a task folder works the same from the host, where `/workspace` has a different path.
- **Today panel (right)** — the ◧ button in the top bar opens a panel that gathers the day in one place. **Needs me** on top: 3–5 items where you have to act (a question in Slack, a review requested from you, your PR with failing CI or changes requested, a meeting about to start, a blocking Jira issue), plus live ones — sessions waiting for your answer and meetings starting within 15 minutes. Below, collapsible: **Calendar** (the rest of today), **GitHub** (review requests addressed to you, those that came through a team, and your open PRs with CI state, review decision and a dot for new activity; PRs checked by the PR reviewer show its status), **Jira** (your issues that are not done — a click opens or creates the task workspace) and **Slack** (mentions, thread replies and DMs of the last 24 hours). GitHub comes straight from `gh` (refreshed every minute). Calendar, Jira and Slack come through Claude's MCP connectors: a short **read-only** run on a cheap model (`WEB_PANEL_MODEL`, default `claude-haiku-5-5`; any MCP call that is not a read is refused) collects them and picks the "Needs me" items, every `WEB_PANEL_MINUTES` (default 15) while the panel has been opened in the last two hours, and on ↻. A run takes about a minute and costs a few cents of usage. `WEB_PANEL=0` turns the agent part off. The snapshot is kept in `~/.claude/web-panel.json`.
- **Sessions started by an agent (`cb-session`)** — inside the box, `cb-session new --cwd DIR --prompt TEXT [--title T] [--mode auto] [--category NAME]` starts a chat session that works on its own and prints its token; `cb-session status TOKEN` reports its state (`running`, `requires_action`, `idle`, …), cost and last answer. They are ordinary chat sessions — listed in the sidebar (filed under `--category` if given), open and continue like any other. This is how one agent can hand work out to many sessions, e.g. a reviewer that starts one session per pull request. Backed by `POST /chat/api/new` and `GET /chat/api/status?token=` (same login as the UI).
- **Sessions survive a container restart** — the web container keeps the list of running sessions on disk (`home/.claude/web-live-sessions.json`, refreshed every 15s and on shutdown). On the next start every one of them is brought back automatically (`claude --resume` in its original folder, same tmux name), so the launcher shows them live again. The web service also has `restart: unless-stopped`, so it comes back by itself after a Docker/host restart. A session is remembered once Claude has fired its first hook in it (i.e. after the first prompt). Set `WEB_RESTORE_SESSIONS=0` in `.env` to turn this off.
- **Public access from your phone** — `claude-box --tunnel` brings up the web UI and publishes it externally (the tunnel runs inside the container), printing a public `https://` address — connect from your mobile anywhere. The backend is chosen automatically: by default **cloudflared** (TryCloudflare — **no token and no account**, a random `*.trycloudflare.com`); if `NGROK_AUTHTOKEN` is set in `.env`, it goes through **ngrok** (optional `NGROK_DOMAIN` for a permanent address). In any case **`WEB_TERMINAL_PASSWORD` is mandatory** — without it the tunnel won't come up (the web terminal stays local); a public shell without a password is not allowed. The tunnel points at the sidecar's http port (`WEB_TERMINAL_PORT`), but the public URL is still `https` (TLS is terminated by the tunnel provider) — so notifications and clipboard work in the phone's browser. It's torn down together with `--stop`.

## Tests

```bash
node --test tests/*.test.js     # web server modules: registry, search, preview, metrics, startup
bash tests/web-menu.test.sh     # console deep links / resume (needs tmux, jq)
bash tests/claude-box.test.sh   # host entry point: first-run setup, docker calls (docker is stubbed)
```

---

## How to get a `GH_TOKEN` (for `gh` — creating PRs, etc.)

`gh` (GitHub CLI) requires a token to work. The simplest way is to set it via the
`GH_TOKEN` variable in `.env` (it's picked up automatically, so `gh auth login` isn't needed).

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

Restart claude-box (`./claude-box --stop && ./claude-box`) — and `gh` is ready:

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

---

Build failing with `x509: certificate signed by unknown authority`? That's about the host
Docker daemon trusting the proxy certificate — the analysis and fixes (Linux/macOS/Windows) are in
[INSTALL.md → “Build fails: x509…”](INSTALL.md#build-fails-x509-certificate-signed-by-unknown-authority).
