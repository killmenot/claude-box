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
// The virtual screen is as big as a view may get; the VNC picture and the Chromium windows follow the
// size of the Browser tab (resize()), so the tab shows the browser 1:1 with no black bars.
const MAX = (process.env.CB_BROWSER_MAX || '3840x2160').split('x').map(Number);
const view = (() => { const v = (process.env.CB_BROWSER_SIZE || '1440x900').split('x').map(Number); return { w: v[0], h: v[1] }; })();
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
    '--window-position=0,0', '--window-size=' + view.w + ',' + view.h,
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
      run('xvfb', 'Xvfb', [DISPLAY, '-screen', '0', `${MAX[0]}x${MAX[1]}x24`, '-nolisten', 'tcp']);
      for (let i = 0; i < 50 && !fs.existsSync(`/tmp/.X11-unix/X${n}`); i++) await sleep(100);
    }
    if (!procs.chrome && !(await cdpAlive())) startChrome();
    if (!procs.vnc) {
      try { fs.unlinkSync(VNC_SOCK); } catch (_) {}
      run('vnc', 'x11vnc', ['-display', DISPLAY, '-unixsock', VNC_SOCK, '-rfbport', '0', '-forever', '-shared',
        '-nopw', '-quiet', '-noxdamage', '-cursor', 'arrow', '-clip', `${view.w}x${view.h}+0+0`,
        // X autorepeat stays off (x11vnc's default): the viewer turns the Mac's own key repeats into
        // presses, so a held key repeats at the Mac's rate. The clipboard goes over DevTools
        // (clipboardGet/Paste below): this x11vnc does not notice Chromium's copies.
        '-noprimary', '-noclipboard']);
    }
    for (let i = 0; i < 100; i++) {
      if (await sockAlive(VNC_SOCK) && await cdpAlive()) { brandAsChrome().catch((e) => log('brand:', e.message)); return; }
      await sleep(150);
    }
    throw new Error('the browser did not start');
  })().finally(() => { starting = null; });
  return starting;
}

// ---------- "Google Chrome" in the client hints ----------
// The user-agent string is already Chrome's ("Chrome/156 ... Linux x86_64"); what tells Chromium
// apart is the brand list in the client hints (Sec-CH-UA headers, navigator.userAgentData). One
// browser-level DevTools connection catches every new page, frame and worker before it runs and
// gives it Chromium's own list with "Google Chrome" added, like Google's build. Google Chrome itself
// has no Linux build for ARM, so it cannot simply be installed here. CB_BROWSER_BRAND=0 turns it off.
let brander = null, brandMeta = null, bsend = null;
const pageSessions = new Map();     // targetId -> DevTools session of that page (for the clipboard)
function chromeMeta(own, fullList, full) {
  const add = (list, version) => {
    const out = (list && list.length ? list : [{ brand: 'Chromium', version }]).filter((b) => b.brand !== 'Google Chrome');
    const i = out.findIndex((b) => b.brand === 'Chromium');
    out.splice(i < 0 ? 0 : i, 0, { brand: 'Google Chrome', version });
    return out;
  };
  const major = String(full || '').split('.')[0];
  return { brands: add(own, major), fullVersionList: add(fullList, full), fullVersion: full,
    platform: 'Linux', platformVersion: '', architecture: 'x86', bitness: '64', model: '', mobile: false, wow64: false };
}
async function brandAsChrome() {
  if (brander || process.env.CB_BROWSER_BRAND === '0' || typeof WebSocket !== 'function') return;
  const v = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
  const ua = v['User-Agent'];
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  brander = ws;
  let id = 0; const pend = new Map();
  const send = (method, params, sessionId) => new Promise((res) => {
    const i = ++id; pend.set(i, res);
    try { ws.send(JSON.stringify(Object.assign({ id: i, method, params: params || {} }, sessionId ? { sessionId } : {}))); } catch (_) { res({}); }
  });
  bsend = send;
  const attach = (sessionId) => send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
  ws.onmessage = async (m) => {
    let o; try { o = JSON.parse(m.data); } catch (_) { return; }
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o.result || {}); pend.delete(o.id); return; }
    if (o.method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo } = o.params;
    if (targetInfo.type === 'page') pageSessions.set(targetInfo.targetId, sessionId);
    if (brandMeta) await send('Network.setUserAgentOverride', { userAgent: ua, userAgentMetadata: brandMeta }, sessionId);
    if (/^(page|iframe)$/.test(targetInfo.type)) await attach(sessionId);       // its frames and workers too
    if (targetInfo.type === 'page') fitWindow(targetInfo.targetId);                // a new window takes the tab's size
    send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  };
  ws.onclose = () => {
    if (brander === ws) { brander = null; bsend = null; }
    if (!stopping) setTimeout(() => { if (procs.chrome) brandAsChrome().catch(() => {}); }, 2000);
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools connection failed')); });
  // Chromium's own brand list (with its GREASE entry), read once from a scratch page
  if (!brandMeta) {
    const t = await send('Target.createTarget', { url: 'chrome://version/', background: true });   // a secure context: about:blank has no userAgentData
    const s = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    // the scratch page starts as an empty document: ask until chrome://version itself answers
    let own = {};
    for (let i = 0; i < 15 && !own.brands; i++) {
      const r = await send('Runtime.evaluate', { expression: 'navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(["fullVersionList","uaFullVersion"]).then(h=>JSON.stringify({brands:navigator.userAgentData.brands,full:h.fullVersionList,v:h.uaFullVersion})) : "{}"', awaitPromise: true, returnByValue: true }, s.sessionId);
      try { own = JSON.parse(r.result.value) || {}; } catch (_) { own = {}; }
      if (!own.brands) await sleep(200);
    }
    await send('Target.closeTarget', { targetId: t.targetId });
    if (!own.brands) log('brand: could not read Chromium\'s own brand list; using Google Chrome and Chromium only');
    brandMeta = chromeMeta(own.brands, own.full, own.v || ((/Chrome\/([\d.]+)/.exec(v.Browser) || [])[1] || ''));
  }
  await attach();                                                                 // pages open now and every new one
}

