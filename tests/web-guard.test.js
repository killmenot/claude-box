'use strict';
// scripts/web-guard.js (CSRF / cross-site WebSocket / DNS rebinding) — unit checks, then the real
// sidecar in a child process: cross-site requests get 403 and change nothing.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const { makeGuard, makeAuth } = require('../scripts/web-guard.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-guard-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const req = (method, headers) => ({ method, headers: Object.assign({ host: 'localhost:8080' }, headers) });
const withPw = makeGuard({ password: 'pw', env: {}, tunnelFile: path.join(tmp, 'none') });
const noPw = makeGuard({ password: '', env: {}, tunnelFile: path.join(tmp, 'none') });

test('same-origin and non-browser requests pass', () => {
  assert.strictEqual(withPw(req('GET', {})), null);
  assert.strictEqual(withPw(req('POST', {})), null);                                    // cb-session / curl
  assert.strictEqual(withPw(req('POST', { origin: 'http://localhost:8080', 'sec-fetch-site': 'same-origin' })), null);
  assert.strictEqual(withPw(req('POST', { 'sec-fetch-site': 'none' })), null);           // typed into the address bar
  assert.strictEqual(withPw({ method: 'POST', headers: { host: 'box.example:443', origin: 'https://box.example' } }), null);
});

test('cross-site state changes are refused', () => {
  assert.match(withPw(req('POST', { origin: 'https://evil.example' })), /cross-origin/);
  assert.match(withPw(req('POST', { 'sec-fetch-site': 'cross-site' })), /cross-site/);
  assert.match(withPw(req('POST', { 'sec-fetch-site': 'same-site', origin: 'http://localhost:9999' })), /cross-site/);
  assert.match(withPw(req('POST', { origin: 'http://localhost:9999' })), /cross-origin/);  // another local port
  assert.match(withPw(req('POST', { origin: 'null' })), /cross-origin/);                  // sandboxed iframe / file://
  assert.match(withPw(req('DELETE', { origin: 'https://evil.example' })), /cross-origin/);
});

