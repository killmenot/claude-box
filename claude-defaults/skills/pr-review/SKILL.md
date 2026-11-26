---
name: pr-review
description: Full pull request review. Collects every project rule (CLAUDE.md files, .claude/, AGENTS.md, contributing and lint conventions), checks PR hygiene, runs the project's real tests/lint/typecheck, runs code-review plus three agents (rules compliance; task intent and rollout needs; the team reviewers' recurring remarks), re-verifies every finding independently, skips what others already said, explains the result in the user's language and, only after an explicit "yes", publishes short review comments and approves. Use when the user asks to review a pull request ("review this PR", "check it before merge", "what should I comment", in any language) or invokes /pr-review.
argument-hint: "<PR url | PR number | branch> [--level high|xhigh|max] [--no-run] [--refresh-habits] [--auto]"
---

# PR review: rules + checks + code-review + intent/rollout + reviewer habits + verification

Goal: a short list of REAL problems in this PR, checked against the project's rules, the task it
implements and what the team's reviewers usually ask for; plus what the rollout needs. Explained to the
user in their language, and — only when the user says so — published as short English review comments.

Arguments: `$ARGUMENTS`
- target: PR URL, PR number (in the current repo) or branch. Empty → the current branch's PR or diff.
- `--level <lvl>`: code-review effort, default `high`. `xhigh`/`max` only when the user asked for it.
- `--no-run`: skip Step 2 (running tests/lint/typecheck).
- `--refresh-habits`: rebuild the reviewer-habits cache even if it is fresh.
- `--auto`: unattended run (started by `/pr-watch`): no questions, no Step 6; ends by writing
  `.review/result.json` — see "Auto mode" at the end.

Hard rules for the whole flow:
- Talk to the user in the language they write in. What goes to GitHub is in English, unless the
  project rules or the PR discussion use another language.
- Read-only on GitHub/Jira/Slack until the user explicitly approves publishing: no comments, reviews,
  approvals, pushes, label or status changes. Never merge. Never send Slack messages.
- Every PR or issue key you mention to the user is a clickable link with its title in parentheses.
- Follow the user's own `~/.claude/CLAUDE.md` where it is stricter than this file.
- Nothing that leaves the machine mentions Claude, AI or a tool that wrote it.

## Step 0 — Context and the PR itself

1. Resolve the target: repo (`owner/name`), PR number, title, author, base and head branches, head SHA,
   description, draft state, linked issue keys (Jira, Linear, GitHub issues; from the title, branch name, description). Use
   `gh pr view <n> --repo <o/r> --json number,title,author,baseRefName,headRefName,headRefOid,body,isDraft,mergeable,mergeStateStatus,commits,reviewDecision,url`.
2. Make sure the code is local at the PR head: if the current folder is a clone of that repo, fetch and use
   `git worktree add` for the PR head; otherwise clone into a temp dir. Never switch branches in a folder
   that has uncommitted work.
3. Get the diff (`gh pr diff <n>` or `git diff <base>...<head>`) and the list of changed files.
4. Read the existing review threads and comments (`gh api repos/<o>/<r>/pulls/<n>/comments`,
   `gh pr view <n> --comments`): who already said what, which threads are resolved. You will not repeat them.

## Step 1 — Collect ALL project rules (mandatory, do not skip)

Find and read every rule source that applies to the changed files. Read them at the PR **base** (the rules
the change must follow) and note any rule files the PR itself changes.

Look for, from the repo root down to the directory of every changed file:
- `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/rules/**`, `.claude/skills/**` that
  describe conventions, `.claude/settings.json` hooks that enforce checks;
- `AGENTS.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules/**`, `.github/copilot-instructions.md`,
  `.windsurfrules`;
- `CONTRIBUTING.md`, `docs/**` conventions (architecture, coding style, API guidelines, migrations,
  ADRs), `README` sections titled conventions/guidelines/rules;
- PR templates (`.github/pull_request_template.md`) and their checklists;
- enforced tooling: lint/format configs (`.eslintrc*`, `eslint.config.*`, `.prettierrc*`, `tsconfig*.json`
  strictness, `.editorconfig`, `golangci*`, `ruff`/`pyproject` sections), `commitlint`, `husky`/pre-push
  hooks, CI workflows (`.github/workflows/**`) — what they run tells you what must pass (Step 2 uses it).

