FROM node:22-slim

# UTF-8 locale (C.UTF-8 is built into glibc, the locales package isn't needed) — otherwise tmux/fzf
# in the web terminal break Cyrillic (show "_") and box-drawing characters.
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

# Base utilities + git/PR + DB clients (psql, mysql, redis-cli) + Python 3 (venv, pip)
# + GitHub CLI + Claude Code. The node user (uid 1000) already exists in the image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git git-lfs openssh-client ca-certificates curl wget less jq ripgrep gnupg fzf vim \
      postgresql-client default-mysql-client redis-tools tmux iproute2 \
      python3 python3-venv python3-pip procps unzip \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code \
 && mkdir -p /home/node/.claude /workspace \
 && chown -R node:node /home/node /workspace

# Docker CLI + compose (used only when the host's socket is mounted: DOCKER_ACCESS=1)
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && . /etc/os-release \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin docker-buildx-plugin \
 && rm -rf /var/lib/apt/lists/*

# Grafana MCP (mcp-grafana) — a Go binary for MCP (Loki/Prometheus/dashboards).
# Credentials are taken from ENV (GRAFANA_URL + GRAFANA_SERVICE_ACCOUNT_TOKEN), see claude-defaults/mcp.json.
# The version is pinned (rather than latest via api.github.com) — otherwise rate-limit/504 from the GitHub API breaks the build.
# Architecture of the image being built (set by BuildKit: amd64 | arm64). The binaries below
# are fetched for it, so the image also builds natively on ARM hosts (Apple Silicon, Graviton).
ARG TARGETARCH
ARG MCP_GRAFANA_VERSION=v0.16.0
RUN case "${TARGETARCH:-amd64}" in arm64) a=arm64 ;; *) a=x86_64 ;; esac \
 && curl -fsSL --retry 5 --retry-all-errors "https://github.com/grafana/mcp-grafana/releases/download/${MCP_GRAFANA_VERSION}/mcp-grafana_Linux_${a}.tar.gz" \
      | tar -xz -C /usr/local/bin mcp-grafana \
 && chmod +x /usr/local/bin/mcp-grafana

# ttyd — web terminal (static binary for the target arch from GitHub releases), see docs/.../web-terminal.
# The version is pinned for the same reason as mcp-grafana above.
ARG TTYD_VERSION=1.7.7
RUN case "${TARGETARCH:-amd64}" in arm64) a=aarch64 ;; *) a=x86_64 ;; esac \
 && curl -fsSL --retry 5 --retry-all-errors "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${a}" \
      -o /usr/local/bin/ttyd \
 && chmod +x /usr/local/bin/ttyd

# ngrok v3 — public tunnel to the web terminal (see --tunnel). A static binary
# from the official CDN; the version is pinned for the same reason as ttyd/mcp-grafana above.
ARG NGROK_VERSION=3.18.4
RUN case "${TARGETARCH:-amd64}" in arm64) a=arm64 ;; *) a=amd64 ;; esac \
 && curl -fsSL --retry 5 --retry-all-errors "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v${NGROK_VERSION}-stable-linux-${a}.tgz" \
      | tar -xz -C /usr/local/bin ngrok \
 && chmod +x /usr/local/bin/ngrok

# cloudflared — token-free tunnel backend (TryCloudflare). Used by default
# when NGROK_AUTHTOKEN is not set. We pull latest: TryCloudflare requires a recent build,
# and cloudflared is backward compatible (we run it with --no-autoupdate).
RUN case "${TARGETARCH:-amd64}" in arm64) a=arm64 ;; *) a=amd64 ;; esac \
 && curl -fsSL --retry 5 --retry-all-errors "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${a}" \
      -o /usr/local/bin/cloudflared \
 && chmod +x /usr/local/bin/cloudflared

# Trust for the TLS proxy certificate(s): put your .crt in certs/ (see README).
COPY certs/ /usr/local/share/ca-certificates/
RUN update-ca-certificates

# Web chat: Claude Agent SDK + ws for the HTML chat mode of the launcher (web-chat.js).
# Kept in its own prefix, versions pinned like the binaries above. Installed BEFORE the scripts
# are copied, so editing a script does not re-run npm.
ARG CLAUDE_AGENT_SDK_VERSION=0.3.326
ARG WS_VERSION=8.18.0
RUN mkdir -p /opt/claude-web-chat && cd /opt/claude-web-chat \
 && echo '{"name":"claude-web-chat","private":true}' > package.json \
 && npm install --omit=dev --no-audit --no-fund \
      "@anthropic-ai/claude-agent-sdk@${CLAUDE_AGENT_SDK_VERSION}" "ws@${WS_VERSION}" \
 && npm cache clean --force

# The built-in browser for the Browser tab — only when built by `./claude-box --browser` (BROWSER=1):
# Chromium on a virtual display (Xvfb), shown through x11vnc + noVNC (pinned, its ES modules only).
# Placed before the html and script copies, so editing those does not download it again.
ARG BROWSER=0
ARG NOVNC_VERSION=1.5.0
# the ISO week from ./claude-box: a new week reinstalls Chromium (security updates), see claude-box
ARG BROWSER_REFRESH=
RUN echo "browser layer: ${BROWSER_REFRESH:-no refresh}" >/dev/null; if [ "$BROWSER" = 1 ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        chromium xvfb x11vnc fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
      && rm -rf /var/lib/apt/lists/* \
      && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
      && mkdir -p /opt/novnc \
      && curl -fsSL --retry 5 --retry-all-errors "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" \
         | tar -xz -C /opt/novnc --strip-components=1 "noVNC-${NOVNC_VERSION}/core" "noVNC-${NOVNC_VERSION}/vendor"; \
    fi

# Custom ttyd frontend (--index): sound on bell, hidden scroll, deep-link.
# xterm is vendored locally (html/vendor) and inlined into a self-contained index.html
# (ttyd serves a SINGLE file; we don't use a CDN — the terminal has shell access).
COPY html/ /opt/claude-web-src/
RUN node /opt/claude-web-src/build-index.js \
      /opt/claude-web-src/index.html /usr/local/share/claude-web/index.html \
 && node /opt/claude-web-src/build-launcher.js \
      /opt/claude-web-src/launcher.html /usr/local/share/claude-web/launcher.html \
 && cp /opt/claude-web-src/browser.html /usr/local/share/claude-web/browser.html

# The web server (Node): entrypoint, sidecar, chat, session registry, metrics, search, preview.
# VS Code in the browser (code-server) for the Code tab — only when built by `./claude-box --vscode`
# (VSCODE=1); the default image stays without it. Pinned like ttyd above. Placed before the
# script copies, so editing the scripts does not download it again.
ARG VSCODE=0
ARG CODE_SERVER_VERSION=4.96.4
RUN if [ "$VSCODE" = 1 ]; then \
      a="$(dpkg --print-architecture)" \
      && curl -fsSL --retry 5 --retry-all-errors -o /tmp/code-server.deb \
         "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_${a}.deb" \
      && dpkg -i /tmp/code-server.deb && rm -f /tmp/code-server.deb; \
    fi

# All modules live side by side in /usr/local/lib/claude-web; the commands that other
# processes call (the entrypoint, the registry CLI, cb-session) are symlinked onto PATH.
COPY scripts/*.js /usr/local/lib/claude-web/
RUN ln -sf /usr/local/lib/claude-web/web-serve.js /usr/local/bin/claude-web-serve \
 && ln -sf /usr/local/lib/claude-web/web-registry.js /usr/local/bin/claude-web-registry \
 && ln -sf /usr/local/lib/claude-web/cb-session.js /usr/local/bin/cb-session \
 && chmod +x /usr/local/lib/claude-web/web-serve.js /usr/local/lib/claude-web/web-registry.js /usr/local/lib/claude-web/cb-session.js

# The two shell pieces: the ttyd landing picker (tmux) and the Claude hook (bell + tab title +
# registry), plus the tmux config (set-titles -> tab title)
COPY scripts/web-menu.sh /usr/local/bin/claude-web-menu
COPY scripts/notify.sh /usr/local/bin/claude-notify
COPY scripts/claude-default.sh /usr/local/bin/claude-default
COPY scripts/tmux.conf /etc/tmux.conf
RUN chmod +x /usr/local/bin/claude-web-menu /usr/local/bin/claude-notify /usr/local/bin/claude-default

# Entry wrapper: names the run uid in /etc/passwd (see web-entry.sh), then drops to it
COPY scripts/web-entry.sh /usr/local/bin/claude-web-entry
RUN chmod +x /usr/local/bin/claude-web-entry

# Shared defaults (settings + MCP) — seeded into ~/.claude at startup (see web-serve.js)
COPY claude-defaults/ /opt/claude-defaults/
# Rules for every Claude session in the box (git identity, ...): the managed CLAUDE.md location
RUN mkdir -p /etc/claude-code && cp /opt/claude-defaults/managed-CLAUDE.md /etc/claude-code/CLAUDE.md

# A claude installed or updated by the native installer lives in ~/.local/bin (the home dir is
# a bind mount, so it survives image rebuilds) — prefer it over the image's npm copy.
ENV PATH=/home/node/.local/bin:$PATH

WORKDIR /workspace
USER node
ENTRYPOINT ["/usr/local/bin/claude-web-entry"]
