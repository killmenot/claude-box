---
name: pr-feedback
description: Work through the feedback on your own pull request. Collects unresolved review threads, review summaries, bot comments and failing CI checks, verifies each remark against the code, proposes per item fix / reply / decline with a short reply draft, and after the user's go-ahead fixes, runs the project's checks, re-reviews its own fixes, and — only on command — pushes, replies in each thread and re-requests review. With --ready it also gets the PR ready to merge (rebase, clean history, description, draft off). Use when the user says "reviewers left comments", "what should I fix in my PR", "address the review", "get it ready to merge", in any language, or invokes /pr-feedback.
argument-hint: "<PR url | number> [--ready] [--no-review] [--no-run]"
---

# PR feedback: triage the review, fix, verify, reply on command

Goal: every open remark on the user's PR is either fixed, answered or consciously declined — with
the reasons checked against the code, the project's checks green, and nothing published or pushed
without the user's say-so.

Arguments: `$ARGUMENTS`
- target: PR URL or number. Empty → the PR of the current branch.
- `--ready`: also prepare the PR for merge (Step 7).
- `--no-review`: skip the self-review of the fixes (Step 5).
- `--no-run`: skip running tests/lint/typecheck.

Hard rules:
- Talk to the user in the language they write in. Replies on GitHub are in English unless the project
  rules or the PR discussion use another language.
- Nothing leaves the machine before an explicit command: no push, no replies, no resolving threads, no
  review requests, no title/description/draft changes. Never merge.
- Never bypass hooks on your own. If a hook fails, report it. If the user explicitly chooses to bypass,
  do not mention that anywhere public (commit messages, PR text, replies).
- No AI traces in commits, PR text or replies (no co-author trailers, no "generated with", no tool names).
- Every PR or issue key you mention to the user is a clickable link with its title in parentheses.
- Follow the user's own `~/.claude/CLAUDE.md` where it is stricter than this file.

## Step 0 — The PR and the working copy

1. `gh pr view <n> --repo <o/r> --json number,title,url,author,baseRefName,headRefName,headRefOid,isDraft,mergeable,mergeStateStatus,reviewDecision,body`.
   If the author is not the current `gh` user, say this skill is for one's own PR (use `/pr-review` for
   someone else's) and stop unless the user insists.
2. Work in a local checkout of the PR's head branch. If the current folder has that branch, make sure it
   is clean and matches the remote head (`git fetch`, compare SHAs); local commits not on the remote are
   kept and shown to the user. If the folder has uncommitted work on another branch, use
   `git worktree add` instead of switching.
3. Read the project rules the same way `/pr-review` does (CLAUDE.md files, `.claude/`, AGENTS.md,
   CONTRIBUTING, lint/CI config, pre-push hooks): fixes must follow them, and the checks in Step 4 come
   from them.

## Step 1 — Collect all open feedback

- Review threads with their state (GraphQL; paginate if needed):
  `gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:50){nodes{databaseId author{login} body createdAt url}}}}}}}' -F o=<o> -F r=<r> -F n=<n>`
- Review summaries (`gh api repos/<o>/<r>/pulls/<n>/reviews`): bodies of CHANGES_REQUESTED / COMMENTED
  reviews often hold remarks that are not on a line.
- PR conversation comments (`gh pr view <n> --comments`), including bots (linters, coverage, security
  scanners, deploy previews).
- CI: `gh pr checks <n>`; for each failing check, the failing step's log
  (`gh run view <run> --log-failed`, trimmed to the error).

Keep an item when it still needs something: unresolved threads where the last word is not the user's,
review-body remarks not answered yet, failing checks, actionable bot findings. Skip resolved threads,
threads where the user replied last (unless the reviewer came back), praise and acknowledgements.
Mark outdated threads (the code moved), but still check whether the remark applies to the new code.

## Step 2 — Triage every item

