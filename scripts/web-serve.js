#!/usr/bin/env node
'use strict';
// claude-box container entrypoint (`claude-web-serve`). In order:
//   1. seed ~/.claude with the shared defaults (settings, MCP servers, notify hooks)
//   2. self-signed TLS cert (https = secure context: clipboard + browser notifications)
//   3. optional public tunnel (WEB_TUNNEL=1: ngrok with NGROK_AUTHTOKEN, else cloudflared)
//   4. bring back the sessions that were running before the restart (claude --resume in tmux)
//   5. ttyd on loopback (the in-browser console) + the sidecar on the public port, in this process
//   6. on SIGTERM: final session snapshot, tmux kill-server (Claude flushes), stop children
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const HOME = process.env.HOME || '/home/node';
const CLAUDE_DIR = path.join(HOME, '.claude');
const env = process.env;
const log = (...a) => console.log('claude-box web:', ...a);
const warn = (...a) => console.error('claude-box web:', ...a);

const PORT = env.WEB_TERMINAL_PORT || '7681';
const IFACE = env.WEB_TERMINAL_INTERFACE || '127.0.0.1';
// ttyd (the console) lives on loopback. When TTYD_PORT is not pinned, a free loopback port is
// FOUND at startup instead of guessed: several boxes share one daemon, and their UI ports are
// arbitrary — a "+1" guess collides with another instance's UI port and crash-loops the container.
const net = require('net');
function probeFree(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => res(true)));
  });
}
async function pickTtydPort() {
  if (env.TTYD_PORT) return env.TTYD_PORT;
  const base = Number(PORT) + 1;
  for (let p = base; p < base + 50; p++) if (await probeFree(p)) return String(p);
  return String(base);      // nothing free in range: let ttyd fail visibly, same as before
}
const TLS_PORT = env.WEB_TLS_PORT || '8443';
const USER = env.WEB_TERMINAL_USER || 'claude';
const PW = env.WEB_TERMINAL_PASSWORD || '';
const NGROK_TOKEN = env.NGROK_AUTHTOKEN || '';
const RESTORE = (env.WEB_RESTORE_SESSIONS || '1') !== '0';
Object.assign(env, { WEB_TERMINAL_PORT: PORT, WEB_TERMINAL_INTERFACE: IFACE, WEB_TLS_PORT: TLS_PORT });

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
function writeJson(f, o) { const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(o, null, 2)); fs.renameSync(t, f); }

// Secrets that only this process needs. They are removed from the environment before anything
// is spawned, so ttyd shells, tmux, Claude sessions and their tools never inherit them (a
// prompt-injected session could otherwise read the web login that also guards the tunnel).
const SECRET_ENV = ['WEB_TERMINAL_PASSWORD', 'NGROK_AUTHTOKEN'];
function dropSecrets(e) { for (const k of SECRET_ENV) delete e[k]; return e; }

// cb-session (inside the box) talks to the sidecar with this per-start token instead of the web
// password; the sidecar accepts it only for /chat/api/* straight from loopback.
const API_TOKEN_FILE = path.join(CLAUDE_DIR, '.cb-api-token');
function writeApiToken() {
  const tok = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(API_TOKEN_FILE + '.tmp', tok + '\n', { mode: 0o600 });
  fs.renameSync(API_TOKEN_FILE + '.tmp', API_TOKEN_FILE);
  return tok;
}

// ---------- 1. defaults ----------
// settings.json is copied once (the user may change it later); MCP servers are re-synced from the
// image on every start; the claude-notify hooks are (re)installed unless CLAUDE_NOTIFY_DISABLE is set.
function seedDefaults() {
  const DEF = env.CLAUDE_DEFAULTS || '/opt/claude-defaults';
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  const settingsFile = path.join(CLAUDE_DIR, 'settings.json');
  const configFile = path.join(HOME, '.claude.json');
  if (!fs.existsSync(settingsFile) && fs.existsSync(path.join(DEF, 'settings.json'))) {
    fs.copyFileSync(path.join(DEF, 'settings.json'), settingsFile);
  }
  const config = readJson(configFile) || {};
  const mcp = readJson(path.join(DEF, 'mcp.json'));
  if (mcp && mcp.mcpServers) config.mcpServers = Object.assign({}, config.mcpServers, mcp.mcpServers);
  // an OAuth token in .env: skip the first-run login wizard (Claude Code ignores it during onboarding)
  if (env.CLAUDE_CODE_OAUTH_TOKEN) config.hasCompletedOnboarding = true;
  writeJson(configFile, config);
  if (!env.CLAUDE_NOTIFY_DISABLE) {
    const s = readJson(settingsFile) || {};
    const hook = (state) => [{ hooks: [{ type: 'command', command: `claude-notify ${state}` }] }];
    s.hooks = Object.assign({}, s.hooks, { Stop: hook('done'), Notification: hook('waiting'), UserPromptSubmit: hook('working') });
    writeJson(settingsFile, s);
  }
}