test('Fetch Metadata: from another site only a top-level navigation passes', () => {
  const x = (mode, dest, extra) => withPw(req('GET', Object.assign({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': mode, 'sec-fetch-dest': dest }, extra)));
  assert.strictEqual(x('navigate', 'document'), null);                     // the user clicked a link to the box
  assert.match(x('navigate', 'iframe'), /cross-site/);                     // the terminal in a hidden frame
  assert.match(x('no-cors', 'image'), /cross-site/);                       // <img src=/panel> starting paid runs
  assert.match(x('cors', 'empty'), /cross-site/);                          // fetch()
  assert.strictEqual(x('navigate', 'document', { 'sec-fetch-site': 'same-site' }), null);   // a link from a sibling site
  assert.match(x('navigate', 'iframe', { 'sec-fetch-site': 'same-site' }), /cross-site/);
  assert.match(withPw(req('POST', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })), /cross-site/);  // form POST
  assert.strictEqual(withPw(req('GET', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'iframe' })), null);
});

// ---------- login ----------
const basic = (u, p) => 'Basic ' + Buffer.from(u + ':' + p).toString('base64');
const areq = (auth, extra, url) => ({ url: url || '/', headers: Object.assign(auth ? { authorization: auth } : {}, extra), socket: { remoteAddress: '127.0.0.1' } });

test('login: right / wrong / missing, no password = open', () => {
  const a = makeAuth({ user: 'claude', password: 'pw' });
  assert.deepStrictEqual(a(areq(basic('claude', 'pw'))), { ok: true });
  assert.strictEqual(a(areq(basic('claude', 'nope'))).status, 401);
  assert.strictEqual(a(areq(basic('other', 'pw'))).status, 401);
  assert.strictEqual(a(areq(null)).status, 401);
  assert.strictEqual(a(areq('Basic %%%')).status, 401);
  assert.deepStrictEqual(makeAuth({ password: '' })(areq(null)), { ok: true });
});

test('login: a client is locked after repeated failures, others are not', () => {
  let t = 1e9; const a = makeAuth({ user: 'claude', password: 'pw', now: () => t });
  const bad = areq(basic('claude', 'x'), { 'x-forwarded-for': '203.0.113.7' });
  for (let i = 0; i < 9; i++) assert.strictEqual(a(bad).status, 401);
  assert.strictEqual(a(bad).status, 401);                                  // 10th failure locks
  const locked = a(areq(basic('claude', 'pw'), { 'x-forwarded-for': '203.0.113.7' }));
  assert.strictEqual(locked.status, 429, 'even the right password waits out the lock');
  assert.ok(locked.retry > 0);
  assert.deepStrictEqual(a(areq(basic('claude', 'pw'), { 'x-forwarded-for': '198.51.100.1' })), { ok: true });
  t += 16 * 60000;
  assert.deepStrictEqual(a(areq(basic('claude', 'pw'), { 'x-forwarded-for': '203.0.113.7' })), { ok: true });
});

test('login: many clients failing together lock everyone for a while (spoofed X-Forwarded-For)', () => {
  let t = 1e9; const a = makeAuth({ user: 'claude', password: 'pw', now: () => t, limits: { GLOBAL_MAX: 20 } });
  for (let i = 0; i < 20; i++) a(areq(basic('claude', 'g' + i), { 'x-forwarded-for': '10.0.0.' + i }));
  assert.strictEqual(a(areq(basic('claude', 'pw'), { 'x-forwarded-for': '10.9.9.9' })).status, 429);
  t += 11 * 60000;
  assert.deepStrictEqual(a(areq(basic('claude', 'pw'))), { ok: true });
});

test('login: the cb-session API token works only for /chat/api/* straight from loopback', () => {
  const a = makeAuth({ user: 'claude', password: 'pw', apiToken: 'tok123' });
  const api = (h, url, ip) => a({ url: url || '/chat/api/new', headers: h, socket: { remoteAddress: ip || '127.0.0.1' } });
  assert.deepStrictEqual(api({ 'x-cb-api-token': 'tok123' }), { ok: true });
  assert.deepStrictEqual(api({ 'x-cb-api-token': 'tok123' }, '/chat/api/status?token=a'), { ok: true });
  assert.strictEqual(api({ 'x-cb-api-token': 'wrong' }).status, 401);
  assert.strictEqual(api({ 'x-cb-api-token': 'tok123' }, '/sessions').status, 401, 'not for the rest of the UI');
  assert.strictEqual(api({ 'x-cb-api-token': 'tok123' }, null, '192.168.1.5').status, 401, 'not from the LAN');
  assert.strictEqual(api({ 'x-cb-api-token': 'tok123', 'cf-connecting-ip': '1.2.3.4' }).status, 401, 'not through a tunnel');
  assert.strictEqual(api({ 'x-cb-api-token': 'tok123', 'x-forwarded-for': '1.2.3.4' }).status, 401, 'not through a proxy');
});

test('cross-site WebSocket upgrades are refused, even as GET', () => {
  assert.match(withPw(req('GET', { upgrade: 'websocket', origin: 'https://evil.example' })), /cross-origin/);
  assert.strictEqual(withPw(req('GET', { upgrade: 'websocket', origin: 'http://localhost:8080' })), null);
});

test('behind a tunnel that rewrites Host, the tunnel origin is accepted', () => {
  const f = path.join(tmp, 'tunnel-url');
  fs.writeFileSync(f, 'https://abc-def.trycloudflare.com\n');
  const g = makeGuard({ password: 'pw', env: {}, tunnelFile: f });
  const o = { origin: 'https://abc-def.trycloudflare.com' };
  assert.strictEqual(g({ method: 'POST', headers: Object.assign({ host: '127.0.0.1:8080' }, o) }), null);
  assert.strictEqual(g({ method: 'POST', headers: Object.assign({ host: '127.0.0.1:8080', 'x-forwarded-host': 'abc-def.trycloudflare.com' }, o) }), null);
  assert.match(g({ method: 'POST', headers: { host: '127.0.0.1:8080', origin: 'https://other.trycloudflare.com' } }), /cross-origin/);
  const n = makeGuard({ password: 'pw', env: { NGROK_DOMAIN: 'me.ngrok.app' }, tunnelFile: path.join(tmp, 'none') });
  assert.strictEqual(n({ method: 'POST', headers: { host: '127.0.0.1:8080', origin: 'https://me.ngrok.app' } }), null);
});

test('without a password only loopback/IP hosts are served (DNS rebinding)', () => {
  assert.strictEqual(noPw(req('GET', {})), null);
  for (const host of ['127.0.0.1:8080', '[::1]:8080', '192.168.1.20:8080', 'app.localhost']) {
    assert.strictEqual(noPw({ method: 'GET', headers: { host } }), null, host);
  }
  assert.match(noPw({ method: 'GET', headers: { host: 'rebind.evil.example:8080' } }), /host not allowed/);
  assert.match(noPw({ method: 'GET', headers: {} }), /host not allowed/);
  const g = makeGuard({ password: '', env: { WEB_ALLOWED_HOSTS: 'mybox.tail1234.ts.net, other.lan' } });
  assert.strictEqual(g({ method: 'GET', headers: { host: 'mybox.tail1234.ts.net:8080' } }), null);
  // with a password any Host name is fine (a rebinding page has no credentials)
  assert.strictEqual(withPw({ method: 'GET', headers: { host: 'mybox.lan:8080' } }), null);
});

// ---------- the real sidecar ----------
function freePort() {
  return new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function call(port, method, p, headers, body) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (x) => {
      let b = ''; x.on('data', (d) => { b += d; }); x.on('end', () => res({ status: x.statusCode, body: b }));
    });
    r.on('error', rej); r.end(body);
  });
}
function upgrade(port, headers) {
  return new Promise((res, rej) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('GET /chat/ws HTTP/1.1\r\n' + Object.entries(headers).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n');
    });
    let b = ''; s.on('data', (d) => { b += d; }); s.on('end', () => res(b.split('\r\n')[0])); s.on('error', rej);
  });
}