Start from: `git ls-files | grep -iE '(^|/)(CLAUDE(\.local)?\.md|AGENTS\.md|GEMINI\.md|CONTRIBUTING\.md|\.cursorrules|copilot-instructions\.md|pull_request_template\.md)$|^\.claude/|^\.cursor/rules/|^docs/|^\.husky/|^\.github/workflows/'`.
Also read the user's global `~/.claude/CLAUDE.md` for the output rules.

Turn them into a numbered **rules list**: each rule in one line, with its source `file:line`. Keep only
rules that can be checked against code (skip pure workflow advice for agents). If there are no rule files,
say so in the report and continue.

## Step 1b — PR hygiene (no agent, a few gh/git calls)

From the Step 0 JSON and `git log <base>..<head>`:
- AI traces: any `Co-Authored-By:` naming Claude/Anthropic/an AI, `Claude-Session:`, "Generated with",
  "🤖" or a claude.ai link in commit messages, PR title, PR body or the PR's own comments.
- History: fixup/wip/"tmp" commits, merge commits from the base inside the branch, commits unrelated to
  the PR's topic.
- Up to date: `mergeStateStatus` (BEHIND / DIRTY = conflicts / BLOCKED), how many commits the head is
  behind the base (`gh api repos/<o>/<r>/compare/<base>...<head> --jq .behind_by`).
- Draft: still draft although it is presented as ready (or ready while the description says WIP).
- Title: has the issue key if the team uses them (e.g. `ABC-1234`) and follows the repo's title convention from the
  rules / recent merged PRs (`gh pr list --state merged -L 20 --json title`).
- Description: filled in, matches the PR template checklist if one exists.

Each problem is one line for the report's "PR hygiene" block; they are not sent to verifiers.

## Step 2 — Run the real checks (no agent; skip with --no-run)

Find what the project itself runs — pre-push/pre-commit hooks (`.husky/`, `lefthook.yml`,
`.pre-commit-config.yaml`), CI workflows, `package.json` / `Makefile` / `justfile` scripts — and run the
same kind of checks, scoped to the change where the tool allows it:
- typecheck (e.g. `tsc --noEmit -p <project>`, `go vet`), lint for the changed files, unit tests for the
  changed files and their nearest spec/test files (e.g. `jest --findRelatedTests <files>`,
  `nx affected -t test,lint`, `go test ./<pkgs>/...`, `pytest <paths>`).
- Install dependencies only with the lockfile (`npm ci`, `pnpm i --frozen-lockfile`, …). No commands that
  need prod/dev credentials, write to real databases or call external services; if a suite needs
  docker/services that are not up, run what you can and say what was skipped.
- Time-box each command (~10 min); if the machine runs out of memory, run the suites one by one.

