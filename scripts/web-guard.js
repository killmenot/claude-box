'use strict';
// Request guard and login check for the sidecar (web-sidecar.js).
//
// makeGuard — Basic auth alone is not enough: a browser re-sends the cached login on requests
// that OTHER sites trigger (a hidden form POST, an <img>, an <iframe>, a WebSocket), so without
// this any page the user visits could drive the box. Three checks:
//   1. Fetch Metadata: a request a browser marks cross-site / same-site is refused, except a plain
//      top-level navigation (a link the user clicks). That blocks <img>/<iframe>/fetch from other
//      sites even for GETs with side effects (/panel starts a paid run, /term/?new= spawns a shell).
//   2. state-changing requests (anything but GET/HEAD/OPTIONS) and WebSocket upgrades must come
//      from our own origin: an Origin header, when present, must name this host. Non-browser
//      clients (cb-session, curl) send neither Origin nor Sec-Fetch-*.
//   3. without a password, the Host header must be a loopback/IP address (or listed in
//      WEB_ALLOWED_HOSTS) — this stops DNS rebinding, where evil.example re-resolves to 127.0.0.1.
//
// makeAuth — the Basic-auth check itself: constant-time compare, and failed logins are limited
// per client and in total (a DNS-rebinding page or a public tunnel could otherwise guess at full
// speed). cb-session inside the box uses a per-start API token instead of the web password, so
// the password never has to be in the sessions' environment.
const crypto = require('crypto');
const { readCookie } = require('./web-auth.js');
const fs = require('fs');
const net = require('net');
const path = require('path');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// "Example.COM:443" -> "example.com"; "[::1]:8080" -> "::1"
function hostName(h) {
  h = String(h || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined);
  return h.replace(/:\d+$/, '');
}
// host[:port] with the default port of the scheme dropped, for comparing Origin with Host
function hostPort(h, scheme) {
  h = String(h || '').trim().toLowerCase();
  if (scheme === 'https:') return h.replace(/:443$/, '');
  if (scheme === 'http:') return h.replace(/:80$/, '');
  return h.replace(/:(80|443)$/, '');
}
function isLocalName(name) {
  return name === 'localhost' || name.endsWith('.localhost') || net.isIP(name) !== 0;
}

function listEnv(v) { return String(v || '').split(',').map((s) => hostName(s)).filter(Boolean); }

// the public tunnel's host (written by web-serve.js), so a proxy that rewrites Host still works
function tunnelHost(file) {
  try { const u = fs.readFileSync(file, 'utf8').trim(); return u ? new URL(u).host.toLowerCase() : ''; } catch (_) { return ''; }
}

function makeGuard(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const password = opts.password != null ? opts.password : (env.WEB_TERMINAL_PASSWORD || '');
  const extra = listEnv(env.WEB_ALLOWED_HOSTS);
  if (env.NGROK_DOMAIN) extra.push(hostName(env.NGROK_DOMAIN));
  const tunnelFile = opts.tunnelFile ||
    path.join(env.HOME || '/home/node', '.claude', 'web-tunnel-url');

  // returns null when the request may pass, otherwise a short reason (sent with a 403)
  return function check(req) {
    const h = req.headers || {};
    if (!password) {
      const name = hostName(h.host);
      if (!name || !(isLocalName(name) || extra.includes(name))) return 'host not allowed';
    }
    const upgrade = String(h.upgrade || '').toLowerCase() === 'websocket';
    const method = String(req.method || 'GET').toUpperCase();

    // 1. Fetch Metadata resource isolation
    const site = String(h['sec-fetch-site'] || '').toLowerCase();
    if (site === 'cross-site' || site === 'same-site') {
      const mode = String(h['sec-fetch-mode'] || '').toLowerCase();
      const dest = String(h['sec-fetch-dest'] || '').toLowerCase();
      const topLevelNav = !upgrade && (method === 'GET' || method === 'HEAD') && mode === 'navigate' && (dest === 'document' || dest === '');
      if (!topLevelNav) return 'cross-site request';
    }
    if (!upgrade && SAFE_METHODS.has(method)) return null;

    // 2. same origin for state changes and WebSockets
    if (h.origin === undefined) return null;
    let o;
    try { o = new URL(String(h.origin)); } catch (_) { return 'cross-origin request'; }   // also "null"
    if (o.protocol !== 'http:' && o.protocol !== 'https:') return 'cross-origin request';
    // the Host this request reached (exact host:port), or — behind a tunnel/proxy that rewrites
    // Host — the forwarded host, the tunnel's own host, or an allow-listed name (host part only)
    const got = hostPort(o.host, o.protocol), gotName = hostName(o.host);
    const fwd = String(h['x-forwarded-host'] || '').split(',')[0];
    const ok = [h.host, fwd].filter(Boolean).some((x) => hostPort(x, o.protocol) === got) ||
      [tunnelHost(tunnelFile)].concat(extra).filter(Boolean).some((x) => hostName(x) === gotName);
    return ok ? null : 'cross-origin request';
  };
}