// a stand-in for ttyd: records the Authorization header it receives, on HTTP and on upgrades
function fakeTtyd(port) {
  const seen = [];
  const srv = http.createServer((q, r) => { seen.push(q.headers.authorization || ''); r.writeHead(200, { 'content-type': 'text/html' }); r.end('ttyd page'); });
  srv.on('upgrade', (q, sock) => { seen.push(q.headers.authorization || ''); sock.end('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n'); });
  return new Promise((res) => srv.listen(port, '127.0.0.1', () => res({ srv, seen })));
}
function upgradeTo(port, p, headers) {
  return new Promise((res, rej) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('GET ' + p + ' HTTP/1.1\r\n' + Object.entries(headers).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n');
    });
    let b = ''; s.on('data', (d) => { b += d; if (/\r\n\r\n/.test(b)) { s.destroy(); res(b.split('\r\n')[0]); } });
    s.on('end', () => res(b.split('\r\n')[0])); s.on('error', rej);
  });
}

test('sidecar: cross-site requests refused, ttyd gets its own login, frames and logins limited', async (t) => {
  const port = await freePort(), ttydPort = await freePort();
  const ttyd = await fakeTtyd(ttydPort);
  t.after(() => ttyd.srv.close());
  const cats = path.join(tmp, 'cats.json');
  const auth = 'Basic ' + Buffer.from('claude:pw').toString('base64');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'web-sidecar.js')], {
    env: Object.assign({}, process.env, {
      HOME: tmp, WEB_TERMINAL_PORT: String(port), WEB_TERMINAL_INTERFACE: '127.0.0.1', WEB_TERMINAL_PASSWORD: 'pw',
      TTYD_PORT: String(ttydPort), CB_TTYD_AUTH: 'cb:internal-secret', CB_API_TOKEN: 'apitok',
      WEB_TLS_CERT: '', WEB_TLS_KEY: '', WEB_CATEGORIES: cats, WEB_CHAT_MODULE: '/nonexistent',
      WEB_TASKS_MODULE: '/nonexistent', WEB_PANEL_MODULE: '/nonexistent', WEB_WORKSPACE_MODULE: '/nonexistent',
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(() => child.kill());
  // wait for the listener, but fail (not hang) if the sidecar dies or never comes up
  await new Promise((res, rej) => {
    let err = '';
    const timer = setTimeout(() => rej(new Error('sidecar did not start in 10s: ' + err)), 10000);
    child.stderr.on('data', (d) => { err += d; if (/sidecar http/.test(d)) { clearTimeout(timer); res(); } });
    child.on('exit', (c) => { clearTimeout(timer); rej(new Error('sidecar exited (' + c + '): ' + err)); });
  });
  const host = '127.0.0.1:' + port;
  const body = JSON.stringify({ cats: [{ id: 'a', name: 'A' }], map: {}, quiet: { tok1: 1 } });

  // the classic CSRF shape: a text/plain form POST from another site, with the cached login
  const evil = await call(port, 'POST', '/categories',
    { host, authorization: auth, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, body);
  assert.strictEqual(evil.status, 403);
  assert.ok(!fs.existsSync(cats), 'a refused request must not write anything');

  const same = await call(port, 'POST', '/categories',
    { host, authorization: auth, origin: 'http://' + host, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body);
  assert.strictEqual(same.status, 200);
  assert.ok(fs.existsSync(cats));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cats, 'utf8')).quiet, { tok1: 1 }, '"Hide from Active" marks are kept');
  const back = await call(port, 'GET', '/categories', { host, authorization: auth });
  assert.deepStrictEqual(JSON.parse(back.body).quiet, { tok1: 1 }, '"Hide from Active" marks come back after a reload');

  const cli = await call(port, 'POST', '/chat/api/new', { host, authorization: auth, 'content-type': 'application/json' }, '{"prompt":"x"}');
  assert.notStrictEqual(cli.status, 403, 'non-browser clients are not blocked');
  const tok = await call(port, 'POST', '/chat/api/new', { host, 'x-cb-api-token': 'apitok' }, '{"prompt":"x"}');
  assert.strictEqual(tok.status, 503, 'cb-session with the API token gets past the login (chat is disabled here)');
  const tokUi = await call(port, 'GET', '/sessions', { host, 'x-cb-api-token': 'apitok' });
  assert.strictEqual(tokUi.status, 401, 'the API token is not a key to the whole UI');

  const evilApi = await call(port, 'POST', '/chat/api/new', { host, authorization: auth, origin: 'https://evil.example' }, '{"prompt":"x"}');
  assert.strictEqual(evilApi.status, 403);

  const ws = { host, authorization: auth, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' };
  assert.match(await upgrade(port, Object.assign({ origin: 'https://evil.example' }, ws)), / 403 /);
  assert.match(await upgrade(port, Object.assign({ origin: 'http://' + host }, ws)), / 503 /);   // chat disabled here

  // the terminal: the user's login goes no further than the sidecar, ttyd sees only its own
  const term = await call(port, 'GET', '/term/', { host, authorization: auth });
  assert.strictEqual(term.status, 200);
  assert.match(await upgradeTo(port, '/term/ws', Object.assign({ origin: 'http://' + host }, ws)), / 101 /);
  const internal = 'Basic ' + Buffer.from('cb:internal-secret').toString('base64');
  assert.deepStrictEqual(ttyd.seen, [internal, internal]);

  // nothing can be framed by another site — the proxied terminal included
  const frames = await new Promise((res) => http.get({ host: '127.0.0.1', port, path: '/term/', headers: { host, authorization: auth } },
    (r) => { r.resume(); res(r.headers); }));
  assert.strictEqual(frames['x-frame-options'], 'SAMEORIGIN');
  assert.match(frames['content-security-policy'], /frame-ancestors 'self'/);
  const before = ttyd.seen.length;
  const framed = await call(port, 'GET', '/term/?shell=/workspace',
    { host, authorization: auth, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' });
  assert.strictEqual(framed.status, 403, 'the terminal in a hidden frame on another site');
  assert.strictEqual(ttyd.seen.length, before, 'refused requests never reach ttyd');
  assert.ok(ttyd.seen.every((h) => h === internal), 'ttyd never sees the user\'s own login');

  // guessing the password: the 10th wrong try locks that client out, the right one then waits
  const who = { host, 'x-forwarded-for': '203.0.113.9' };
  for (let i = 0; i < 10; i++) assert.strictEqual((await call(port, 'GET', '/sessions', Object.assign({ authorization: 'Basic ' + Buffer.from('claude:g' + i).toString('base64') }, who))).status, 401);
  assert.strictEqual((await call(port, 'GET', '/sessions', Object.assign({ authorization: auth }, who))).status, 429);
  assert.strictEqual((await call(port, 'GET', '/sessions', { host, authorization: auth })).status, 200, 'other clients still get in');
});