// ---------- 2. TLS ----------
function setupTls() {
  if ((env.WEB_TLS || '1') !== '1') return;
  const dir = path.join(CLAUDE_DIR, 'web-certs'), crt = path.join(dir, 'web.crt'), key = path.join(dir, 'web.key');
  const nonEmpty = (f) => { try { return fs.statSync(f).size > 0; } catch (_) { return false; } };
  if (!nonEmpty(crt) || !nonEmpty(key)) {
    fs.mkdirSync(dir, { recursive: true });
    // best effort: the LAN IP goes into the SAN so https works from other devices too
    let san = 'DNS:localhost,IP:127.0.0.1';
    try {
      const ip = /\ssrc\s+([0-9.]+)/.exec(execFileSync('ip', ['route', 'get', '1.1.1.1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
      if (ip) san += ',IP:' + ip[1];
    } catch (_) {}
    if (env.WEB_TLS_SAN) san += ',' + env.WEB_TLS_SAN;
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '3650',
        '-subj', '/CN=claude-box', '-addext', 'subjectAltName=' + san], { stdio: 'ignore' });
      log(`self-signed cert generated (SAN=${san})`);
    } catch (_) { warn('openssl failed — falling back to http'); return; }
  }
  if (nonEmpty(crt) && nonEmpty(key)) Object.assign(env, { WEB_TLS_CERT: crt, WEB_TLS_KEY: key });
}

// ---------- 3. tunnel ----------
// The public URL goes to ~/.claude/web-tunnel-url, which the host sees through the bind mount.
const TUNNEL_URL_FILE = path.join(CLAUDE_DIR, 'web-tunnel-url');
function pollUrl(read) {
  let n = 0;
  const t = setInterval(async () => {
    const u = await read().catch(() => null);
    if (u) { fs.writeFileSync(TUNNEL_URL_FILE, u + '\n'); clearInterval(t); }
    else if (++n >= 120) clearInterval(t);                    // ~60s window
  }, 500);
}
function startTunnel() {
  try { fs.writeFileSync(TUNNEL_URL_FILE, ''); } catch (_) {}
  if (env.WEB_TUNNEL !== '1') return null;
  if (!PW) { warn('✗ Tunnel not started: WEB_TERMINAL_PASSWORD is not set — a public shell without a password is not allowed.'); return null; }
  const target = `http://127.0.0.1:${PORT}`;
  if (NGROK_TOKEN) {
    // --inspect=false: the local inspector (127.0.0.1:4040 on the HOST network) would otherwise
    // record every request, Authorization header included; its API still serves the tunnel URL
    const args = ['http', PORT, '--log=stdout', '--inspect=false'];
    if (env.NGROK_DOMAIN) args.push('--domain=' + env.NGROK_DOMAIN);
    log(`starting ngrok -> ${target}`);
    const p = spawn('ngrok', args, { stdio: ['ignore', 'ignore', 'inherit'], env: Object.assign({}, env, { NGROK_AUTHTOKEN: NGROK_TOKEN }) });
    pollUrl(async () => {
      const r = await fetch('http://localhost:4040/api/tunnels');
      const j = await r.json();
      const t = (j.tunnels || []).find((x) => /^https:/.test(x.public_url || ''));
      return t && t.public_url;
    });
    return p;
  }
  // --protocol http2: outbound QUIC/UDP 7844 is blocked on some networks (VM/NAT) — cloudflared
  // then retries the QUIC handshake forever and never prints the public URL.
  const cfLog = path.join(CLAUDE_DIR, 'cloudflared.log');
  log(`starting cloudflared (TryCloudflare, no token) -> ${target}`);
  const out = fs.openSync(cfLog, 'w');
  const p = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', target], { stdio: ['ignore', out, out] });
  pollUrl(async () => { const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(fs.readFileSync(cfLog, 'utf8')); return m && m[0]; });
  return p;
}

