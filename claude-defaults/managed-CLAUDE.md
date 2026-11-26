# claude-box

Rules for every Claude session in this box. claude-box puts this file at
/etc/claude-code/CLAUDE.md, so it applies in every folder, in chat and in the console.

## Git identity

- Commit as the identity git already has (`git config user.name` / `git config user.email`).
  The box sets it from the host's git identity, from Settings → GitHub in the web UI, or from the
  GitHub account signed in to `gh`.
- If there is none (git says "Author identity unknown") or it is empty, stop and ask the user
  who to commit as. Never take a name or email from the repository's history, from its other
  authors, from another project or from a CI bot, and never get around it with `--author`,
  `-c user.name=...` or the GIT_AUTHOR_* / GIT_COMMITTER_* variables.
- When the user gives a name and email, set them with `git config --global` (repo-local only
  if they ask for this repository alone), and say which one you set.
- Do not rewrite the author of commits that already exist unless the user asks.
