'use strict';
// The built-in browser for the session's Browser tab: one Chromium for the whole box, only when the
// box was started with `./claude-box --browser` (the image then carries Chromium, Xvfb, x11vnc and
// noVNC, and WEB_BROWSER=1). The user works in it through the tab; Claude drives the same browser
// through the playwright MCP server (see web-serve.js).
//
// Windows: one Chromium (one profile, so the logins are shared), but every session has a window of its
// own, and Slack lives in one "shared" window for all of them. The Browser tab shows the window of the
// session it is in (the others wait off the screen), or the shared one. Claude's playwright tools in a
// session connect to 127.0.0.1:<CB_BROWSER_SESSION_PORT>/s/<session> and see only that session's
// tabs (web-cdp-filter.js), not Chromium's own DevTools port.
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
const SESSION_PORT = parseInt(process.env.CB_BROWSER_SESSION_PORT || '9334', 10);
// The virtual screen is as big as a view may get; the VNC picture and the Chromium windows follow the
// size of the Browser tab (resize()), so the tab shows the browser 1:1 with no black bars. The cap
// is generous (8K): a tall portrait window on a big monitor wants more height than 4K. Only the
// clipped region streams, so the screen size costs nothing but its framebuffer (~130 MB at 8K).
const MAX = (process.env.CB_BROWSER_MAX || '7680x4320').split('x').map(Number);
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
      if (await sockAlive(VNC_SOCK) && await cdpAlive()) { brandAsChrome().catch((e) => log('brand:', e.message)); listenSessions(); return; }
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
  // a call that gets no answer (a page that went away, one still paused) gives up after 10 s
  const send = (method, params, sessionId) => new Promise((res) => {
    const i = ++id; pend.set(i, res);
    setTimeout(() => { if (pend.delete(i)) { log('no answer:', method); res({}); } }, 10000);
    try { ws.send(JSON.stringify(Object.assign({ id: i, method, params: params || {} }, sessionId ? { sessionId } : {}))); } catch (_) { res({}); }
  });
  bsend = send;
  const attach = (sessionId) => send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
  ws.onmessage = async (m) => {
    let o; try { o = JSON.parse(m.data); } catch (_) { return; }
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o.result || {}); pend.delete(o.id); return; }
    if (o.method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo } = o.params;
    // a new tab or popup a page opened arrives twice: here under its opener and at the top level.
    // Both copies hold it paused, so this copy only lets go; the top-level one does the work.
    if (o.sessionId && targetInfo.type === 'page') {
      send('Runtime.runIfWaitingForDebugger', {}, sessionId); send('Target.detachFromTarget', { sessionId }, o.sessionId);
      return;
    }
    if (targetInfo.type === 'page') pageSessions.set(targetInfo.targetId, sessionId);
    // sent in order without waiting for the answers: the target runs them before it resumes, and a tab
    // window.open() made answers only once it runs (waiting here would hold it, and its opener, 10 s)
    if (brandMeta) send('Network.setUserAgentOverride', { userAgent: ua, userAgentMetadata: brandMeta }, sessionId);
    if (/^(page|iframe)$/.test(targetInfo.type)) attach(sessionId);              // its frames and workers too
    await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    if (targetInfo.type === 'page') fitWindow(targetInfo.targetId);                // a new window takes the tab's size
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

