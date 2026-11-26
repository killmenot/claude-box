'use strict';
// web-browser.js: the Browser tab's server side. The viewer page and noVNC's files are served
// without paths outside noVNC's folder; the WebSocket bridge relays bytes both ways between the
// browser tab and the VNC unix socket (a stand-in VNC server here, no Chromium needed).
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-br-')));
const novnc = path.join(tmp, 'novnc'), page = path.join(tmp, 'browser.html'), dir = path.join(tmp, 'run');
fs.mkdirSync(path.join(novnc, 'core'), { recursive: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(novnc, 'core', 'rfb.js'), 'export default 1;');
fs.writeFileSync(page, '<!doctype html><title>Browser</title>');
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'no');
Object.assign(process.env, { CB_NOVNC_DIR: novnc, CB_BROWSER_PAGE: page, CB_BROWSER_DIR: dir, CB_CHROMIUM: path.join(tmp, 'no-chromium') });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const b = require('../scripts/web-browser.js');
let WSS = null;
for (const m of [process.env.WEB_CHAT_MODULES || '/opt/claude-web-chat/node_modules', 'ws']) {
  try { WSS = require(m === 'ws' ? 'ws' : path.join(m, 'ws')).WebSocketServer; break; } catch (_) {}
}

test('off unless the box was started with --browser (and Chromium is there)', () => {
  delete process.env.WEB_BROWSER;
  assert.strictEqual(b.enabled(), false);
  process.env.WEB_BROWSER = '1';
  assert.strictEqual(b.enabled(), false, 'no Chromium binary');
});

test('the viewer page and noVNC files are served; nothing outside noVNC', async () => {
  const srv = http.createServer((req, res) => b.serve(req, res, req.url));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const get = (p) => new Promise((res) => http.get({ host: '127.0.0.1', port: srv.address().port, path: p }, (r) => {
    let s = ''; r.on('data', (d) => { s += d; }); r.on('end', () => res({ status: r.statusCode, type: r.headers['content-type'], body: s }));
  }));
  try {
    const v = await get('/');
    assert.strictEqual(v.status, 200); assert.match(v.body, /<title>Browser/);
    const j = await get('/core/rfb.js');
    assert.strictEqual(j.status, 200); assert.match(j.type, /javascript/);
    assert.strictEqual((await get('/../secret.txt')).status, 404);
    assert.strictEqual((await get('/..%2fsecret.txt')).status, 404);
    assert.strictEqual((await get('/core/missing.js')).status, 404);
  } finally { srv.close(); }
});

test('the WebSocket bridge relays bytes to and from the VNC socket', { skip: !WSS && 'ws is not installed here (it is in the image)' }, async () => {
  const sock = b.VNC_SOCK;
  const got = [];
  const vnc = net.createServer((c) => { c.write('RFB 003.008\n'); c.on('data', (d) => { got.push(String(d)); c.write('echo:' + d); }); });
  await new Promise((r) => vnc.listen(sock, r));
  const srv = http.createServer();
  srv.on('upgrade', (req, s, h) => b._bridge(req, s, h, WSS));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const msgs = await new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + srv.address().port + '/browser/websockify', ['binary']);
      ws.binaryType = 'arraybuffer'; const out = [];
      ws.onmessage = (e) => { out.push(Buffer.from(e.data).toString()); if (out.length === 1) ws.send(Buffer.from('RFB 003.008\n')); else { ws.close(); resolve(out); } };
      ws.onerror = () => reject(new Error('ws error'));
      setTimeout(() => reject(new Error('timeout')), 5000);
    });
    assert.strictEqual(msgs[0], 'RFB 003.008\n');
    assert.strictEqual(msgs[1], 'echo:RFB 003.008\n');
    assert.deepStrictEqual(got, ['RFB 003.008\n']);
  } finally { srv.close(); vnc.close(); }
});
