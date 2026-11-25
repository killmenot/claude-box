#!/usr/bin/env node
'use strict';
// Lightweight HTTP sidecar in front of ttyd. Single origin:
//   /            -> launcher (html/launcher.html)
//   /sessions    -> session registry list (web-registry.js)
//   /metrics     -> host + session metrics (web-metrics.js)
//   /say         -> voice alerts for the browser to speak (Monitoring/notify.sh queue)
//   /preview     -> tmux screenshot of a session (web-preview.js)
//   /search      -> search through session history (web-search.js)
//   /chat/ws     -> web chat over the Claude Agent SDK (web-chat.js), /chat/info, /dirs
//   /categories  -> GET/POST the sidebar categories (~/.claude/web-categories.json)
//   /workspace   -> file manager: GET ls|file|text|image (image: any absolute path, raster only), POST /workspace/{mkdir,rename,copy,move,trash,clone,upload,save} (web-workspace.js)
//   /inbox       -> the coordinator's cards: GET list, POST /inbox/act {token, op: send|seen|later|allow|deny} (web-inbox.js)
//   /tasks       -> task workspaces: GET list, POST /tasks/{open,archive,reopen,refresh,forget,add-repos,repo-add}
//   /auth        -> web login: GET /auth/state, POST /auth/password {user, password, current} (web-auth.js)
//   /git         -> GitHub via gh: GET /git/status, GET /git/repos, POST /git/{login,login/cancel,logout} (web-git.js)
//   /term,/token,/ws -> proxy to the internal ttyd (127.0.0.1:TTYD_PORT)
// Started by web-serve.js (the container entrypoint); `node web-sidecar.js` runs it standalone.
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const registry = require('./web-registry.js');
const { metrics } = require('./web-metrics.js');
const { preview } = require('./web-preview.js');
const { search } = require('./web-search.js');
// CSRF / cross-site WebSocket / DNS-rebinding guard + the login check (see web-guard.js)
const webGuard = require('./web-guard.js');
const guard = webGuard.makeGuard();

const IFACE = process.env.WEB_TERMINAL_INTERFACE || '127.0.0.1';
const PORT  = parseInt(process.env.WEB_TERMINAL_PORT || '7681', 10);
const TLS_PORT = parseInt(process.env.WEB_TLS_PORT || '8443', 10);   // https listener (if a cert is present)
const TTYD  = parseInt(process.env.TTYD_PORT || '7682', 10);
const LAUNCHER = process.env.WEB_LAUNCHER || '/usr/local/share/claude-web/launcher.html';
const PW = process.env.WEB_TERMINAL_PASSWORD || '';
const USER = process.env.WEB_TERMINAL_USER || 'claude';
// the login (set in the UI; the .env password still works) and the browser sessions
const webAuth = require('./web-auth.js');
const authStore = webAuth.makeStore({ dir: process.env.WEB_AUTH_DIR, envUser: USER, envPassword: PW });
const COOKIE = webAuth.cookieName(PORT);
const webGit = require('./web-git.js');

