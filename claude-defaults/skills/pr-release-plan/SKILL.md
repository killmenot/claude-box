---
name: pr-release-plan
description: Plan and track the release of one or more pull requests to dev and production. Finds everything the change needs beyond the merge — env vars and feature flags per environment, migrations, backfills or one-off SQL, deployment config PRs (Helm / k8s specs / Terraform), other services that must ship first, sync/restart steps, code-freeze rules — orders it into a checklist with a verification and a rollback for every step, drafts the messages to the people who must act, and on later calls re-checks the real state (merged? deployed version? synced? flag on?) and says what is next. Read-only: it never merges, deploys, syncs, restarts, runs SQL or sends messages itself. Use when the user asks "how do we release this", "what is the rollout plan", "is it on prod yet", "what's next for the release", in any language, or invokes /pr-release-plan.
argument-hint: "<PR urls/numbers | issue key> [status]"
---

# PR release plan: from merged code to verified on production

Goal: a release where nothing is forgotten — the order of merges and deploys, config and data changes,
who does what, how each step is verified and undone — kept in one checklist that is re-checked against
reality on every call.

Arguments: `$ARGUMENTS`
- One or more PRs (URL, or number in the current repo) and/or an issue key whose PRs to release.
- `status` (or a later call in the same session/folder): re-check the existing plan, tick what is done,
  say what is next. Without a plan yet, build one first.

Hard rules:
- Read-only. Never merge, deploy, sync, restart, scale, change flags/secrets, run SQL against shared
  databases, or post/send messages. Give the user the exact command, the link to click, or a draft
  message for the person who has the access. Exception: a specific non-production read or command the
  user explicitly tells you to run.
- Facts only: every claim about the state (merged, deployed version, flag value, migration applied) has
  its evidence (link, command output). Unknown → say unknown and how to find out.
- Talk to the user in the language they write in; drafts for colleagues in the language of that
  channel/thread (English by default).
- Every PR or issue key you mention is a clickable link with its title in parentheses.
- No AI traces in anything prepared for others. Follow the user's `~/.claude/CLAUDE.md` where stricter.

## Step 1 — Gather the change

For each PR: `gh pr view --json number,title,url,state,mergedAt,baseRefName,headRefOid,body,files,isDraft,reviewDecision,mergeStateStatus`,
its diff, linked issues, and the discussion (PR comments; the issue; the team chat if a connector is
available — search for the PR number and issue key). Note what the change is for and who asked.

Then find, in the diff and around it (read-only agents in parallel are fine for big changes):
- **Config**: new/renamed/removed env vars, feature flags and their defaults; where each environment
  sets them (deployment config repo, secrets manager, flag service). Whether code works with the flag
  off — the safe default for the first deploy.
- **Data**: DB migrations (order, reversibility, locks or long runs on big tables), backfills, one-off
  SQL, cache or index rebuilds, queue/topic/consumer changes. For any SQL a person must run: read-only
  `SELECT` preview first, the mutating statement second, both checked against the schema (and on a local
  or dev DB when one is available).
- **Deployment config**: the repo that holds the service's deployment (Helm values, k8s specs,
  Terraform, CI deploy workflow) — find it from the rules, the README, CI workflows or recent PRs that
  mention the service (`gh search prs`). Existing open PRs there for this change, or the PR that is
  needed (which file, which key, which environments).
- **Dependencies**: other services or teams that must release first or after (API consumers, a
  middleware, a worker, an SDK), contracts that change for clients (announce?).
- **Process**: release rules from the project rules and docs (release branches, versioning/tags,
  changelog, code freeze and who grants exceptions, required approvals, on-call), how deploys happen
  (merge-to-deploy, tag, manual sync in ArgoCD/Flux/Spinnaker, pipeline approval), and whether merging
  the config PR alone restarts anything (often it does not — pods keep the old env until a sync/restart).

## Step 2 — Build the plan

Order the steps per environment (dev/staging first, then each production cluster/region), each with:
owner (the user / a named person or team / CI), action, how to verify, rollback.

```
## Release plan: [#<n>](<url>) (<title>) [+ more]
Goal: <one line> | Risk: low/medium/high — <why> | Freeze: <none / until … — exception needed from …>

### 0. Before merge
- [ ] Reviews/CI green on all PRs — verify: `gh pr checks <n>`
- [ ] Config PR [#…](…) (…) ready: flag `X=false` on prod, `true` on dev — verify: values file lines

### 1. Dev
- [ ] Merge [#…](…) (…) → deploy — owner: you — verify: version/image tag on dev = <sha/tag>
- [ ] Sync/restart <app> in <tool> — owner: <who> — verify: pods restarted after <time>, env has X
- [ ] Migration/backfill — owner: <who> — verify: <query/endpoint> — rollback: <how>
- [ ] Smoke test: <requests/checks with expected results>

### 2. Production (<cluster/region>)
...
### 3. After
- [ ] Monitor <dashboards/logs/alerts> for <time>
- [ ] Tell <channel/people> — draft below
- [ ] Cleanup later: remove flag/old code/env vars — follow-up issue/PR

### Drafts
- To <person/channel>: "<short message: what is needed, the exact command/SQL/link, by when>"
```

Rules for the plan:
- One owner per step; for steps the user cannot do (access, approvals), a ready draft request.
- The verification is concrete: a command, an endpoint with the expected answer, a log query, a
  dashboard link. "Check that it works" is not a verification.
- Every irreversible step (data change, contract change, prod migration) has a rollback or says
  "no rollback — <mitigation>" and comes as late as possible, after the reversible ones.
- Point out what blocks what (e.g. the backfill must run before the flag is turned on).
- Keep questions that only a person can answer at the top ("Who restarts dev?", "Is the freeze
  exception granted?").

Save the plan as `RELEASE-PLAN.md` in the current task folder (or the folder the session runs in) so
later calls can re-check it; tell the user where it is. Do not commit it to the service repo.

## Step 3 — Re-check on every later call (`status`, "merged it", "deployed", "what's next")

Read `RELEASE-PLAN.md` and verify each open step against reality, read-only:
- PRs: merged? merge commit, which release/tag contains it (`gh pr view`, `git tag --contains`).
- Deploys: the running version/image on each environment — via the tools that are available and
  logged in (`argocd app get <app>` / `kubectl get deploy -o jsonpath=...` / a `/version` or health
  endpoint / the CI deploy run). Sync status and when pods last restarted.
- Config: the flag/env value in the deployment config at the deployed revision (and in the running pod
  when readable).
- Data: the verification query or endpoint from the plan (read-only; dev/local DB only unless the user
  ran it and pasted the output).
- Messages: replies in the thread from the people asked (if a chat connector is available).

Then update the checklist in the file (tick with the evidence and time), and answer in a few lines:
what is done (with evidence), what is next and who does it (with the command or the draft), and any
surprise (e.g. "config PR merged but dev pods were not restarted — still old env").
