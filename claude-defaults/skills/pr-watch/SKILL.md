---
name: pr-watch
description: Watch the pull requests of the repos cloned in the current folder and review other people's PRs automatically. Runs as a loop in its own claude-box session; for every new PR or new commits it starts a separate session that runs /pr-review in auto mode (project rules, real checks, code-review high, task fit, rollout needs, independent verification), posts the confirmed critical/high findings as a COMMENT review, and keeps a list of PRs ready to approve — approving only when the user says so. Use when the user asks to "watch PRs", "auto-review the team's PRs", "start the PR reviewer", or invokes /pr-watch. Commands while it runs: status, pause/resume, review <PR> now, approve <PR>, stop.
argument-hint: "[status | pause | resume | stop]"
---

# PR watch: an automatic reviewer for other people's PRs

You are the orchestrator. You do not review code yourself: you start one claude-box session per PR,
track it, publish its result through the helper, and tell the user what happened. Keep this session
light — never read diffs here. Work from the files, not from memory: your context gets compacted.

The watch folder is the current folder. The repos to watch are the GitHub clones directly inside it
(or `repos` in the config). Everything else lives in `.pr-watch/` there.

Helper: `node ~/.claude/skills/pr-watch/bin/pr-watch <command>` (below: `pr-watch`), always run from the
watch folder. `cb-session` (on PATH in claude-box) starts and polls sessions.

Arguments: `$ARGUMENTS` — empty or `start`: set up and loop; `status`; `pause`; `resume`; `stop`.

## Hard rules

- Publish only through `pr-watch post`. Never call `gh pr review`, `gh pr comment`, `gh api …/reviews`
  or anything else that writes to GitHub yourself.
- Approve only through `pr-watch approve`, and only right after the user asked for that PR in this
  conversation ("approve 2261", "апрувь api#2261"). Never on your own, never "all of them" without the
  user naming them or confirming the list you show.
- Never push, merge, close, label or request changes. Comments only (COMMENT reviews).
- Never review your own PRs (the helper skips them) and never start a second session for a running PR.
- Talk to the user in the language they write in; everything on GitHub is in English.
- No AI traces in anything posted. Follow the user's `~/.claude/CLAUDE.md` where stricter.

## Setup (first run)

1. `pr-watch init` — creates `.pr-watch/config.json` with defaults if missing, finds the repos and
   records every PR open right now as a **baseline**: those are not reviewed unless they get new
   commits, so starting the watch does not fire a review for every old PR. Show the user: the repos,
   the number of baseline PRs, the main settings (`max_parallel`, `max_per_day`, `only_requested`,
   `post_severities`, `post_comments`) and where to change them. If no repo is found, say how to add
   one (clone it into this folder, or list it in `repos`) and stop.
2. On the very first run (the config was just created), ask two things and write the answers into the
   config: whose PRs to watch (everyone, or a list of GitHub logins → `authors`; offer the most active
   authors of the last 30 days in these repos to pick from: `gh pr list -R <repo> --state all -L 100
   --json author --jq '.[].author.login' | sort | uniq -c | sort -rn`), and whether the user has other
   GitHub accounts whose PRs must be skipped (→ `skip_authors`; the signed-in `gh` user is always skipped).
3. Start the loop.

Config (`.pr-watch/config.json`, the user edits it; read it, never change it unless asked):
`repos` (empty = the clones in this folder), `exclude_repos`, `only_requested` (only PRs where a review
is requested from the user or their team), `authors` (empty = everyone; a list of GitHub logins for all
repos, or `{"owner/repo": [...], "*": [...]}` per repo), `skip_authors`, `skip_bots`, `skip_drafts`, `max_age_days`,
`max_parallel`, `max_per_day`, `level` (code-review effort, default high), `post_comments` (false =
review and report only), `post_severities` (default critical, high), `approve_body`, `interval_minutes`.

## One cycle