// ---------- the Browser tab's size ----------
async function fitWindow(targetId) {
  if (!bsend) return;
  const w = await bsend('Browser.getWindowForTarget', targetId ? { targetId } : {});
  if (w && w.windowId) await bsend('Browser.setWindowBounds', { windowId: w.windowId, bounds: { left: 0, top: 0, width: view.w, height: view.h, windowState: 'normal' } });
}
let fitting = Promise.resolve();
function resize(w, h) {
  w = Math.max(640, Math.min(MAX[0], Math.round(Number(w) || 0))); h = Math.max(400, Math.min(MAX[1], Math.round(Number(h) || 0)));
  w -= w % 2; h -= h % 2;
  if (w === view.w && h === view.h) return Promise.resolve(Object.assign({ changed: false }, view));
  view.w = w; view.h = h;
  // one at a time: a drag of the window sends many sizes; the last one wins
  fitting = fitting.then(async () => {
    if (view.w !== w || view.h !== h) return;
    if (procs.vnc) await new Promise((res) => {
      const p = spawn('x11vnc', ['-display', DISPLAY, '-sync', '-remote', `clip:${w}x${h}+0+0`], { stdio: 'ignore' });
      p.on('exit', res); p.on('error', res);
    });
    if (bsend) {
      const t = await bsend('Target.getTargets', {});
      for (const x of (t.targetInfos || []).filter((i) => i.type === 'page')) await fitWindow(x.targetId);
    }
  }).catch((e) => log('resize:', e.message));
  return fitting.then(() => Object.assign({ changed: true }, view));
}

// ---------- the clipboard, over DevTools ----------
// The page the user is in: the one whose document has focus (else the first visible one).
async function activeSession() {
  if (!bsend) throw new Error('the browser is not connected');
  const t = await bsend('Target.getTargets', {});
  const live = new Set((t.targetInfos || []).filter((i) => i.type === 'page').map((i) => i.targetId));
  for (const id of [...pageSessions.keys()]) if (!live.has(id)) pageSessions.delete(id);
  let visible = null;
  for (const [, sid] of pageSessions) {
    const r = await bsend('Runtime.evaluate', { expression: '[document.hasFocus(), document.visibilityState]', returnByValue: true }, sid);
    const v = r && r.result && r.result.value;
    if (v && v[0]) return sid;
    if (!visible && v && v[1] === 'visible') visible = sid;
  }
  if (!visible) throw new Error('no page is open');
  return visible;
}
// what the user just copied in the box (Ctrl+C there) -> the viewer puts it on the Mac's clipboard
async function clipboardGet() {
  const sid = await activeSession();
  await bsend('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  const r = await bsend('Runtime.evaluate', { expression: 'navigator.clipboard.readText()', awaitPromise: true, returnByValue: true, userGesture: true }, sid);
  const text = r && r.result && typeof r.result.value === 'string' ? r.result.value : '';
  return { text: text.slice(0, 1 << 20) };
}
// the Mac's clipboard -> typed into the focused field of the page in the box
async function clipboardPaste(text) {
  text = String(text || '').slice(0, 1 << 20);
  if (!text) return { ok: false };
  const sid = await activeSession();
  await bsend('Input.insertText', { text }, sid);
  return { ok: true };
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

module.exports = { enabled, ensure, status, serve, upgrade, stop, resize, clipboardGet, clipboardPaste, _bridge, chromeMeta, CDP_PORT, VNC_SOCK, PROFILE };
