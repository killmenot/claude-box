'use strict';
// Container startup pieces of scripts/web-serve.js + a smoke test of scripts/web-metrics.js.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-serve-'));
process.env.HOME = tmp;
process.env.TMUX_TMPDIR = tmp;
delete process.env.TMUX;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const def = path.join(tmp, 'defaults');
fs.mkdirSync(def);
fs.writeFileSync(path.join(def, 'settings.json'), JSON.stringify({ theme: 'dark' }));
fs.writeFileSync(path.join(def, 'mcp.json'), JSON.stringify({ mcpServers: { grafana: { command: 'mcp-grafana' } } }));
process.env.CLAUDE_DEFAULTS = def;

const { seedDefaults } = require('../scripts/web-serve.js');
const read = (f) => JSON.parse(fs.readFileSync(path.join(tmp, f), 'utf8'));

test('first start: settings copied, MCP merged, notify hooks installed', () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'x';
  seedDefaults();
  const s = read('.claude/settings.json');
  assert.strictEqual(s.theme, 'dark');
  assert.strictEqual(s.hooks.Stop[0].hooks[0].command, 'claude-notify done');
  assert.strictEqual(s.hooks.Notification[0].hooks[0].command, 'claude-notify waiting');
  assert.strictEqual(s.hooks.UserPromptSubmit[0].hooks[0].command, 'claude-notify working');
  const c = read('.claude.json');
  assert.deepStrictEqual(c.mcpServers, { grafana: { command: 'mcp-grafana' } });
  assert.strictEqual(c.hasCompletedOnboarding, true);
});

test('later starts keep the user\'s own settings and MCP servers', () => {
  fs.writeFileSync(path.join(tmp, '.claude/settings.json'), JSON.stringify({ theme: 'light', hooks: { PreToolUse: [] } }));
  fs.writeFileSync(path.join(tmp, '.claude.json'), JSON.stringify({ mcpServers: { mine: { command: 'x' } }, numStartups: 5 }));
  seedDefaults();
  const s = read('.claude/settings.json');
  assert.strictEqual(s.theme, 'light');
  assert.deepStrictEqual(s.hooks.PreToolUse, []);
  assert.ok(s.hooks.Stop);
  const c = read('.claude.json');
  assert.deepStrictEqual(Object.keys(c.mcpServers).sort(), ['grafana', 'mine']);
  assert.strictEqual(c.numStartups, 5);
});

test('MCP urls: ${VAR} / ${VAR:-default} filled from the env (Claude Code takes them literally), keys stay out', () => {
  const { expandUrl } = require('../scripts/web-serve.js');
  delete process.env.CB_T_URL;
  assert.strictEqual(expandUrl('${CB_T_URL:-https://app.example.com}/mcp'), 'https://app.example.com/mcp');
  process.env.CB_T_URL = '';
  assert.strictEqual(expandUrl('${CB_T_URL:-https://app.example.com}/mcp'), 'https://app.example.com/mcp');   // empty = unset
  process.env.CB_T_URL = 'https://team.example.com/';
  assert.strictEqual(expandUrl('${CB_T_URL:-https://app.example.com}/mcp'), 'https://team.example.com/mcp');  // no double slash
  assert.strictEqual(expandUrl('https://mcp.example.com/mcp'), 'https://mcp.example.com/mcp');

  const helper = 'node -e "print the key"';
  fs.writeFileSync(path.join(def, 'mcp.json'), JSON.stringify({ mcpServers: {
    wiki: { type: 'http', url: '${CB_T_URL}/mcp', headersHelper: helper } } }));
  seedDefaults();
  const w = read('.claude.json').mcpServers.wiki;
  assert.strictEqual(w.url, 'https://team.example.com/mcp');
  assert.strictEqual(w.headersHelper, helper);
  delete process.env.CB_T_URL;
});

