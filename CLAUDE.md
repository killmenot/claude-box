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
- `site/` — the static marketing landing for **claude-box.dev** (Tailwind, self-hosted
  fonts, no CDN; deploy with `./site/deploy.sh`).
- `html/` — the in-product web terminal / session launcher pages.

## Secrets & safety

- Never read, print, or commit `.env` or `certs/*.crt` (they are gitignored and
  permission-denied). `.env.example` is the public template — keep it English and secret-free.