// ---------- 4-6. run ----------
async function main() {
  try {
    await run();
  } catch (e) {
    if (e && /EACCES/.test(String(e.code || e.message))) {
      warn(`${e.message}`);
      warn(`${HOME} is not writable by uid ${process.getuid()} — the ./home bind mount belongs to another user.`);
      warn(`Re-run 'claude-box' so it fills BOX_UID/BOX_GID in .env, then 'claude-box --stop && claude-box'.`);
      process.exit(1);
    }
    throw e;
  }
}
async function run() {
  if (IFACE !== '127.0.0.1' && !PW) {
    warn(`WARNING: listening on ${IFACE} WITHOUT a password — an open writable shell exposed to the outside!`);
    warn('         Set WEB_TERMINAL_PASSWORD in .env.');
  }
  // pick the ttyd port BEFORE the sidecar loads: the sidecar reads TTYD_PORT from the env at
  // require time (it proxies /term there)
  env.TTYD_PORT = await pickTtydPort();
  const TTYD_PORT = env.TTYD_PORT;
  // load the sidecar while the web login is still in the environment (it reads it at load),
  // then take the secrets out of the environment for everything spawned from here on
  const sidecar = require('./web-sidecar.js');
  dropSecrets(env);
  let apiToken = '';
  try { apiToken = writeApiToken(); } catch (e) { warn('api token:', e.message); }
  try { seedDefaults(); } catch (e) { warn('seeding defaults failed:', e.message); }
  setupTls();
  const tunnel = startTunnel();

  const registry = require('./web-registry.js');
  if (RESTORE) { try { registry.restore((s) => log(s)); } catch (e) { warn('restore failed:', e.message); } }

  // ttyd: loopback only, under /term. With network_mode: host its port is on the HOST's loopback,
  // where any web page could open a WebSocket to it — so it ALWAYS has its own random login,
  // known only to the sidecar, which checks the user and swaps that login in when proxying.
  const ttydAuth = 'cb:' + crypto.randomBytes(24).toString('hex');
  const ttydArgs = ['--interface', '127.0.0.1', '--port', TTYD_PORT, '--writable', '--url-arg', '--base-path', '/term',
    '-c', ttydAuth];
  if (env.WEB_TERMINAL_FONT_SIZE) ttydArgs.push('-t', 'fontSize=' + env.WEB_TERMINAL_FONT_SIZE);
  const index = env.WEB_TERMINAL_INDEX || '/usr/local/share/claude-web/index.html';
  if (fs.existsSync(index)) ttydArgs.push('--index', index);
  const ttyd = spawn('ttyd', ttydArgs.concat('claude-web-menu'), { stdio: 'inherit' });

  log(`http://${IFACE}:${PORT}  (launcher; auth: ${PW ? 'on' : 'off'}; ttyd@127.0.0.1:${TTYD_PORT})`);
  if (env.WEB_TLS_CERT) log(`https://${IFACE}:${TLS_PORT}  (secure: clipboard + notifications)`);
  sidecar.start({ ttydAuth, apiToken });

  // keep the list of running sessions fresh on disk: covers a hard kill where no handler runs
  const snap = RESTORE ? setInterval(() => { try { registry.snapshot(); } catch (_) {} }, 15000) : null;

  let down = false;
  function shutdown(code) {
    if (down) return; down = true;
    if (snap) clearInterval(snap);
    // final snapshot BEFORE killing tmux — otherwise it would record "nothing is running"
    if (RESTORE) { try { registry.snapshot(); } catch (_) {} }
    try { execFileSync('tmux', ['kill-server'], { stdio: 'ignore' }); } catch (_) {}   // SIGHUP -> Claude flushes state
    setTimeout(() => {
      for (const p of [ttyd, tunnel]) if (p) try { p.kill(); } catch (_) {}
      try { fs.writeFileSync(TUNNEL_URL_FILE, ''); } catch (_) {}
      process.exit(code);
    }, 1000);
  }
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  // ttyd or the tunnel died -> wind down; the restart policy brings the container back
  for (const [name, p] of [['ttyd', ttyd], ['tunnel', tunnel]]) {
    if (!p) continue;
    p.on('exit', (c) => { if (!down) { warn(`${name} exited (${c}), shutting down`); shutdown(1); } });
    p.on('error', (e) => { if (!down) { warn(`${name} failed to start: ${e.message}`); shutdown(1); } });
  }
}

module.exports = { seedDefaults, pickTtydPort, dropSecrets, SECRET_ENV };
if (require.main === module) main();