For each item decide, by reading the actual code at the head (and the reviewer's suggestion, if any):
- **fix** — the remark is right and in scope;
- **reply** — a question, or the code is already right: answer with the reason (cite code/issue);
- **decline** — wrong, out of scope or against the project rules/issue: a polite reason, and offer a
  follow-up issue when it is a fair idea for later;
- **done** — already fixed by a later commit: reply with the commit link;
- **ask** — needs the user's decision (product behaviour, API contract, scope).

For non-trivial claims (a reported bug, a performance or security concern, "this breaks X"), verify in
parallel with agents (`subagent_type: "general-purpose"`, ONE message, read-only, 1–4 items each): give
them the repo path, the head SHA, the remark verbatim and the code location, and ask them to confirm or
refute it with file:line evidence. Trivial items (naming, typos, JSDoc, nits) need no agent.

Group remarks that share a root cause; one fix may close several threads. For failing CI, find the
cause: caused by this PR → fix; flaky or failing on the base too → say so (re-run on command).

## Step 3 — Show the plan and wait

In the user's language:

```
## Feedback on [#<n>](<url>) (<title>) — <N items: F fix, R reply, D decline, A ask>

1. [fix] @reviewer path:line — <remark in short> → <what I will change>
   Reply: "<short English reply, 1–2 sentences>"
2. [reply] @reviewer — <question> → "<answer>"
3. [decline] @reviewer path:line — <remark> → why not: <reason> → "<reply>"
4. [ask] @reviewer — <remark> → needs your decision: <options>
CI: <check> ❌ — <cause> → <fix | flaky, re-run | fails on base too>
```

Replies: concrete, no bold, no "Great catch!" padding, no promises the code does not keep.
Then stop. The user answers like "do all", "fix 1 and 3, answer 2 like this", "skip 4".

## Step 4 — Apply the fixes

- Change only what the approved items need. Follow the project rules and the surrounding code style.
- Commits: follow the repo's convention (look at `git log` of the base: message style, issue key prefix,
  one commit per remark vs one "address review" commit). No AI trailers. Never amend or rewrite commits
  that are already pushed unless the user asked (Step 7).
- Run the checks (unless `--no-run`): what the pre-push hook and CI run, scoped to the changed files —
  typecheck, lint, related tests. A failure: fix it if it comes from your change; if it fails on the base
  too, report it as pre-existing.

## Step 5 — Self-review the fixes (unless --no-review, or all fixes were trivial)

Run `code-review` at `high` on the fix commits only (`git diff <pushed head>..HEAD`), then verify each
of its findings the way `/pr-review` Step 4 does (independent read-only agents; keep only CONFIRMED
critical/high/medium introduced by the fixes). Fix the confirmed ones and re-run the checks.

## Step 6 — Report, then publish only on command

Show: commits made (one line each), the checks result, the self-review result, and the final reply list
(with commit links filled in where a reply says "fixed in …"). Then wait.

On the user's command ("push", "push and reply", "reply too", "re-request review"):
- Push with a normal `git push` (`--force-with-lease` only after a history rewrite the user approved).
- Reply inside each thread: `gh api repos/<o>/<r>/pulls/<n>/comments/<comment databaseId>/replies -f body=...`;
  review-body remarks get one PR comment that quotes them briefly.
- Resolve threads only if the user said so (many teams leave that to the reviewer).
- Re-request review from those who requested changes only on command
  (`gh pr edit <n> --add-reviewer <login>`).
- Re-run flaky checks only on command (`gh run rerun <id> --failed`).
Then give the links and a one-line summary.

## Step 7 — Ready to merge (with --ready, or when the user asks)

Show the list first; apply each item only after the user's go-ahead:
- Up to date with the base: rebase (or merge, if that is the repo's convention) and resolve conflicts;
  stop and ask on any conflict whose right resolution is not obvious.
- History: squash fixup/wip commits, drop AI co-author trailers, follow the commit convention. Before a
  force-push, warn that it may dismiss existing approvals (depends on branch protection).
- Description: matches the final code (what changed, why, how to test, rollout notes such as env
  vars or migrations), keeps the PR template's sections, links the issue; no AI mentions.
- Title: issue key and format as in recently merged PRs.
- Draft off (`gh pr ready <n>`) once the checks are green.
Finally run `gh pr view` again and report: mergeable state, checks, review decision and what is still
missing (e.g. "waiting for @x's approval"). For the release itself, point to `/pr-release-plan`.
