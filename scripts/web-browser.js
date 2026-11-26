'use strict';
// The built-in browser for the session's Browser tab: one Chromium for the whole box, only when the
// box was started with `./claude-box --browser` (the image then carries Chromium, Xvfb, x11vnc and
// noVNC, and WEB_BROWSER=1). The user works in it through the tab; Claude drives the same browser
// through the playwright MCP server, which connects to its DevTools port (see web-serve.js).
//
//   Xvfb :DISPLAY (no TCP) -> Chromium (profile in ~/.config/claude-box-browser, sandboxed: the
//   compose overlay's seccomp profile allows its namespaces) -> x11vnc on a unix socket in a
//   private dir (no port) -> /browser/websockify, bridged here behind the claude-box login.
//
//   GET /browser/...            the viewer page (html/browser.html) and noVNC's modules (/opt/novnc)
//   WS  /browser/websockify     the VNC stream
//   GET /browser/status         {enabled, running, cdp}
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const HOME = process.env.HOME || '/home/node';
const BIN = process.env.CB_CHROMIUM || '/usr/bin/chromium';
const NOVNC = process.env.CB_NOVNC_DIR || '/opt/novnc';
const VIEWER = process.env.CB_BROWSER_PAGE || '/usr/local/share/claude-web/browser.html';
const DISPLAY = process.env.CB_BROWSER_DISPLAY || ':77';
const CDP_PORT = parseInt(process.env.CB_BROWSER_CDP_PORT || '9333', 10);
const SIZE = (process.env.CB_BROWSER_SIZE || '1440x900').split('x').map(Number);
const PROFILE = path.join(HOME, '.config', 'claude-box-browser');
const DIR = process.env.CB_BROWSER_DIR || path.join(os.tmpdir(), `claude-box-browser-${process.getuid ? process.getuid() : 'u'}`);
const VNC_SOCK = path.join(DIR, 'vnc.sock');
const log = (...a) => console.error('browser:', ...a);

const procs = { xvfb: null, chrome: null, vnc: null };
let starting = null, stopping = false, chromeRestarts = [];

function enabled() { return process.env.WEB_BROWSER === '1' && fs.existsSync(BIN); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sockAlive(p) {
  return new Promise((res) => { const s = net.connect(p); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); });
}
function cdpAlive() {
  return new Promise((res) => {
    const s = net.connect(CDP_PORT, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false));
  });
}
function run(name, cmd, args, env) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env: Object.assign({}, process.env, env || {}) });
  p.stderr.on('data', (d) => { const t = String(d).trim(); if (/fatal|error/i.test(t) && !/dbus|gcm|vaapi|libva|ALSA/i.test(t)) log(name + ':', t.slice(0, 300)); });
  p.on('exit', (c, sig) => {
    if (procs[name] === p) procs[name] = null;
    if (stopping) return;
    log(name, 'exited', c != null ? c : sig);
    // the user closed the last window or it crashed: bring the browser back (not in a loop)
    if (name === 'chrome') {
      const now = Date.now(); chromeRestarts = chromeRestarts.filter((t) => now - t < 60000).concat(now);
      if (chromeRestarts.length <= 3) setTimeout(() => { if (!procs.chrome && procs.xvfb) startChrome(); }, 1000);
    }
  });
  p.on('error', (e) => log(name, e.message));
  procs[name] = p;
  return p;
}
function startChrome() {
  fs.mkdirSync(PROFILE, { recursive: true });
  // a crash leaves a lock behind that would stop the next start
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) { try { fs.unlinkSync(path.join(PROFILE, f)); } catch (_) {} }
  return run('chrome', BIN, ['--user-data-dir=' + PROFILE, '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--disable-gpu', '--password-store=basic', '--disable-features=Translate',
    '--window-position=0,0', '--window-size=' + SIZE.join(','), '--start-maximized',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + CDP_PORT, 'about:blank'],
  { DISPLAY, HOME });
}