// metrics read /proc: Linux only, as in the image
test('metrics: host numbers without a token, nulls for the session part', { skip: process.platform !== 'linux' && 'reads /proc (Linux only)' }, async () => {
  const { metrics } = require('../scripts/web-metrics.js');
  const m = await metrics('');
  assert.ok(m.mem.total > 0);
  assert.ok(m.cpu >= 0 && m.cpu <= 100);
  assert.strictEqual(m.ctx, null);
  assert.strictEqual(m.git, null);
});

test('secrets leave the environment before anything is spawned', () => {
  const { dropSecrets, SECRET_ENV } = require('../scripts/web-serve.js');
  const e = { WEB_TERMINAL_PASSWORD: 'pw', NGROK_AUTHTOKEN: 'ng', WEB_TERMINAL_USER: 'claude', PATH: '/bin' };
  dropSecrets(e);
  assert.deepStrictEqual(e, { WEB_TERMINAL_USER: 'claude', PATH: '/bin' });
  assert.ok(SECRET_ENV.includes('WEB_TERMINAL_PASSWORD') && SECRET_ENV.includes('NGROK_AUTHTOKEN'));
});

// web-serve.js loads the sidecar BEFORE it makes the self-signed cert (so the secrets can leave
// the environment early); the https listener must still come up.
test('sidecar: the https listener starts even when the cert appears after the module loaded', async (t) => {
  const { spawn, execFileSync } = require('child_process');
  const net = require('net');
  const dir = fs.mkdtempSync(path.join(tmp, 'tls-'));
  const crt = path.join(dir, 'c.crt'), key = path.join(dir, 'c.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '1', '-subj', '/CN=t'], { stdio: 'ignore' });
  const free = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const [port, tlsPort] = [await free(), await free()];
  const script = `
    const sc = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'web-sidecar.js'))});
    process.env.WEB_TLS_CERT = ${JSON.stringify(crt)}; process.env.WEB_TLS_KEY = ${JSON.stringify(key)};
    sc.start({});`;
  const child = spawn(process.execPath, ['-e', script], {
    env: Object.assign({}, process.env, { HOME: tmp, WEB_TERMINAL_PORT: String(port), WEB_TLS_PORT: String(tlsPort),
      WEB_TERMINAL_INTERFACE: '127.0.0.1', WEB_TLS_CERT: '', WEB_TLS_KEY: '', WEB_CHAT_MODULE: '/nonexistent',
      WEB_TASKS_MODULE: '/nonexistent', WEB_PANEL_MODULE: '/nonexistent', WEB_WORKSPACE_MODULE: '/nonexistent' }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(() => child.kill());
  const out = await new Promise((res) => {
    let err = ''; const timer = setTimeout(() => res(err), 8000);
    child.stderr.on('data', (d) => { err += d; if (/sidecar https/.test(err)) { clearTimeout(timer); res(err); } });
    child.on('exit', () => { clearTimeout(timer); res(err); });
  });
  assert.match(out, /sidecar https:\/\/127\.0\.0\.1:\d+/, out);
});

test('pickTtydPort: finds the first free loopback port, explicit TTYD_PORT wins', async () => {
  const net = require('net');
  const { pickTtydPort } = require('../scripts/web-serve.js');
  const base = Number(process.env.WEB_TERMINAL_PORT || '7681') + 1;   // the search starts here
  const holders = [];
  for (const p of [base, base + 1]) {                                   // hold the first two candidates
    const srv = net.createServer();
    await new Promise((res) => { srv.once('error', res); srv.listen(p, '127.0.0.1', res); });
    holders.push(srv);                                                  // a failed listen = already busy
  }
  process.env.TMUX_TMPDIR = tmp;
  delete process.env.TTYD_PORT;
  assert.strictEqual(await pickTtydPort(), String(base + 2));           // skips past the busy ones
  process.env.TTYD_PORT = '7777';
  assert.strictEqual(await pickTtydPort(), '7777');                    // explicit wins
  delete process.env.TTYD_PORT;
  for (const srv of holders) if (srv.listening) srv.close();
});
