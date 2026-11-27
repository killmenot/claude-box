'use strict';
// web-code.js: the Code tab's proxy to code-server. A stand-in binary plays code-server: it listens
// on the --socket it is given, echoes the request path, and answers a WebSocket upgrade.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-code-'));
const fake = path.join(tmp, 'code-server');
fs.writeFileSync(fake, `#!/usr/bin/env node
const http = require('http');
const a = process.argv.slice(2);
if (a[0] === '--install-extension') process.exit(0);
const sock = a[a.indexOf('--socket') + 1];
const s = http.createServer((req, res) => { res.end('path=' + req.url + ' auth=' + a[a.indexOf('--auth') + 1]); });
s.on('upgrade', (req, socket) => { socket.end('HTTP/1.1 101 Switching Protocols\\r\\nx-path: ' + req.url + '\\r\\n\\r\\n'); });
s.listen(sock);
`, { mode: 0o755 });
process.env.CODE_SERVER_BIN = fake;
process.env.HOME = tmp;
process.env.TMPDIR = tmp;

const code = require('../scripts/web-code.js');
let srv, port;
test.before(() => new Promise((r) => {
  srv = http.createServer((req, res) => code.proxy(req, res));
  srv.on('upgrade', (req, socket, head) => code.upgrade(req, socket, head));
  srv.listen(0, '127.0.0.1', () => { port = srv.address().port; r(); });
}));
test.after(() => { code.stop(); srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, body: b, headers: r.headers })); }).on('error', reject);
});

test('off unless the box was started with --vscode', () => {
  delete process.env.WEB_VSCODE;
  assert.strictEqual(code.enabled(), false);
  process.env.WEB_VSCODE = '1';
  assert.strictEqual(code.enabled(), true);
});

test('the prefix is stripped; /code redirects to /code/', async () => {
  assert.strictEqual(code.strip('/code/'), '/');
  assert.strictEqual(code.strip('/code/?folder=%2Fw'), '/?folder=%2Fw');
  assert.strictEqual(code.strip('/codex/a'), '/codex/a');
  const r0 = await get('/code?folder=%2Fw');
  assert.strictEqual(r0.status, 302);
  assert.strictEqual(r0.headers.location, '/code/?folder=%2Fw');
});

test('started on first use, on a private socket, behind the box login', async () => {
  const r = await get('/code/static/x.js?v=1');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body, 'path=/static/x.js?v=1 auth=none');
  const dir = path.join(tmp, `claude-box-code-${process.getuid()}`);
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
});

test('WebSocket upgrades go through with the prefix stripped', async () => {
  const reply = await new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('GET /code/stable-abc?reconnectionToken=t HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
    let b = ''; s.on('data', (d) => { b += d; }); s.on('end', () => resolve(b)); s.on('error', reject);
  });
  assert.match(reply, /101 Switching Protocols/);
  assert.match(reply, /x-path: \/stable-abc\?reconnectionToken=t/);
});

test('VS Code follows the launcher theme; other settings stay; a JSONC file is left alone', () => {
  const f = path.join(tmp, '.local', 'share', 'code-server', 'User', 'settings.json');
  assert.strictEqual(code.setTheme('dark'), true);
  assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8'))['workbench.colorTheme'], 'Default Dark Modern');
  fs.writeFileSync(f, JSON.stringify({ 'editor.fontSize': 15, 'workbench.colorTheme': 'Default Dark Modern' }));
  code.setTheme('light');
  const o = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(o['workbench.colorTheme'], 'Default Light Modern');
  assert.strictEqual(o['editor.fontSize'], 15);
  assert.strictEqual(o['window.autoDetectColorScheme'], false);
  fs.writeFileSync(f, '{ // mine\n "editor.fontSize": 15 }');
  assert.strictEqual(code.setTheme('dark'), false);
  assert.match(fs.readFileSync(f, 'utf8'), /\/\/ mine/);
  assert.throws(() => code.setTheme('blue'), /dark or light/);
});
