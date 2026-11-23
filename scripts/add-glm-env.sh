#!/usr/bin/env bash
# One-shot: add the GLM (z.ai) provider block to .env.example of a claude-box checkout,
# commit and push. Idempotent — running it twice changes nothing the second time.
#
# Usage (on the HOST, not inside the container):
#   bash scripts/add-glm-env.sh [repo-folder]     # default: this script's own repo
set -euo pipefail

repo="${1:-}"
if [ -z "$repo" ]; then
  repo="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")/.." && pwd -P)"
fi
# a folder named differently (e.g. the box at :8443 lives elsewhere): take it from the container
if [ ! -f "$repo/.env.example" ]; then
  cand="$(docker inspect claude-box-web --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)"
  [ -n "$cand" ] && repo="$cand"
fi
[ -f "$repo/.env.example" ] || { echo "✗ .env.example not found under $repo (pass the folder: bash $0 /path/to/claude-box)" >&2; exit 1; }
cd "$repo"

if grep -q "ANTHROPIC_BASE_URL" .env.example; then
  echo "Already there — nothing to do."
  exit 0
fi

cat >> .env.example <<'EOF'

# --- Model provider: GLM (z.ai) or any Anthropic-compatible provider ---------------------------
# Uncomment and fill in for GLM. Works in the web chat and the console alike.
# CLAUDE_CODE_OAUTH_TOKEN above must stay EMPTY in this mode.
# ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
# ANTHROPIC_AUTH_TOKEN=
# ANTHROPIC_DEFAULT_SONNET_MODEL=GLM-5.3-Flash
# ANTHROPIC_DEFAULT_OPUS_MODEL=GLM-5.3-Flash
# ANTHROPIC_DEFAULT_HAIKU_MODEL=GLM-5.3-Flash
EOF

grep -q "ANTHROPIC_BASE_URL" .env.example || { echo "✗ append failed"; exit 1; }
echo "Added the GLM block to $repo/.env.example"

git add .env.example
if git commit -m "env template: GLM (z.ai) provider block"; then
  git push origin "$(git rev-parse --abbrev-ref HEAD)" || { echo "✗ push failed — run 'git push' yourself and check auth" >&2; exit 1; }
  echo "Pushed: $(git log --oneline -1)"
else
  echo "Nothing to commit (someone already did it)."
fi