For every failure: run the same command at the **base** commit. Fails on base too → pre-existing (report
it, but it is not this PR's fault). Fails only on head → a candidate finding for Step 4 with the command
and the failing test/lint message (a failing test in the changed area is at least high).

## Step 3 — Candidate findings (four passes, in parallel)

Send all four in ONE message (A is a Skill call, B–D are Agents with `subagent_type: "general-purpose"`).
Every agent prompt includes: repo path, base/head SHAs, PR title/body, the changed files list, and "Read-only:
do not edit files, post, push or change anything in GitHub/Jira/Slack."

A. **code-review**: `skill: "code-review"`, `args: "<level> <target>"`. No `--fix`, `--comment`,
   `--max-findings`.

B. **Rules compliance** — give it the full rules list from Step 1:
   > For every rule, check the diff (and only the diff and the code it touches) for violations.
   > A violation needs a concrete `file:line` in the changed code and a quote of the rule with its source.
   > Ignore rules the diff cannot break. Return: file, line, rule (+ source), what violates it, one-line
   > fix. Empty list if nothing is broken — do not invent violations.

C. **Intent and rollout** — give it the issue keys and where the task was discussed if known:
   > 1. Task fit. Read the linked issue(s) (description, acceptance criteria, comments) through the connected
   >    tracker (Jira/Linear MCP, `gh issue view`) and the PR body; if a chat connector (e.g. Slack) is
   >    available, search it for the key / PR number for the discussion that defined the task. Compare with the
   >    diff: requirements not implemented, behaviour that contradicts the task, scope creep (changes the
   >    task did not ask for), a PR description that does not match the code. Cite the task text.
   > 2. API contract. Changed request/response shapes, DTO fields (nullable/optional, renamed, removed),
   >    status codes, defaults, pagination, error formats; is Swagger/OpenAPI and docs updated to match;
   >    can existing clients break.
   > 3. Rollout needs. New or renamed env vars and feature flags (and their defaults), config/secrets,
   >    DB migrations (reversible? locking on big tables?), backfills or one-off SQL, queue/consumer
   >    changes, cron jobs, dependencies on other services' releases, whether a PR in the deployment
   >    config repo (Helm / k8s specs / Terraform — find it from the rules, the README or recent PRs
   >    that mention this service) is needed or already exists (`gh search prs`), and the
   >    order of releases.
   > Return two lists: findings (file:line or "task", claim, evidence, one-line fix) and rollout_needs
   > (item, why, where — env/k8s PR/migration/backfill/order). Do not invent requirements the task
   > does not state; if no issue is linked, say so and only check the PR body.

D. **Reviewer habits** — cached per repo:
   - Cache file: `~/.claude/review-habits/<owner>-<repo>.md`. If it exists, is younger than 14 days and no
     `--refresh-habits`, pass its content to the agent and skip the collection part.
   - Otherwise the agent builds it first:
   > Collect review comments from the last ~90 days in <owner/repo>: merged and closed PRs
   > (`gh pr list --state all --search "updated:>=<date>" -L 200 --json number,author`), then
   > `gh api repos/<o>/<r>/pulls/<n>/comments` and `.../reviews` for each. Take the 3–5 most active human
   > reviewers (excluding bots, the PR author and the user running the review). For each, group their comments into recurring
   > themes that appear at least 3 times (e.g. pagination, nullable DTO fields, JSDoc, naming, logging,
   > tests, error handling, migrations), each with 1–2 short quoted examples and PR links. Write it as
   > markdown to `~/.claude/review-habits/<owner>-<repo>.md` (create the folder) with the date on top.
   - Then, with the habits:
   > Check this PR's diff against each recurring theme. Report only concrete places where the reviewer
   > would very likely leave the same remark: file, line, reviewer, theme, the past example it matches,
   > one-line fix. Do not report themes the diff does not touch.

Merge A–D and the Step 2 failures into one numbered candidate list (file, line, claim, scenario / rule /
task text / reviewer theme, source: `code-review` | `rules` | `intent` | `habits` | `checks`). Keep C's
rollout_needs aside for the report — they are not findings. Drop candidates an existing review comment
already raised (note "already raised by @who"). If nothing is left, go to the report.

## Step 4 — Independent verification

Spawn verifier agents (`subagent_type: "general-purpose"`) in ONE message: one per candidate up to 12,
otherwise 2–4 per agent grouped by file. Each prompt holds the repo path, base/head, and the candidate as
stated (not your opinion) with its evidence (rule text, task text, failing command, past reviewer
example). Instruct:

> You are an adversarial verifier. Read-only: do not edit, post or push.
> Try to REFUTE the claim. Read the code at the cited place, its callers/callees, the diff, types,
> config, tests. Check whether the scenario really happens with realistic inputs, whether something
> already prevents it, and whether this PR introduces it or makes it reachable (otherwise pre_existing).
> Rule violation: does the rule really apply to this file and case, is it really broken?
> Task mismatch: does the task really require it, or is it handled elsewhere / out of scope?
> Reviewer habit: is the remark really applicable here, not already satisfied?
> Failing check: reproduce it; is it caused by this diff?
> If cheap and safe, confirm with a quick test or script (no network side effects, no DB writes).
> Return per candidate: verdict CONFIRMED | REFUTED | UNCERTAIN; evidence (file:line + 1–3 sentences);
> severity critical | high | medium | low; pre_existing true/false; fix (one line).

Severity rubric (give verbatim):
- critical — data loss/corruption, wrong money/amounts/balances, security hole (auth bypass, secret leak,
  injection), crash or outage on a main path, irreversible on-chain/financial action.
- high — wrong results for a realistic class of inputs, broken API contract for existing clients,
  unhandled error on a common path, race/concurrency bug, failing migration, a failing test or typecheck
  caused by the PR, a requirement of the task not implemented.
- medium — bug on a plausible edge case, missing validation that can surface to users, notable
  performance regression, a clear violation of an explicit project rule, outdated Swagger/docs for a
  changed contract.
- low — style, naming, refactoring, theoretical edge case, nits, missing tests without a concrete bug.

Keep: CONFIRMED, severity critical/high/medium, and not pre_existing (or made reachable/worse by the
diff). Exception: CONFIRMED `habits` findings are kept even when low — they go to a separate block,
because the reviewer will ask anyway. UNCERTAIN with claimed critical/high: check it yourself; keep only
if you confirm, else list under "needs a human look". Merge duplicates.

## Step 5 — Report to the user (in their language)

Template (headings in English here; write them in the user's language):

```
## Review [#<n>](<pr url>) (<title>) — <✅ ready to merge | ⚠️ merge after fixes | ⛔ do not merge>
Issue: [KEY](<issue url>) (<title>) | Rules: <N rules from: CLAUDE.md, AGENTS.md, ...>

### Checks
typecheck ✅ | lint ⚠️ 2 | tests ❌ 1 (<command>) — <fails on base too / only in this PR> | skipped: <what and why>

### PR hygiene            ← problems only, one line each
- 12 commits behind develop; AI co-author trailer in 2 commits; no issue key in the title

### Must fix (N)
1. [HIGH] path/file.ts:123 — <what is wrong>  (source: code-review | rule | issue | checks)
   Scenario / rule / issue text: <...>
   Fix: <suggestion>

### Reviewers will likely ask (K)   ← only if any
- @reviewer: path:line — <theme>, as in [#1234](<url>) (<title>)

### Needed for the rollout          ← only if any
- env/flag: ... | deployment config PR: exists [#...](...) (...) / needed | migration/backfill: ... | order: ...

### Needs a human look (M)          ← only if any
### Already raised by others (L)     ← only if any: who and what
### Filtered out
X candidates: Y refuted, Z low, W pre-existing.

### Proposed comments
1. path:line — "<short English comment, 1–2 sentences, no bold, no preamble>"
...
Review event: COMMENT | REQUEST_CHANGES | APPROVE (proposal)
```

Verdict: any critical or a PR-caused failing check → ⛔; any high/medium, merge conflicts or AI traces in
commits → ⚠️; nothing kept → ✅. Then stop and wait.

## Step 6 — Publish only on an explicit command

Only after the user says which items to publish ("publish 1 and 2", "approve", "comment and approve"):
- Publish exactly the chosen items, in the user's edited wording if they gave one, as one GitHub review
  with inline comments (`gh api repos/<o>/<r>/pulls/<n>/reviews` with `commit_id` = head SHA, `event`
  COMMENT / REQUEST_CHANGES / APPROVE as the user said). Approve only if the user said so.
- Comments: English, 1–2 sentences each, concrete, no bold, no "Great PR!" padding, no mention of tools.
- Afterwards give the link to the review and a one-line summary.

If the user asks to fix instead (their own PR): apply only the chosen items (hygiene too: reword commits,
rebase, update the title/description), run the Step 2 checks again, report honestly, and do not push until
they say so. Commits: no AI trailers. Never mention `--no-verify` anywhere.

## Auto mode (`--auto`)

Nobody is watching this session; an orchestrator (`/pr-watch`) reads the result file and publishes.
- The PR is already checked out in the current folder; review it there (no extra worktree or clone).
- Never ask questions and never wait: decide with the rules above; what you cannot decide goes into
  `needs_human`. Never post, push, approve or change code — Step 6 does not run.
- Run all steps 0–4 as usual (Step 2 too, unless `--no-run`). Time-box the whole review to ~60 minutes;
  if something does not finish, say so in `summary` and `needs_human` rather than stopping.
- A re-review gets "Previous findings" in the prompt: keep each one that is still present (same title),
  drop the fixed ones, add new ones.

Write `.review/result.json` (create `.review/`), English text, valid JSON:

```
{"pr": <n>, "repo": "<owner/repo>", "sha": "<full head sha you reviewed>",
 "verdict": "ok" | "changes" | "blocked",
 "summary": "<one or two sentences>",
 "findings": [{"severity": "critical|high|medium|low", "source": "code-review|rules|intent|checks|habits",
               "file": "path/from/repo/root", "line": <line in the new version of the file, or null>,
               "title": "<one line>",
               "body": "<what is wrong, a concrete scenario or the rule/issue text, how to fix — 1–4 sentences, markdown>"}],
 "needs_human": ["<one line each>"],
 "rollout": ["<env var / flag / migration / deployment config PR / release order, one line each>"],
 "hygiene": ["<one line each>"],
 "checks": {"typecheck": "pass|fail|skipped: …", "lint": "…", "tests": "…"}}
```

Only kept (verified) findings go into `findings`; `habits` ones keep their own severity and are never
published automatically. `verdict`: "blocked" for any critical or a failing check caused by the PR,
"changes" for any high/medium, else "ok". The `body` is what reviewers will read on GitHub: concrete,
polite, no bold headings, no mention of tools or AI. Then reply with a one-line summary.