// Web chat module (HTML UI over the Agent SDK). Optional: if it fails to load, the launcher
// falls back to console-only and everything else keeps working.
let chat = null;
try { chat = require(process.env.WEB_CHAT_MODULE || './web-chat.js'); }
catch (e) { console.error('web chat disabled:', e.message); }
// Sidebar categories: user-made groups + session -> category assignments. Stored server-side
// so every device (desktop, phone) sees the same layout. Shape: {cats:[{id,name}], map:{token:id}}.
const CATS_FILE = process.env.WEB_CATEGORIES || require('path').join(process.env.HOME || '/home/node', '.claude', 'web-categories.json');
function readCats() {
  try { const o = JSON.parse(fs.readFileSync(CATS_FILE, 'utf8')); return { cats: o.cats || [], map: o.map || {} }; }
  catch (_) { return { cats: [], map: {} }; }
}
function cleanCats(o) {
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const cats = (Array.isArray(o && o.cats) ? o.cats : []).slice(0, 100)
    .map((c) => ({ id: str(c && c.id, 40), name: str(c && c.name, 80) })).filter((c) => c.id && c.name);
  const ids = new Set(cats.map((c) => c.id)), map = {};
  Object.entries((o && typeof o.map === 'object' && o.map) || {}).slice(0, 5000)
    .forEach(([k, v]) => { if (ids.has(String(v))) map[str(k, 64)] = String(v); });
  return { cats, map };
}
function writeCats(o) {
  const tmp = CATS_FILE + '.' + process.pid + '.tmp';
  fs.mkdirSync(require('path').dirname(CATS_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(o)); fs.renameSync(tmp, CATS_FILE);
}
let workspace = null;
try { workspace = require(process.env.WEB_WORKSPACE_MODULE || './web-workspace.js'); }
catch (e) { console.error('workspace manager disabled:', e.message); }
let tasks = null;
try { tasks = require(process.env.WEB_TASKS_MODULE || './web-tasks.js'); }
catch (e) { console.error('tasks disabled:', e.message); }
let wire = null;      // records what the background agents send to the model and get back (web-wire.js)
try { wire = require(process.env.WEB_WIRE_MODULE || './web-wire.js'); } catch (e) { console.error('wire log disabled:', e.message); }
let panel = null;     // the right-hand "Today" panel (GitHub + an MCP snapshot collected by a cheap agent)
try { panel = require(process.env.WEB_PANEL_MODULE || './web-panel.js'); if (chat && chat.getSdk) panel.init({ getSdk: chat.getSdk, wire }); }
catch (e) { console.error('panel disabled:', e.message); }
let inbox = null;     // the Inbox coordinator: one card per session that needs a look (web-inbox.js)
try {
  inbox = require(process.env.WEB_INBOX_MODULE || './web-inbox.js');
  if (chat && chat.getSdk) {
    inbox.init({ getSdk: chat.getSdk, wire, listSessions: () => chat.decorate(registry.list()), pendingPerms: chat.pendingPerms,
      answerPerm: chat.answerPerm, sendTo: chat.sendTo, transcriptPath: chat.transcriptPath });
  }
} catch (e) { console.error('inbox disabled:', e.message); }
// small JSON request bodies only
function readJson(req, limit, cb) {
  let body = '', big = false;
  req.on('data', (d) => { body += d; if (body.length > limit) { big = true; req.destroy(); } });
  req.on('end', () => { if (big) return; let o = null; try { o = JSON.parse(body || '{}'); } catch (_) {} cb(o); });
}
// shown instead of the UI until this browser is signed in, while no login exists yet
const SIGNIN_PAGE = (bad) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>claude-box: sign in</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.55 system-ui,-apple-system,sans-serif;background:#f7f8fa;color:#1f2430}
@media (prefers-color-scheme:dark){body{background:#0f1218;color:#d6dbe4}code{background:#1c212b!important}}
main{max-width:460px;padding:24px}h1{font-size:20px;margin:0 0 10px}code{background:#eceef2;padding:2px 6px;border-radius:5px;font-size:13.5px}p{margin:8px 0}.err{color:#c62828}</style></head>
<body><main><h1>Open the sign-in link</h1>
${bad ? '<p class="err">This sign-in link has expired or was already used.</p>' : ''}
<p>When you run <code>./claude-box</code>, it prints a one-time link to this page. Open it in this browser to sign in, then pick a login and password.</p>
<p>Need a fresh link? Run <code>./claude-box --login</code> on the computer where the box runs.</p></main></body></html>`;
function json(res, code, obj) {
  try { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch (_) {}
}

// Voice alerts spoken by the browser (speechSynthesis), instead of a helper on the host.
// A session drops phrases into SAY_DIR (Monitoring/notify.sh: "<unix-ns>-<pid>.txt").
// GET /say?on=1 hands out the queued phrases oldest first and deletes them, so only one
// open tab speaks each, and refreshes SAY_DIR/.heartbeat ("a browser is listening"),
// which notify.sh checks. Without on=1 (voice off in that tab) nothing is consumed.
const SAY_DIR = process.env.WEB_SAY_DIR || '/workspace/Monitoring/alerts';
const SAY_MAX_AGE = 15 * 60;   // older phrases (laptop asleep, no tab open) are dropped unspoken
function takeSay() {
  const p = require('path');
  let names;
  try { names = fs.readdirSync(SAY_DIR).filter((n) => /^\d+-\d+\.txt$/.test(n)).sort(); }
  catch (_) { return []; }
  try { fs.writeFileSync(p.join(SAY_DIR, '.heartbeat'), String(Math.floor(Date.now() / 1000))); } catch (_) {}
  const now = Date.now() / 1000, out = [];
  for (const n of names.slice(0, 20)) {
    const f = p.join(SAY_DIR, n);
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); fs.unlinkSync(f); } catch (_) { continue; }
    const at = Number(n.split('-')[0]) / 1e9;
    text = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (text && now - at <= SAY_MAX_AGE) out.push(text);
  }
  return out;
}

// The sidecar is a long-lived proxy: NO single bad request must crash the process,
// otherwise ALL WS sessions break at once. Swallow uncaught errors, don't exit.
process.on('uncaughtException', (e) => console.error('uncaught:', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', (e && e.stack) || e));

// decodeURIComponent throws URIError on malformed %-encoding — don't crash because of it.
function safeDecode(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }

// basic-auth: the sidecar serves /sessions (session names/paths) and the launcher — when a
// password is set they MUST sit behind the same barrier as the terminal. Login: WEB_TERMINAL_USER.
// Failed logins are rate-limited; cb-session may use the per-start API token (start(opts)).
let auth = webGuard.makeAuth({ user: USER, password: PW, store: authStore, cookie: COOKIE });

// ttyd always runs with its own random login (web-serve.js), so a page that reaches its loopback
// port directly gets nowhere; the sidecar, which has already checked the user, swaps that login in.
let TTYD_AUTH = '';
function ttydHeaders(h) {
  const o = Object.assign({}, h);
  if (TTYD_AUTH) o.authorization = 'Basic ' + Buffer.from(TTYD_AUTH).toString('base64');
  return o;
}

function proxy(req, res) {
  const opts = { host: '127.0.0.1', port: TTYD, method: req.method, path: req.url, headers: ttydHeaders(req.headers) };
  const up = http.request(opts, r => {
    if (!res.headersSent) res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  // An upstream error can arrive AFTER headers have already been sent -> a second writeHead
  // would throw ERR_HTTP_HEADERS_SENT. Guard + try so this doesn't crash the process.
  up.on('error', () => { try { if (!res.headersSent) res.writeHead(502); res.end('ttyd down'); } catch (_) {} });
  res.on('error', () => up.destroy());
  req.on('error', () => up.destroy());
  req.pipe(up);
}

const handler = (req, res) => {
  try {
    const denied = guard(req);
    if (denied) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden: ' + denied); return; }
    // nothing served here may be framed by another site (the proxied terminal included)
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    res.setHeader('content-security-policy', "frame-ancestors 'self'");
    const a = auth(req);
    if (!a.ok) {
      if (a.status === 429) {
        res.writeHead(429, { 'retry-after': String(a.retry), 'content-type': 'text/plain' });
        res.end('too many failed logins, try again in ' + Math.ceil(a.retry / 60) + ' min'); return;
      }
      if (a.setup) {          // no login set up yet: only the link from ./claude-box gets in
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(SIGNIN_PAGE(a.badKey)); return;
      }
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="claude-box"' });
      res.end('auth required'); return;
    }
    if (a.login) {            // the one-time key: this browser gets a session, the key leaves the URL
      const secure = !!(req.socket && req.socket.encrypted);
      res.writeHead(302, { 'set-cookie': webAuth.sessionCookie(COOKIE, authStore.newSession(), secure), location: '/', 'cache-control': 'no-store' });
      res.end(); return;
    }
    const path = req.url.split('?')[0];
    if (path === '/cert') {          // the self-signed cert, for importing into client devices
      try {
        const buf = fs.readFileSync(process.env.WEB_TLS_CERT || '/nonexistent');
        res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="claude-box.crt"' });
        res.end(buf);
      } catch (_) { res.writeHead(404); res.end('no certificate'); }
      return;
    }
    if (path === '/auth/state') {
      json(res, 200, { configured: authStore.configured(), fromEnv: authStore.fromEnv(), user: authStore.configured() ? authStore.user() : '' });
      return;
    }
    if (path === '/auth/password' && req.method === 'POST') {
      readJson(req, 4096, (o) => {
        o = o || {};
        // changing an existing login needs the current password; the first one is set by whoever
        // got in with the key link
        if (authStore.configured() && !authStore.checkPassword(authStore.user(), String(o.current || ''))) {
          json(res, 403, { ok: false, error: 'The current password is wrong.' }); return;
        }
        const err = authStore.setPassword(String(o.user || '').trim(), String(o.password || ''));
        if (err) { json(res, 400, { ok: false, error: err }); return; }
        // this browser stays signed in (it may have come in with the password, not a cookie)
        const keep = a.session || authStore.newSession();
        if (o.signOutOthers) authStore.dropSessions(keep);
        const h = { 'content-type': 'application/json' };
        if (!a.session) h['set-cookie'] = webAuth.sessionCookie(COOKIE, keep, !!(req.socket && req.socket.encrypted));
        res.writeHead(200, h); res.end(JSON.stringify({ ok: true, user: authStore.user() }));
      });
      return;
    }
    if (path === '/git/repos') {
      const force = /(?:^|&)fresh=1/.test(req.url.split('?')[1] || '');
      webGit.repos(force).then((r) => json(res, 200, r), (e) => json(res, 502, { error: String(e.message || e) })); return;
    }
    if (path === '/git/status') { webGit.status().then((s) => json(res, 200, s), (e) => json(res, 500, { error: String(e.message || e) })); return; }
    if (path.startsWith('/git/') && req.method === 'POST') {
      if (path === '/git/login') { json(res, 200, webGit.start()); return; }
      if (path === '/git/login/cancel') { json(res, 200, webGit.cancel()); return; }
      if (path === '/git/logout') { webGit.logout().then((r) => json(res, r.ok ? 200 : 400, r)); return; }
    }
    if (path === '/sessions') {
      const t0 = Date.now();
      let rows; try { rows = registry.list(); } catch (_) { json(res, 500, '[]'); return; }
      const t1 = Date.now();
      rows = chat ? chat.decorate(rows) : rows;
      const t2 = Date.now();
      if (t2 - t0 > 500) console.error(`[sessions] slow: registry ${t1 - t0}ms, decorate ${t2 - t1}ms, ${rows.length} rows at ${new Date().toISOString()}`);
      json(res, 200, rows);
      return;
    }
    if (path === '/chat/info') {
      if (!chat) { json(res, 200, { enabled: false, error: 'chat module not loaded' }); return; }
      chat.info().then((i) => json(res, 200, i), () => json(res, 200, { enabled: false }));
      return;
    }
    if (path === '/dirs') { json(res, 200, chat ? chat.dirs() : []); return; }
    if (path === '/rename' && req.method === 'POST') {
      // rename a session (custom-title in its transcript, same as Claude Code's /rename)
      const m = /(?:^|&)id=([^&]*)/.exec(req.url.split('?')[1] || '');
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let title = ''; try { title = JSON.parse(body).title; } catch (_) {}
        if (!chat || !m) { json(res, 400, { ok: false }); return; }
        chat.rename(safeDecode(m[1]), title).then((t) => json(res, 200, { ok: true, title: t }),
          (e) => json(res, 400, { ok: false, error: String(e.message || e) }));
      });
      return;
    }
    if (path === '/workspace' || path.startsWith('/workspace/')) {
      if (!workspace) { json(res, 503, { error: 'workspace manager not loaded' }); return; }
      const qs = new URLSearchParams(req.url.split('?')[1] || '');
      const op = path.slice('/workspace/'.length);
      const fail = (e) => json(res, e && e.code === 409 ? 409 : 400, { ok: false, error: String((e && e.message) || e) });
      try {
        if (req.method !== 'POST') {
          if (op === 'ls') { json(res, 200, workspace.ls(qs.get('p') || '', qs.get('hidden') === '1')); return; }
          if (op === 'sizes') { workspace.sizes(qs.get('p') || '').then((s) => json(res, 200, s), fail); return; }
          if (op === 'file') { workspace.serveFile(res, qs.get('p') || '', qs.get('dl') === '1'); return; }
          if (op === 'image') { workspace.serveImage(res, qs.get('p') || ''); return; }
          if (op === 'text') { json(res, 200, workspace.readText(qs.get('p') || '')); return; }
          json(res, 200, workspace.list()); return;
        }
        if (op === 'save') {        // raw body = the whole text; ?p=<rel>&mtime=<as loaded>&force=1
          workspace.saveText(req, qs.get('p') || '', qs.get('mtime'), qs.get('force') === '1')
            .then((r) => json(res, 200, Object.assign({ ok: true }, r)), fail);
          return;
        }
        if (op === 'upload') {      // raw body = the file; ?dir=<rel>&name=<name or sub/path>&overwrite=1
          workspace.upload(req, qs.get('dir') || '', qs.get('name') || '', qs.get('overwrite') === '1')
            .then((r) => json(res, 200, Object.assign({ ok: true }, r)), fail);
          return;
        }
      } catch (e) { fail(e); return; }
      readJson(req, 256 << 10, (o) => {
        try {
          if (!o) throw new Error('bad request');
          const r = op === 'mkdir' ? workspace.mkdir(o.name, o.dir)
            : op === 'rename' ? workspace.rename(o.path || o.from, o.to)
            : op === 'clone' ? workspace.clone(o.url, o.name, o.dir)
            : op === 'copy' ? workspace.copy(o.items, o.dest)
            : op === 'move' ? workspace.move(o.items, o.dest)
            : op === 'trash' ? workspace.trash(o.items)
            : null;
          if (!r) { json(res, 404, { error: 'unknown op' }); return; }
          json(res, 200, Object.assign({ ok: true }, r));
        } catch (e) { fail(e); }
      });
      return;
    }
    if (path === '/tasks' || path.startsWith('/tasks/')) {
      if (!tasks) { json(res, 503, { error: 'tasks module not loaded' }); return; }
      const ok = (p) => p.then((r) => json(res, 200, Object.assign({ ok: true }, r)),
        (e) => json(res, 400, { ok: false, error: String(e.message || e) }));
      if (req.method !== 'POST') { ok(tasks.list()); return; }
      readJson(req, 64 << 10, (o) => {
        if (!o) { json(res, 400, { ok: false, error: 'bad request' }); return; }
        const op = path.slice('/tasks/'.length);
        const run = {
          open: () => tasks.open(o),
          archive: () => tasks.archive(o.slug, !!o.force),
          reopen: () => tasks.reopen(o.slug),
          refresh: () => tasks.refresh(o.slug),
          forget: () => tasks.forget(o.slug),
          'add-repos': () => tasks.addRepos(o.slug, o.repos),
          'repo-add': () => tasks.addRepo(o),
        }[op];
        if (!run) { json(res, 404, { ok: false, error: 'unknown op' }); return; }
        ok(Promise.resolve().then(run));
      });
      return;
    }
    if (path === '/chat/api/new' || path === '/chat/api/status') {
      // headless sessions for agents (scripts/cb-session.js); see web-chat.js apiNew/apiStatus
      if (!chat) { json(res, 503, { ok: false, error: 'chat module not loaded' }); return; }
      const ok = (p) => p.then((r) => json(res, 200, Object.assign({ ok: true }, r)),
        (e) => json(res, 400, { ok: false, error: String(e.message || e) }));
      if (path === '/chat/api/status') {
        const m = /(?:^|&)token=([^&]*)/.exec(req.url.split('?')[1] || '');
        ok(m ? chat.apiStatus(safeDecode(m[1])) : Promise.reject(new Error('token is required'))); return;
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return; }
      readJson(req, 256 << 10, (o) => {
        if (!o) { json(res, 400, { ok: false, error: 'bad request' }); return; }
        ok(chat.apiNew(o).then((r) => {
          if (o.category) {        // file the session under a sidebar category (created if missing)
            const c = readCats(), name = String(o.category).slice(0, 80);
            let cat = c.cats.find((x) => x.name === name);
            if (!cat) { cat = { id: 'c' + Date.now().toString(36), name }; c.cats.push(cat); }
            c.map[r.token] = cat.id; writeCats(cleanCats(c));
          }
          return r;
        }));
      });
      return;
    }
    if (path === '/wire' || path.startsWith('/wire/')) {      // recorded model traffic (web-wire.js), off by default
      if (!wire) { json(res, 503, { ok: false }); return; }
      const q = new URL(req.url, 'http://x').searchParams;
      if (path === '/wire/settings' && req.method === 'POST') {
        readJson(req, 1024, (o) => { try { json(res, 200, Object.assign({ ok: true }, wire.setSettings(o || {}))); } catch (e) { json(res, 400, { ok: false, error: e.message }); } });
        return;
      }
      if (path === '/wire') { json(res, 200, { settings: wire.getSettings(), runs: wire.list({ token: q.get('token') || '', cid: q.get('cid') || '' }) }); return; }
      const m = /^\/wire\/([\w-]+)(?:\/(actions|raw))?$/.exec(path);
      if (!m) { json(res, 404, { ok: false }); return; }
      if (m[2] === 'raw') {
        const f = wire.rawPath(m[1]); if (!f) { json(res, 404, { ok: false }); return; }
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'content-disposition': 'attachment; filename="' + m[1] + '.jsonl"' });
        require('fs').createReadStream(f).pipe(res); return;
      }
      const r = m[2] === 'actions' ? wire.actions(m[1]) : wire.get(m[1], q.get('from'), q.get('n'));
      if (!r) { json(res, 404, { ok: false }); return; }
      json(res, 200, r); return;
    }
    if (path === '/inbox' || path === '/inbox/act' || path === '/inbox/refresh') {
      if (!inbox) { json(res, 503, { enabled: false, error: 'inbox module not loaded' }); return; }
      if (path === '/inbox') { json(res, 200, inbox.get()); return; }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return; }
      if (path === '/inbox/refresh') { inbox.tick(); json(res, 200, { ok: true }); return; }
      readJson(req, 64 << 10, (o) => {
        Promise.resolve().then(() => inbox.act(o || {}))
          .then((r) => json(res, 200, Object.assign({ ok: true }, r)), (e) => json(res, 400, { ok: false, error: String(e.message || e) }));
      });
      return;
    }
    if (path === '/panel/settings' && req.method === 'POST') {   // {every: minutes, 0 = only on demand}
      if (!panel) { json(res, 503, { ok: false }); return; }
      readJson(req, 1024, (o) => {
        try { json(res, 200, Object.assign({ ok: true }, panel.setEvery(o && o.every))); }
        catch (e) { json(res, 400, { ok: false, error: String(e.message || e) }); }
      });
      return;
    }
    if (path === '/panel/hide' && req.method === 'POST') {     // {key, sig, title} | {key, unhide:true} | {all:true}
      if (!panel) { json(res, 503, { ok: false }); return; }
      readJson(req, 16 << 10, (o) => {
        try { json(res, 200, Object.assign({ ok: true }, o && o.all ? panel.unhideAll() : panel.hide(o || {}))); }
        catch (e) { json(res, 400, { ok: false, error: String(e.message || e) }); }
      });
      return;
    }
    if (path === '/panel/jira/recent') {      // the New task dialog's instant list (refreshed in the background)
      if (!panel) { json(res, 503, { error: 'panel disabled' }); return; }
      json(res, 200, panel.jiraRecent()); return;
    }
    if (path === '/panel/jira') {             // the New task dialog: find any Jira issue (read-only run)
      if (!panel) { json(res, 503, { error: 'panel disabled' }); return; }
      const q = new URLSearchParams(req.url.split('?')[1] || '').get('q') || '';
      panel.jiraSearch(q).then((r) => json(res, 200, r), (e) => json(res, 502, { error: String(e.message || e) })); return;
    }
    if (path === '/panel/runs' || path.startsWith('/panel/runs/')) {  // the Today agent's run log
      if (!panel) { json(res, 503, { error: 'panel module not loaded' }); return; }
      if (path === '/panel/runs') { json(res, 200, panel.runs()); return; }
      const r = panel.run(decodeURIComponent(path.slice('/panel/runs/'.length)));
      if (r) json(res, 200, r); else json(res, 404, { error: 'no such run' });
      return;
    }
    if (path === '/panel' || path === '/panel/refresh') {
      if (!panel) { json(res, 503, { enabled: false, error: 'panel module not loaded' }); return; }
      const w = /(?:^|&)what=(github|agent)(?:&|$)/.exec(req.url.split('?')[1] || '');
      if (path === '/panel/refresh' && req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return; }
      const p = path === '/panel' ? panel.get() : panel.refresh(w ? w[1] : 'all');
      p.then((o) => json(res, 200, o), (e) => json(res, 500, { error: String(e.message || e) }));
      return;
    }
    if (path === '/categories') {
      if (req.method !== 'POST') { json(res, 200, readCats()); return; }
      let body = '', big = false;
      req.on('data', (d) => { body += d; if (body.length > 512 << 10) { big = true; req.destroy(); } });
      req.on('end', () => {
        if (big) return;
        try { const o = cleanCats(JSON.parse(body)); writeCats(o); json(res, 200, o); }
        catch (e) { json(res, 400, { error: String(e.message || e) }); }
      });
      return;
    }
    if (path === '/') {
      fs.readFile(LAUNCHER, (e, buf) => {
        try {
          if (e) { res.writeHead(500); res.end('no launcher'); return; }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' });
          res.end(buf);
        } catch (_) {}
      });
      return;
    }
    if (path === '/say') {
      if (!/[?&]on=1(?:&|$)/.test(req.url)) { json(res, 200, { say: [] }); return; }
      // during a calendar meeting the phrases are dropped (they would go into the call's mic),
      // but the queue is still drained and the heartbeat refreshed, so notify.sh sees a listener
      let meeting = null; try { meeting = panel && panel.inMeeting ? panel.inMeeting() : null; } catch (_) {}
      const say = takeSay();
      json(res, 200, meeting ? { say: [], muted: 'meeting', until: meeting.end, dropped: say.length } : { say });
      return;
    }
    if (path === '/metrics') {
      const m = /[?&]id=([^&]*)/.exec(req.url);
      metrics(m ? safeDecode(m[1]) : '').then((o) => json(res, 200, o), () => json(res, 500, '{}'));
      return;
    }
    if (path === '/preview') {
      const q = req.url.split('?')[1] || '';
      const m = /(?:^|&)id=([^&]*)/.exec(q);
      if (!m) { try { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{}'); } catch (_) {} return; }
      preview(safeDecode(m[1]), /(?:^|&)full=1(?:&|$)/.test(q))
        .then((o) => json(res, 200, o), () => json(res, 500, '{}'));
      return;
    }
    if (path === '/delete' && req.method === 'POST') {
      // remove a session from the dashboard (registry + cache + kill its tmux). POST only,
      // so a stray GET/prefetch can't wipe a session. Behind the authed() barrier.
      const q = req.url.split('?')[1] || '';
      const m = /(?:^|&)id=([^&]*)/.exec(q);
      if (!m) { try { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"ok":false}'); } catch (_) {} return; }
      const tok = safeDecode(m[1]);
      Promise.resolve(chat && chat.stopByToken(tok)).catch(() => {}).then(() => {
        try { registry.remove(tok); json(res, 200, '{"ok":true}'); } catch (_) { json(res, 500, '{"ok":false}'); }
      });
      return;
    }
    if (path === '/search') {
      const q = req.url.split('?')[1] || '';
      const mq = /(?:^|&)q=([^&]*)/.exec(q);
      // a query string encodes a space as '+', which decodeURIComponent leaves untouched
      const query = mq ? safeDecode(mq[1].replace(/\+/g, ' ')) : '';
      if (query.trim().length < 2) {                    // empty/too short -> don't invoke the helper
        try { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); } catch (_) {}
        return;
      }
      const capped = query.slice(0, 200);               // cap on query length
      const ms = /(?:^|&)scope=([^&]*)/.exec(q);
      const scope = (ms && safeDecode(ms[1]) === 'all') ? 'all' : 'prompts';
      search(capped, scope).then((o) => json(res, 200, o), () => json(res, 500, '[]'));
      return;
    }
    // everything else (/term, /token, ttyd static assets) -> ttyd
    proxy(req, res);
  } catch (e) {
    console.error('handler error:', (e && e.stack) || e);
    try { if (!res.headersSent) res.writeHead(500); res.end(); } catch (_) {}
  }
};

// TLS: if web-serve passed a cert+key and they are readable -> https, otherwise http (as before).
// Read at start(), not at load: web-serve.js loads this module before it has made the cert.
function loadTls() {
  if (!process.env.WEB_TLS_CERT || !process.env.WEB_TLS_KEY) return null;
  try { return { cert: fs.readFileSync(process.env.WEB_TLS_CERT), key: fs.readFileSync(process.env.WEB_TLS_KEY) }; }
  catch (e) { console.error('tls read failed, fallback http:', e.message); return null; }
}
// WebSocket upgrade (/ws) -> ttyd. Shared by the http and https servers.
function onUpgrade(req, socket, head) {
  try {
    const denied = guard(req);
    if (denied) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const a = auth(req);
    if (!a.ok) { socket.end(a.status === 429 ? 'HTTP/1.1 429 Too Many Requests\r\n\r\n' : 'HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    if (req.url.split('?')[0] === '/chat/ws') {
      if (!chat) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
      chat.handleUpgrade(req, socket, head); return;
    }
    const up = net.connect(TTYD, '127.0.0.1', () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(ttydHeaders(req.headers)).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      socket.pipe(up); up.pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  } catch (_) { try { socket.destroy(); } catch (__) {} }
}

// Two independent listeners on DIFFERENT ports (network_mode: host, no mapping needed):
//   http  on WEB_TERMINAL_PORT — always works; over a LAN IP this is an insecure context,
//          so the browser has NO clipboard or notifications, but the terminal works.
//   https on WEB_TLS_PORT      — secure context: clipboard + notifications (needs a cert).
// No redirect: each port serves the terminal on its own scheme, the user chooses.
// opts.ttydAuth: "user:pass" ttyd was started with; opts.apiToken: the token cb-session sends
function start(opts) {
  opts = opts || {};
  TTYD_AUTH = opts.ttydAuth || '';
  if (opts.apiToken) auth = webGuard.makeAuth({ user: USER, password: PW, store: authStore, cookie: COOKIE, apiToken: opts.apiToken });
  const tls = loadTls();
  const servers = [];
  // requestTimeout 0: large uploads to the Workspace file manager may take longer than Node's 5 min default
  const httpServer = http.createServer({ requestTimeout: 0 }, handler);
  httpServer.on('upgrade', onUpgrade);
  httpServer.listen(PORT, IFACE, () => console.error(`sidecar http://${IFACE}:${PORT} -> ttyd ${TTYD}`));
  servers.push(httpServer);
  if (tls) {
    const httpsServer = https.createServer(Object.assign({ requestTimeout: 0 }, tls), handler);
    httpsServer.on('upgrade', onUpgrade);
    httpsServer.listen(TLS_PORT, IFACE, () => console.error(`sidecar https://${IFACE}:${TLS_PORT} -> ttyd ${TTYD}`));
    servers.push(httpsServer);
  }
  return servers;
}

module.exports = { start, handler, onUpgrade };
// Event-loop lag probe: when the loop stalls (a sync scan, GC, a wedged child), every endpoint
// freezes for that long — the "sessions slow for a few seconds" symptom. This makes such stalls
// visible in docker logs with their exact duration instead of being invisible from outside.
let lastBeat = Date.now();
setInterval(() => {
  const now = Date.now(), drift = now - lastBeat - 2000;
  lastBeat = now;
  if (drift > 800) console.error(`[loop] stalled ${drift}ms at ${new Date().toISOString()}`);
}, 2000).unref();
// standalone (tests, debugging): the same options from the environment
if (require.main === module) start({ ttydAuth: process.env.CB_TTYD_AUTH, apiToken: process.env.CB_API_TOKEN });