// ---------------------------------------------------------------- login
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(Buffer.from(a)), sha(Buffer.from(b)));
const LOOPBACK = (a) => /^(127\.|::1$|::ffff:127\.)/.test(String(a || ''));
const FORWARDED = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'cf-connecting-ip', 'x-real-ip'];

// Limits: a client is locked for KEY_LOCK after KEY_MAX failures within WINDOW; when all clients
// together fail GLOBAL_MAX times within WINDOW, every login is refused for GLOBAL_LOCK (a local
// rebinding page can fake X-Forwarded-For to look like many clients — this caps it anyway).
const LIMITS = { WINDOW: 10 * 60000, KEY_MAX: 10, KEY_LOCK: 15 * 60000, GLOBAL_MAX: 100, GLOBAL_LOCK: 10 * 60000 };

// opts.store (web-auth.js): the login lives there, a session cookie (opts.cookie names it) or the
// one-time key from the host script (/?key=…) signs a browser in, and with no login set up yet
// nothing else gets in. Without a store: the old single .env password, none = open.
function makeAuth(opts) {
  opts = opts || {};
  const user = opts.user || 'claude', password = opts.password || '', apiToken = opts.apiToken || '';
  const store = opts.store || null, cookie = opts.cookie || 'cb_s';
  const now = opts.now || Date.now;
  const L = Object.assign({}, LIMITS, opts.limits);
  const keys = new Map();             // client -> {n, first, until}
  let fails = [], globalUntil = 0;

  // the client behind a tunnel is the address the tunnel reports (the LAST hop it added),
  // otherwise the socket's own address
  function clientKey(req) {
    const h = req.headers || {};
    const fwd = h['cf-connecting-ip'] || String(h['x-forwarded-for'] || '').split(',').pop().trim();
    return ((req.socket && req.socket.remoteAddress) || '') + '|' + (fwd || '');
  }
  function fail(key, t) {
    let e = keys.get(key);
    if (!e || t - e.first > L.WINDOW) e = { n: 0, first: t, until: 0 };
    if (++e.n >= L.KEY_MAX) e.until = t + L.KEY_LOCK;
    keys.delete(key); keys.set(key, e);
    if (keys.size > 5000) keys.delete(keys.keys().next().value);
    fails.push(t); fails = fails.filter((x) => x > t - L.WINDOW);
    if (fails.length >= L.GLOBAL_MAX) { globalUntil = t + L.GLOBAL_LOCK; fails = []; }
  }

  // -> {ok:true} | {ok:false, status:401} | {ok:false, status:429, retry:seconds}
  return function check(req) {
    if (!store && !password) return { ok: true };
    const h = req.headers || {};
    const p = String(req.url || '').split('?')[0];
    // cb-session inside the box: the per-start API token, only for the headless chat API, only
    // straight from loopback (never through a tunnel or another proxy)
    if (apiToken && h['x-cb-api-token'] && p.startsWith('/chat/api/') &&
        LOOPBACK(req.socket && req.socket.remoteAddress) && !FORWARDED.some((k) => h[k] !== undefined)) {
      return safeEqual(String(h['x-cb-api-token']), apiToken) ? { ok: true } : { ok: false, status: 401 };
    }
    const t = now(), key = clientKey(req), e = keys.get(key);
    if (globalUntil > t) return { ok: false, status: 429, retry: Math.ceil((globalUntil - t) / 1000) };
    if (e && e.until > t) return { ok: false, status: 429, retry: Math.ceil((e.until - t) / 1000) };
    if (store) {
      const c = readCookie(req, cookie);
      if (c && store.checkSession(c)) return { ok: true, session: c };
      const k = p === '/' && new URLSearchParams(String(req.url || '').split('?')[1] || '').get('key');
      if (k) {
        if (store.useKey(k)) { keys.delete(key); return { ok: true, login: true }; }
        fail(key, t);
        return { ok: false, status: 401, setup: !store.configured(), badKey: true };
      }
      if (!store.configured()) return { ok: false, status: 401, setup: true };   // only the key link gets in
    }
    const m = /^Basic (.+)$/.exec(h.authorization || '');
    if (!m) return { ok: false, status: 401 };              // no login yet: the browser will ask
    let got = '';
    try { got = Buffer.from(m[1], 'base64').toString(); } catch (_) {}
    const i = got.indexOf(':');
    const good = store ? i > 0 && store.checkPassword(got.slice(0, i), got.slice(i + 1)) : safeEqual(got, user + ':' + password);
    if (good) { keys.delete(key); return { ok: true }; }
    fail(key, t);
    return { ok: false, status: 401 };
  };
}

module.exports = { makeGuard, makeAuth, hostName, LIMITS };