// everything up once; resolves when the VNC socket answers and the DevTools port is open
function ensure() {
  if (!enabled()) return Promise.reject(new Error('The browser is off: start claude-box with --browser'));
  if (starting) return starting;
  starting = (async () => {
    stopping = false;
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.chmodSync(DIR, 0o700);
    const n = DISPLAY.replace(':', '');
    if (!procs.xvfb) {
      try { fs.unlinkSync(`/tmp/.X${n}-lock`); } catch (_) {}
      run('xvfb', 'Xvfb', [DISPLAY, '-screen', '0', `${SIZE[0]}x${SIZE[1]}x24`, '-nolisten', 'tcp']);
      for (let i = 0; i < 50 && !fs.existsSync(`/tmp/.X11-unix/X${n}`); i++) await sleep(100);
    }
    if (!procs.chrome && !(await cdpAlive())) startChrome();
    if (!procs.vnc) {
      try { fs.unlinkSync(VNC_SOCK); } catch (_) {}
      run('vnc', 'x11vnc', ['-display', DISPLAY, '-unixsock', VNC_SOCK, '-rfbport', '0', '-forever', '-shared',
        '-nopw', '-quiet', '-noxdamage', '-cursor', 'arrow']);
    }
    for (let i = 0; i < 100; i++) {
      if (await sockAlive(VNC_SOCK) && await cdpAlive()) return;
      await sleep(150);
    }
    throw new Error('the browser did not start');
  })().finally(() => { starting = null; });
  return starting;
}

async function status() {
  return { enabled: enabled(), running: enabled() && await cdpAlive() && await sockAlive(VNC_SOCK), cdp: `http://127.0.0.1:${CDP_PORT}` };
}

// GET /browser/<file>: the viewer page, or one of noVNC's files (no paths outside its folder)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
function serve(req, res, rel) {
  let p; try { p = decodeURIComponent(String(rel || '').split('?')[0]); } catch (_) { p = ''; }
  let file;
  if (p === '' || p === '/') file = VIEWER;
  else {
    const abs = path.resolve(NOVNC, '.' + path.posix.normalize('/' + p));
    if (!abs.startsWith(NOVNC + path.sep)) { res.writeHead(403); res.end(); return; }
    file = abs;
  }
  const type = TYPES[path.extname(file).toLowerCase()];
  fs.stat(file, (e, st) => {
    if (e || !st.isFile() || !type) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': type, 'cache-control': file === VIEWER ? 'no-store' : 'max-age=3600' });
    fs.createReadStream(file).pipe(res);
  });
}

// WS /browser/websockify: binary frames <-> the VNC unix socket (what websockify does, in-process)
let wss = null, WebSocketServer;
function upgrade(req, socket, head) {
  if (WebSocketServer === undefined) {
    try { WebSocketServer = require(path.join(process.env.WEB_CHAT_MODULES || '/opt/claude-web-chat/node_modules', 'ws')).WebSocketServer; }
    catch (_) { try { WebSocketServer = require('ws').WebSocketServer; } catch (__) { WebSocketServer = null; } }
  }
  if (!WebSocketServer) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
  ensure().then(() => bridge(req, socket, head),
    (e) => { log(e.message); socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); });
}
function bridge(req, socket, head) {
  if (!wss) wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, handleProtocols: (ps) => (ps.has('binary') ? 'binary' : false) });
  wss.handleUpgrade(req, socket, head, (ws) => {
    const vnc = net.connect(VNC_SOCK);
    vnc.setNoDelay(true);
    vnc.on('data', (d) => { if (ws.readyState === 1) ws.send(d, { binary: true }); });
    ws.on('message', (m) => { vnc.write(Buffer.isBuffer(m) ? m : Buffer.from(m)); });
    const end = () => { try { vnc.destroy(); } catch (_) {} try { ws.close(); } catch (_) {} };
    vnc.on('error', end); vnc.on('close', end); ws.on('close', end); ws.on('error', end);
  });
}
// for tests: the bridge on its own, without starting the browser
function _bridge(req, socket, head, WSS) { WebSocketServer = WSS; bridge(req, socket, head); }

function stop() {
  stopping = true;
  for (const k of ['vnc', 'chrome', 'xvfb']) { const p = procs[k]; if (p) try { p.kill('SIGTERM'); } catch (_) {} }
}

module.exports = { enabled, ensure, status, serve, upgrade, stop, _bridge, CDP_PORT, VNC_SOCK, PROFILE };