1. **Finished reviews.** For every PR in `.pr-watch/state.json` with `status: "running"`:
   `cb-session status <token>`.
   - `idle` / `stopped`: is `<work dir>/.review/result.json` there and valid (format below)?
     Yes → `pr-watch post <repo> <n>` → `pr-watch mark <repo> <n> '{"status":"done","verdict":…,"findings":[{"severity","file","line","title"}…]}'`.
     No → `pr-watch mark <repo> <n> '{"status":"error","error":"<the session's last answer, short>"}'`.
     If `post` says the PR moved past the reviewed commit → mark `outdated` (the next scan picks it up).
   - `requires_action` (waiting for a permission or a question) for more than 20 minutes: tell the user
     once, with the session title, so they can open it.
   - `running` for more than 90 minutes: tell the user once (`slow`). Do not kill it.
2. **New work.** `pr-watch scan` → `todo` (oldest first), `slots`. For each of the first `slots` items:
   - `pr-watch prepare <repo> <n>` → `{dir, sha}`;
   - `cb-session new --cwd <dir> --mode auto --category Reviews --title "Review <repo>#<n>" --prompt "<review prompt>"`;
   - `pr-watch mark <repo> <n> '{"status":"running","sha":"<sha>","token":"<token>","title":"…","author":"…","url":"…"}'`.
   Items with `wait` (parallel or daily limit) stay for later cycles. A failed command: mark that PR
   `error` with a short reason and go on.
3. **Report** in one short line, only when something changed:
   `api#2239 started · api#2232 done: 2 high posted · ready to approve: api#2261 · 2 running`.
   When a PR becomes ready to approve (nothing blocking at its current head), add one line with its
   link, title, CI state and any "needs a human" or rollout notes — the user decides.
4. **Wait**: ScheduleWakeup `interval_minutes` × 60 s (default 300) with the same `/pr-watch` prompt.
   With nothing running and nothing new for several cycles, stretch the wait up to 20 minutes.

## Review prompt (fill in; add the "Previous findings" part only for a re-review)

```
Review pull request #<n> of <owner/repo> (head <sha>) with the pr-review skill in --auto mode at level <level>.
The PR is already checked out in this folder. Do NOT post anything to GitHub, do NOT push, do NOT change the code.
Write the result to .review/result.json as the pr-review skill describes for --auto, then reply with a one-line summary.

Previous findings (a re-review after new commits): <JSON list>. For each, check whether it is fixed; keep
only those still present (same title) together with any new findings.
```

`.review/result.json` (written by `/pr-review --auto`):
`{"pr": n, "repo": "owner/repo", "sha": "<full head sha>", "verdict": "ok" | "changes" | "blocked",
"summary": "…", "findings": [{"severity": "critical|high|medium|low", "source": "code-review|rules|intent|checks|habits",
"file": "path", "line": 123, "title": "…", "body": "…"}], "needs_human": ["…"], "rollout": ["…"],
"hygiene": ["…"], "checks": {"typecheck": "…", "lint": "…", "tests": "…"}}`

## User commands (answer them first, then continue the loop)

- `status` → `pr-watch status` and `pr-watch ready`, as a short list with links and titles.
- `pause` → stop starting new reviews (finish the running ones); no ScheduleWakeup after they are
  collected until `resume`. `stop` → end the loop (ScheduleWakeup with stop).
- `review <PR> now` → prepare and start it even if it is baseline, stale, already reviewed or over the
  daily limit (still never the user's own PR).
- `skip <PR>` → `pr-watch mark <repo> <n> '{"status":"paused"}'`.
- "watch also @x" / "stop watching @x" / "watch everyone" → edit `authors` in the config (that is a
  change the user asked for), show the new list.
- `approve <PR>` → `pr-watch approve <repo> <n>`. If the PR got new commits since the review, the helper
  refuses: offer a re-review (or `--force` only if the user insists after hearing that). If the number
  is ambiguous across repos, ask which repo.
- "what did you find in <PR>" → read its `result.json` and explain (findings, needs a human, rollout).
