---
name: jira-check
description: Take a Jira issue apart before working on it. Reads the issue in full (description, acceptance criteria, comments, parent epic, sub-tasks, linked issues, attachments, linked docs), the related discussion and pull requests, finds the code involved and its history, checks the claim against the code and — read-only — against real behaviour (tests, dev endpoints, data), and gives a verdict (real and needed / works as designed / duplicate / obsolete / unclear) with evidence, then a work plan: approach, files, tests, API and data changes, rollout notes, risks, size, open questions, how to verify. Changes nothing in Jira or the code unless told to. Use when the user says "look at ABC-123", "is this really a bug", "do we need to do this", "what is needed for this issue", "make a plan for this task", in any language, or invokes /jira-check.
argument-hint: "<ISSUE-KEY | issue url> [--repo <name|path>]... [--quick]"
---

# Jira check: understand the issue, verify it, plan the work

Goal: before anyone writes code, know exactly what the issue asks, whether it is real and still needed,
where in the code it lives, and a concrete plan — every conclusion backed by evidence the user can click.

Arguments: `$ARGUMENTS`
- The issue key (e.g. `ABC-123`) or its URL.
- `--repo <name|path>` (repeatable): the repos to look in. Without it, find them (Step 2).
- `--quick`: skip the reproduction agent and the history deep-dive; for small, clear issues.

Hard rules:
- Read-only by default: no Jira edits (comments, status, assignee, fields), no code changes, no pushes,
  no messages. Any write only on the user's explicit command, after they saw the text.
- Reproduction stays harmless: local runs and tests, GET-style requests to dev/staging, read-only queries
  on local/dev databases. Never write to shared databases, never call production with side effects.
  Secrets come from env files without printing them.
- Evidence over guesses: each claim has a link, `file:line`, command output or quote. Say "unknown" and
  how to find out when you cannot verify something.
- Talk to the user in the language they write in. Text for Jira/colleagues in the language of the
  issue (English by default).
- Every issue key and PR you mention is a clickable link with its title in parentheses.
- No AI traces in anything prepared for others. Follow the user's `~/.claude/CLAUDE.md` where stricter.

## Step 1 — The issue, all of it

Through the connected Jira (Atlassian MCP or another Jira connector; if none is connected, say so and
ask the user to paste the issue):
- Summary, type, priority, status, assignee, reporter, created/updated, labels, components, fix version,
  sprint, due date.
- Description and acceptance criteria, in full. Attachments: list them; read text/log/image ones.
- All comments in order — the latest ones often change the scope.
- Parent epic (its goal and the sibling issues and their status), sub-tasks, linked issues
  (blocks / is blocked by / duplicates / relates) — one level deep, summary and status each.
- Remote links: PRs, Confluence/Notion pages, dashboards, incidents. Read the specs they point to.

Write down in plain words: what is asked, for whom, what "done" means, and what the issue does NOT say.

## Step 2 — Where it lives (parallel, read-only agents)

Send in ONE message (`subagent_type: "general-purpose"`; each prompt holds the issue summary,
description, acceptance criteria and the repo paths; "read-only: do not edit, push, post or change
anything"):

A. **Code map** — find the code involved: entry points (endpoints, handlers, jobs, consumers, CLI),
   the data flow to storage and external services, config and flags, tests that cover it, docs/API
   specs (Swagger/OpenAPI). Return a short map with `file:line` and how a request/event moves through it.

B. **History and discussion** — PRs and commits mentioning the key or the area
   (`gh search prs <KEY> --owner <org>`, `git log --all --grep=<KEY>`, `git log -S`/`blame` on the
   central lines: why is it like this, when did it change), earlier issues about the same thing,
   and, if a chat connector is available, the threads that mention the key. Return the timeline with
   links, decisions already taken, and anything that makes the issue obsolete (code removed, service
   decommissioned, fixed elsewhere) or a duplicate.

C. **Reproduce / measure** (skip with `--quick`, or for pure features) — check the reported behaviour:
   a unit/integration test that shows it, a dev/staging request with the expected vs actual answer, a
   read-only query on dev data, logs or metrics if connectors exist. Return the exact steps, the output
   and whether the claim holds, plus the root cause with `file:line` if found.

Repos: from `--repo`; else the task folder's repos (e.g. `/workspace/tasks/<KEY>…/*`), the issue's
component/labels, the repos of PRs that mention the key, or the org's repos whose name matches the
service. Use existing local clones (e.g. `/workspace/repos/*`); clone into a temp dir only if needed.
If it is unclear which repo, ask.

## Step 3 — Verdict

Combine the issue and A–C, re-read the key code yourself, and decide:
- **real, needed** — the problem exists / the feature is missing and still wanted;
- **works as designed** — the behaviour is intended (cite the code, spec or decision);
- **duplicate** / **already done** — link where;
- **obsolete** — the context is gone (link the change/decision);
- **unclear** — cannot be decided without someone's answer (who, which question).

With a confidence (high / medium / low) and the 2–4 strongest pieces of evidence.

## Step 4 — Plan (for "real, needed"; for the others, what to tell the reporter)

- **Approach**: the change in a few lines. If there are real alternatives, 2–3 options with trade-offs
  and the one you recommend, and why.
- **Changes**: files/modules with what changes in each; new code vs edits; what to remove.
- **Tests**: which to add or change (unit, integration, e2e), including one that fails today.
- **Contract and docs**: API request/response changes, backward compatibility for existing clients,
  Swagger/OpenAPI, README/docs, client announcement.
- **Data and config**: migrations, backfills, env vars, feature flags — and the rollout notes they imply
  (point to `/pr-release-plan` once there is a PR).
- **Split**: one PR or several (and their order) if the change is big or crosses repos.
- **Risks**: what could break, who depends on it, performance, security.
- **Size**: S (hours) / M (a day or two) / L (more) — with the main driver of the estimate.
- **Open questions**: each addressed to someone (reporter, another team, product), with a draft question.
- **Done when**: how to verify after release (request + expected answer, query, dashboard).

## Step 5 — Report and hand-off

In the user's language:

```
## [KEY](<url>) (<summary>) — <verdict>, confidence <h/m/l>
<status> · <type>/<priority> · reporter <name> · assignee <name> · epic [KEY](…) (…)

### What is asked
<3–5 lines: the ask, done criteria, what the issue does not say>

### What I found
- Code: <entry point file:line → … → storage>
- Behaviour: <reproduced / not reproduced: steps and output, in short>
- History: [#PR](…) (…) <what it changed>, <decision with link>

### Plan               ← or "What to tell the reporter"
1. …
Tests: … | API/docs: … | Data/config: … | Size: M — <why> | Risks: …

### Questions
- To <who>: "<draft question>"

### Drafts (not posted)
- Jira comment: "<short English summary of the analysis, the plan or the reason to close>"
```

Save the full analysis as `ANALYSIS.md` in the task folder (`/workspace/tasks/<KEY>…/` if it exists,
else the current folder) and say where it is. Then stop and wait.

On the user's command only: post the Jira comment (in the user's edited wording if given), change the
status or assignee, create sub-tasks for a split plan, or start implementing (in the task folder, on the
task branch, following the project rules).