// ---------- windows: one per session, one shared ----------
// owner: windowId -> key (a session's token, or "shared"); main: key -> its first window. A window is
// on the screen when its owner is the key the Browser tab shows; the others wait to the right of the
// screen (x11vnc shows only the top-left corner), so no window manager is needed to raise one.
const owner = new Map(), main = new Map();
let shown = '';
const OFF = () => MAX[0] + 400;
const SHARED = 'shared';
async function winOf(targetId) { const r = await bsend('Browser.getWindowForTarget', { targetId }); return (r && r.windowId) || null; }
async function pagesNow() { const t = await bsend('Target.getTargets', {}); return (t.targetInfos || []).filter((i) => i.type === 'page'); }
// windowId -> its pages, for the windows open now (the closed ones leave the maps)
async function windowsNow() {
  const all = new Map();
  for (const p of await pagesNow()) { const w = await winOf(p.targetId); if (!w) continue; if (!all.has(w)) all.set(w, []); all.get(w).push(p); }
  for (const w of [...owner.keys()]) if (!all.has(w)) owner.delete(w);
  for (const [k, w] of [...main]) if (!all.has(w)) main.delete(k);
  return all;
}
async function placeWindow(windowId) {
  const k = owner.get(windowId), on = !shown || !k || k === shown;
  await bsend('Browser.setWindowBounds', { windowId, bounds: { left: on ? 0 : OFF(), top: 0, width: view.w, height: view.h, windowState: 'normal' } });
}
// the key's window; with create, a new one if it has none
async function windowFor(key, create) {
  const all = await windowsNow();
  let w = main.get(key);
  if (w && all.has(w)) return w;
  w = [...all.keys()].find((x) => owner.get(x) === key);
  // the window Chromium starts with (or any nobody owns) becomes the shared one
  if (!w && key === SHARED) w = [...all.keys()].find((x) => !owner.has(x));
  if (w) { main.set(key, w); owner.set(w, key); return w; }
  if (!create) return null;
  const n = await bsend('Target.createTarget', { url: 'about:blank', newWindow: true });
  w = n && n.targetId ? await winOf(n.targetId) : null;
  if (!w) throw new Error('could not open a browser window');
  main.set(key, w); owner.set(w, key); await placeWindow(w);
  return w;
}
const BLANK = /^(about:blank|chrome:\/\/(new-tab-page|newtab)\/?)$/;
// a new tab in the key's window: window.open from one of its pages (Chromium opens it in that same
// window; DevTools cannot name a window for a new tab), else a window of its own
async function newTab(key, url, reuseBlank) {
  const w = await windowFor(key, true);
  const mine = (await windowsNow()).get(w) || [];
  if (reuseBlank) {
    const b = mine.find((p) => BLANK.test(p.url) && pageSessions.has(p.targetId));
    if (b) { await bsend('Page.navigate', { url }, pageSessions.get(b.targetId)); return b.targetId; }
  }
  const from = mine.find((p) => pageSessions.has(p.targetId));
  if (from) {
    const before = new Set((await pagesNow()).map((p) => p.targetId));
    await bsend('Runtime.evaluate', { expression: 'void window.open(' + JSON.stringify(url) + ', "_blank", "noopener")', userGesture: true }, pageSessions.get(from.targetId));
    for (let i = 0; i < 30; i++) {
      const n = (await pagesNow()).find((p) => !before.has(p.targetId));
      if (n) { const nw = await winOf(n.targetId); if (nw && !owner.has(nw)) owner.set(nw, key); return n.targetId; }
      await sleep(100);
    }
  }
  const n = await bsend('Target.createTarget', { url, newWindow: true });
  if (!n || !n.targetId) throw new Error('could not open a tab');
  const nw = await winOf(n.targetId); if (nw) { owner.set(nw, key); await placeWindow(nw); }
  return n.targetId;
}
async function connected() {
  await ensure();
  for (let i = 0; i < 50 && !bsend; i++) await sleep(100);
  if (!bsend) throw new Error('the browser is not connected');
}
const KEY = /^[\w.:-]{1,100}$/;
// the Browser tab shows this key's windows (made if it has none) and the tab the user was on there
async function focus(key) {
  if (!KEY.test(String(key || ''))) throw new Error('bad window');
  await connected();
  const w = await windowFor(key, true);
  shown = key;
  const all = await windowsNow();
  for (const x of all.keys()) if (!owner.has(x)) { owner.set(x, SHARED); if (!main.has(SHARED)) main.set(SHARED, x); }
  for (const x of all.keys()) await placeWindow(x);
  const pages = all.get(w) || [];
  let front = null;
  for (const p of pages) {
    const sid = pageSessions.get(p.targetId); if (!sid) continue;
    const r = await bsend('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, sid);
    if (r && r.result && r.result.value === 'visible') { front = p; break; }
  }
  front = front || pages[0];
  if (front) await bsend('Target.activateTarget', { targetId: front.targetId });
  return { key, tabs: pages.length };
}
// a session is archived or deleted: its windows close
async function closeWindows(key) {
  if (!bsend || !key || key === SHARED) return;
  const all = await windowsNow();
  for (const [w, pages] of all) if (owner.get(w) === key) for (const p of pages) await bsend('Target.closeTarget', { targetId: p.targetId });
  main.delete(key); if (shown === key) shown = '';
}

// ---------- the Browser tab's size ----------
async function fitWindow(targetId) {
  if (!bsend) return;
  const w = targetId ? await winOf(targetId) : null;
  if (!w) return;
  // a window that appears on its own (a popup, a window the user opened) belongs to what is on the screen
  if (!owner.has(w) && shown) owner.set(w, shown);
  await placeWindow(w);
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

// ---------- Slack: permalinks straight into the web app ----------
// A permalink (https://<ws>.slack.com/archives/C…/p…) first shows "Launching <workspace>…", which tries
// the desktop app; the web app's own address skips that, but needs the workspace's team id (T…),
// which no permalink carries. It is learned from any open app.slack.com/client/T… page; until then
// the permalink opens and its "open this link in your browser" is clicked for the user.
let slackTeam = '';
function slackLearn(pages) {
  for (const p of pages) { const m = /^https:\/\/app\.slack\.com\/client\/(T[A-Z0-9]+)/.exec(p.url); if (m) { slackTeam = m[1]; return; } }
}
// https://<ws>.slack.com/archives/C…/p1795610923135229[?thread_ts=…] -> app.slack.com/client/T…/C…/thread/C…-1795610923.135229
function slackWebUrl(href, team) {
  let u; try { u = new URL(href); } catch (_) { return null; }
  if (!team || !/\.slack\.com$/.test(u.hostname) || u.hostname === 'app.slack.com') return null;
  const m = /^\/archives\/([A-Z0-9]+)(?:\/p(\d{16}))?/.exec(u.pathname);
  if (!m) return null;
  const ch = m[1], thr = u.searchParams.get('thread_ts') || (m[2] ? m[2].slice(0, 10) + '.' + m[2].slice(10) : '');
  return `https://app.slack.com/client/${team}/${ch}` + (/^\d+\.\d+$/.test(thr) ? `/thread/${ch}-${thr}` : '');
}
// no team id yet: wait for the "Launching…" page and press its open-in-browser link
async function slackPastRedirect(targetId) {
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const t = await bsend('Target.getTargets', {});
    const page = (t.targetInfos || []).find((x) => x.targetId === targetId);
    if (!page) return;
    if (/^https:\/\/app\.slack\.com\//.test(page.url)) { slackLearn([page]); return; }
    const sid = pageSessions.get(targetId);
    if (!sid) continue;
    const r = await bsend('Runtime.evaluate', { returnByValue: true, expression:
      '(()=>{const a=[...document.querySelectorAll("a[href]")].find((x)=>/app\\.slack\\.com\\/client|\\/messages\\//.test(x.href)||/open this link in your browser/i.test(x.textContent));if(!a)return "";a.click();return a.href;})()' }, sid);
    if (r && r.result && r.result.value) { await sleep(1500); }
  }
}

// ---------- open a link from claude-box (the context strip, links in the chat) ----------
// In the session's window: a PR or Jira issue already open there comes to the front, anything else
// opens in a new tab. Slack goes to the shared window and keeps one tab there, moved to the thread
// (its web app is heavy). Only https links. Returns the key whose window now shows.
async function openUrl(url, session) {
  let u; try { u = new URL(String(url || '')); } catch (_) { throw new Error('not a link'); }
  if (u.protocol !== 'https:') throw new Error('only https links');
  await connected();
  const href = u.href;
  const pr = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.exec(href);
  const jira = /\/browse\/([A-Z][A-Z0-9]+-\d+)/.exec(u.pathname);
  const slack = /\.slack\.com$/.test(u.hostname);
  const key = slack ? SHARED : (KEY.test(String(session || '')) ? String(session) : SHARED);
  slackLearn(await pagesNow());
  await windowFor(key, true);
  const all = await windowsNow();
  const pages = [];
  for (const [w, ps] of all) if (owner.get(w) === key) pages.push(...ps);
  const web = slack ? slackWebUrl(href, slackTeam) : null;
  const go = web || href;
  let hit = null;
  if (pr) hit = pages.find((p) => p.url.startsWith(pr[0]) && /^(\/|$|#|\?)/.test(p.url.slice(pr[0].length)));
  else if (jira) hit = pages.find((p) => p.url.includes('/browse/' + jira[1]));
  else if (slack) hit = pages.find((p) => /^https:\/\/(app\.slack\.com|[\w-]+\.slack\.com)\//.test(p.url));
  else hit = pages.find((p) => p.url === href);
  if (hit && slack && !hit.url.startsWith(go)) {
    const sid = pageSessions.get(hit.targetId);
    if (sid) await bsend('Page.navigate', { url: go }, sid);
  }
  const id = hit ? hit.targetId : await newTab(key, go, true);
  await focus(key);
  if (id) await bsend('Target.activateTarget', { targetId: id });
  if (slack && !web && id) slackPastRedirect(id).catch(() => {});
  return { ok: !!id, reused: !!hit, url: go, key };
}

// ---------- Claude's view: 127.0.0.1:SESSION_PORT/s/<session> ----------
// GET /s/<key>/json/version names the WebSocket; WS /s/<key> is DevTools filtered to <key>'s windows.
// resolveKey maps what a session calls itself (its token, or the chat's / tmux session's name) to the
// key its Browser tab uses; set by the server (the registry knows both).
let resolveKey = (k) => k, sessionServer = null;
function setKeyResolver(fn) { resolveKey = fn; }
function wsLib() {
  try { return require(path.join(process.env.WEB_CHAT_MODULES || '/opt/claude-web-chat/node_modules', 'ws')); }
  catch (_) { try { return require('ws'); } catch (__) { return null; } }
}
function listenSessions() {
  if (sessionServer) return;
  const lib = wsLib();
  if (!lib) { log('session view: no ws module'); return; }
  const http = require('http');
  const { Filter } = require('./web-cdp-filter.js');
  const wssS = new lib.WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 << 20 });
  const keyOf = (url) => { const m = /^\/s\/([\w.:-]{1,100})(\/|$)/.exec(String(url || '').split('?')[0]); return m ? m[1] : null; };
  sessionServer = http.createServer(async (req, res) => {
    const raw = keyOf(req.url);
    if (!raw || !/\/json\/version\/?$/.test(req.url.split('?')[0])) { res.writeHead(404); res.end(); return; }
    try {
      const v = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      v.webSocketDebuggerUrl = `ws://127.0.0.1:${SESSION_PORT}/s/${raw}`;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v));
    } catch (e) { res.writeHead(503); res.end(); }
  });
  sessionServer.on('upgrade', (req, socket, head) => {
    const raw = keyOf(req.url);
    if (!raw) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    connected().then(async () => {
      const key = String(resolveKey(raw) || raw);
      const v = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      const up = new lib.WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 << 20 });
      await new Promise((ok, no) => { up.once('open', ok); up.once('error', no); });
      wssS.handleUpgrade(req, socket, head, (ws) => {
        const send = (s, o) => { if (s.readyState === 1) s.send(JSON.stringify(o)); };
        const f = new Filter({
          inScope: async (targetId) => { const w = await winOf(targetId); return !!w && owner.get(w) === key; },
          claim: async (targetId) => { const w = await winOf(targetId); if (w && !owner.has(w)) owner.set(w, key); },
          createTab: (url) => newTab(key, url, false),
          toClient: (o) => send(ws, o), toBrowser: (o) => send(up, o),
        });
        ws.on('message', (m) => { let o; try { o = JSON.parse(String(m)); } catch (_) { return; } f.fromClient(o); });
        up.on('message', (m) => { let o; try { o = JSON.parse(String(m)); } catch (_) { return; } f.fromBrowser(o); });
        const end = () => { try { up.close(); } catch (_) {} try { ws.close(); } catch (_) {} };
        ws.on('close', end); up.on('close', end); ws.on('error', end); up.on('error', end);
      });
    }).catch((e) => { log('session view:', e.message); socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); });
  });
  sessionServer.on('error', (e) => { log('session view:', e.message); sessionServer = null; });
  sessionServer.listen(SESSION_PORT, '127.0.0.1');
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
  if (sessionServer) { try { sessionServer.close(); } catch (_) {} sessionServer = null; }
  for (const k of ['vnc', 'chrome', 'xvfb']) { const p = procs[k]; if (p) try { p.kill('SIGTERM'); } catch (_) {} }
}

module.exports = { enabled, ensure, status, serve, upgrade, stop, resize, clipboardGet, clipboardPaste, openUrl, focus, closeWindows, setKeyResolver, slackWebUrl, _bridge, chromeMeta, CDP_PORT, SESSION_PORT, VNC_SOCK, PROFILE };
