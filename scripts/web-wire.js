'use strict';
// Model traffic recorder (off by default; Settings -> "Record model traffic").
//
// When it is on, every agent run started from this server (chat sessions, the Inbox coordinator,
// the Today panel) gets its own HTTPS proxy on 127.0.0.1 inside the container (HTTPS_PROXY in the
// run's environment). Connections to the model API are opened here with a certificate from a local
// CA that only that run trusts (NODE_EXTRA_CA_CERTS), forwarded unchanged to the real API, and both
// sides are written down. So the record is the real bytes on the wire, including the system prompt
// and tool list Claude Code adds itself, not what our code believes it sent.
//
// Every other host the run (or a command it starts: curl, git, npm …) connects to is tunnelled
// through untouched and only counted by name, so the record also shows where the session went on
// the network. Credentials (authorization, x-api-key, cookies) are never stored.
// (A plain ANTHROPIC_BASE_URL proxy would be simpler, but Claude Code then drops the claude.ai connectors.)
//
// Storage, per run, in WIRE_DIR:
//   <id>.jsonl      one line per API request: {kind:'req', n, at, method, path, request, response}
//                   A request repeats the whole conversation every turn, so what an earlier request
//                   of the run already sent is stored as a reference: body.messagesFrom = {req, count}
//                   (the first `count` messages equal that request's, apart from cache markers) and
//                   body.system / body.tools = {$same_as: n} when unchanged.
//   <id>.meta.json  small summary for the list (counts, tokens, hosts, session token / id).

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HOME = process.env.HOME || '/home/node';
const WIRE_DIR = process.env.WEB_WIRE_DIR || path.join(HOME, '.claude', 'web-wire');
const CA_DIR = process.env.WEB_WIRE_CA || path.join(HOME, '.claude', 'web-wire-ca');
const SETTINGS_FILE = process.env.WEB_WIRE_SETTINGS || path.join(HOME, '.claude', 'web-wire-settings.json');
const MAX_BYTES = parseFloat(process.env.WEB_WIRE_MAX_MB || '2048') * 1048576;   // all records together
const ALLOWED = process.env.WEB_WIRE !== '0';                                     // hard off switch
const BODY_MAX = 16 * 1024 * 1024;
const API_HOST = 'api.anthropic.com';
const SECRET = /^(authorization|x-api-key|cookie|set-cookie|proxy-authorization|anthropic-oauth.*)$/i;

const runs = new Map();   // run id -> live state
let certs = null;
let settings = readSettings();

function readSettings() {
  try { return Object.assign({ enabled: false }, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch (_) { return { enabled: false }; }
}
function getSettings() { return { enabled: ALLOWED && !!settings.enabled, allowed: ALLOWED, dir: WIRE_DIR, maxMb: Math.round(MAX_BYTES / 1048576) }; }
function setSettings(o) {
  if (o && typeof o.enabled === 'boolean') settings.enabled = o.enabled;
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE + '.tmp', JSON.stringify(settings)); fs.renameSync(SETTINGS_FILE + '.tmp', SETTINGS_FILE);
  return getSettings();
}

function loadCerts() {
  if (certs) return certs;
  const f = (n) => path.join(CA_DIR, n);
  if (!fs.existsSync(f('leaf.crt'))) {
    fs.mkdirSync(CA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(f('ext.cnf'), ['[req]', 'distinguished_name=dn', '[dn]', '[ca]', 'basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign,cRLSign',
      '[leaf]', 'basicConstraints=CA:FALSE', 'subjectAltName=DNS:' + API_HOST, 'extendedKeyUsage=serverAuth', ''].join('\n'));
    const o = (args) => execFileSync('openssl', args, { cwd: CA_DIR, stdio: ['ignore', 'ignore', 'pipe'] });
    o(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '3650',
      '-subj', '/CN=claude-box model traffic recorder (local only)', '-extensions', 'ca', '-config', 'ext.cnf']);
    o(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=' + API_HOST, '-config', 'ext.cnf']);
    o(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '825',
      '-extensions', 'leaf', '-extfile', 'ext.cnf']);
    for (const n of ['ca.key', 'leaf.key']) fs.chmodSync(f(n), 0o600);
  }
  certs = { caFile: f('ca.crt'), key: fs.readFileSync(f('leaf.key')), cert: fs.readFileSync(f('leaf.crt')) };
  return certs;
}

function upstream() { return new URL(process.env.ANTHROPIC_BASE_URL || 'https://' + API_HOST); }
function cleanHeaders(h) {
  const o = {};
  for (const [k, v] of Object.entries(h || {})) o[k] = SECRET.test(k) ? '[hidden]' : v;
  return o;
}
function parseJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }
function hash(v) { return crypto.createHash('sha1').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex'); }
function noCache(v) {   // cache markers move to the newest message every turn: ignore them when comparing
  if (Array.isArray(v)) return v.map(noCache);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) if (k !== 'cache_control') o[k] = noCache(v[k]); return o; }
  return v;
}

// Rebuild the streamed (SSE) answer into one message, the way the API would return it unstreamed.
function assemble(sse) {
  const msg = { content: [], stop_reason: null, usage: {} };
  for (const line of String(sse).split('\n')) {
    if (!line.startsWith('data:')) continue;
    const e = parseJson(line.slice(5).trim());
    if (!e) continue;
    if (e.type === 'message_start' && e.message) { msg.id = e.message.id; msg.model = e.message.model; Object.assign(msg.usage, e.message.usage || {}); }
    else if (e.type === 'content_block_start') msg.content[e.index] = Object.assign({}, e.content_block, e.content_block.type === 'tool_use' || e.content_block.type === 'server_tool_use' ? { _json: '' } : {});
    else if (e.type === 'content_block_delta') {
      const b = msg.content[e.index]; const d = e.delta || {};
      if (!b) continue;
      if (d.type === 'text_delta') b.text = (b.text || '') + d.text;
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking;
      else if (d.type === 'input_json_delta') b._json += d.partial_json;
    } else if (e.type === 'message_delta') { if (e.delta) msg.stop_reason = e.delta.stop_reason; Object.assign(msg.usage, e.usage || {}); }
    else if (e.type === 'error') msg.error = e.error;
  }
  for (const b of msg.content) if (b && b._json !== undefined) { b.input = b._json ? (parseJson(b._json) || b._json) : (b.input || {}); delete b._json; }
  msg.content = msg.content.filter(Boolean);
  return msg;
}

// ---------- storage ----------
function fileOf(id, ext) { return path.join(WIRE_DIR, id + ext); }
function saveMeta(st) {
  try { fs.writeFileSync(fileOf(st.meta.id, '.meta.json.tmp'), JSON.stringify(st.meta), { mode: 0o600 }); fs.renameSync(fileOf(st.meta.id, '.meta.json.tmp'), fileOf(st.meta.id, '.meta.json')); }
  catch (e) { console.error('wire meta', e.message); }
}
function append(st, obj) {
  try { fs.appendFileSync(fileOf(st.meta.id, '.jsonl'), JSON.stringify(obj) + '\n', { mode: 0o600 }); }
  catch (e) { console.error('wire save', e.message); }
}
function prune() {
  try {
    const files = fs.readdirSync(WIRE_DIR).filter((f) => f.endsWith('.jsonl')).sort().reverse();
    let total = 0;
    for (const f of files) {
      const id = f.slice(0, -6);
      let sz = 0; try { sz = fs.statSync(path.join(WIRE_DIR, f)).size; } catch (_) {}
      total += sz;
      if (total > MAX_BYTES && !runs.has(id)) { fs.rmSync(path.join(WIRE_DIR, f), { force: true }); fs.rmSync(fileOf(id, '.meta.json'), { force: true }); }
    }
  } catch (_) {}
}

// Make a request body smaller by pointing at what an earlier request of this run already sent.
function compact(st, n, body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return body;
  const out = Object.assign({}, body);
  for (const k of ['system', 'tools']) {
    if (out[k] == null) continue;
    const h = hash(noCache(out[k]));
    if (st.parts.has(k + h)) out[k] = { $same_as: st.parts.get(k + h) }; else st.parts.set(k + h, n);
  }
  const hs = body.messages.map((m) => hash(noCache(m)));
  let best = null;
  for (const p of st.prev) {
    let i = 0; while (i < hs.length && i < p.hs.length && hs[i] === p.hs[i]) i++;
    if (i > 0 && (!best || i > best.count)) best = { req: p.n, count: i };
  }
  if (best) { out.messagesFrom = best; out.messages = body.messages.slice(best.count); }
  st.prev.unshift({ n, hs }); st.prev.length = Math.min(st.prev.length, 6);
  return out;
}

// ---------- the proxy ----------
// one decrypted API request: record it and pass it on to the real API
function handle(st, req, res) {
  const rest = req.url || '/', up = upstream(), n = ++st.meta.requests;
  const entry = { kind: 'req', n, at: new Date().toISOString(), method: req.method, path: rest, request: { headers: cleanHeaders(req.headers) } };
  const chunks = []; let size = 0;
  req.on('data', (c) => { size += c.length; if (size <= BODY_MAX) chunks.push(c); });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const text = body.toString('utf8');
    entry.request.bytes = size; st.meta.sentBytes += size;
    const parsed = parseJson(text);
    entry.request.body = parsed ? compact(st, n, parsed) : (size > BODY_MAX ? '[body too large: ' + size + ' bytes]' : text);
    const headers = Object.assign({}, req.headers, { host: up.host, 'accept-encoding': 'identity' });
    headers['content-length'] = String(body.length);
    const lib = up.protocol === 'http:' ? http : https;
    const t0 = Date.now();
    const out = lib.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, method: req.method,
      path: up.pathname.replace(/\/$/, '') + rest, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      const rc = []; let rsize = 0;
      r.on('data', (c) => { res.write(c); rsize += c.length; if (rsize <= BODY_MAX) rc.push(c); });
      r.on('end', () => {
        res.end();
        const rtext = Buffer.concat(rc).toString('utf8');
        const sse = /event-stream/.test(String(r.headers['content-type'] || ''));
        const rb = sse ? assemble(rtext) : (parseJson(rtext) || rtext);
        entry.response = { status: r.statusCode, headers: cleanHeaders(r.headers), bytes: rsize, ms: Date.now() - t0, body: rb };
        st.meta.recvBytes += rsize;
        const u = (rb && rb.usage) || {};
        st.meta.inTokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        st.meta.outTokens += u.output_tokens || 0;
        if (rb && Array.isArray(rb.content)) st.meta.actions += rb.content.filter((b) => b && b.type === 'tool_use').length;
        append(st, entry); saveMeta(st);
        if (n % 50 === 0) prune();
      });
    });
    out.on('error', (e) => {
      entry.response = { error: e.message, ms: Date.now() - t0 }; append(st, entry); saveMeta(st);
      if (!res.headersSent) res.writeHead(502); res.end();
    });
    out.end(body);
  });
}

// The run's proxy: CONNECT to the API host is opened and recorded, any other host is a blind tunnel.
function proxyFor(st) {
  const inner = http.createServer((req, res) => handle(st, req, res));
  const srv = http.createServer((req, res) => {
    // a plain-http proxy request (http_proxy is not set, so this should not happen): note it, refuse
    try { noteHost(st, new URL(req.url).host, 'http'); } catch (_) {}
    res.writeHead(403); res.end('plain HTTP through the recorder is not supported');
  });
  srv.on('connect', (req, sock, head) => {
    const [host, p] = String(req.url || '').split(':');
    const portN = parseInt(p, 10) || 443;
    if (host === API_HOST && portN === 443) {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const c = loadCerts();
      const t = new tls.TLSSocket(sock, { isServer: true, key: c.key, cert: c.cert, ALPNProtocols: ['http/1.1'] });
      if (head && head.length) t.unshift(head);
      t.on('error', () => {});
      inner.emit('connection', t);
      return;
    }
    noteHost(st, host + ':' + portN);
    const up = net.connect(portN, host, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head && head.length) up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
  });
  srv.on('clientError', (e, s) => s.destroy());
  return new Promise((resolve) => {
    srv.on('error', (e) => { console.error('wire proxy', e.message); resolve(null); });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
function noteHost(st, host, how) {
  const now = new Date().toISOString(), h = st.meta.hosts[host] || (st.meta.hosts[host] = { count: 0, first: now });
  h.count++; h.last = now; if (how) h.how = how;
  saveMeta(st);
}

// Start recording one agent run. Returns { id, env, update(fields), finish(fields) }. When recording
// is off (the default) or cannot start, env is returned unchanged and nothing is recorded.
async function begin(source, label, env, extra) {
  const none = { id: null, env, update() {}, finish() {} };
  if (!getSettings().enabled || upstream().host !== API_HOST) return none;
  // a session on another provider (its own ANTHROPIC_BASE_URL, web-models.js) is not recorded
  try { if (env && env.ANTHROPIC_BASE_URL && new URL(env.ANTHROPIC_BASE_URL).host !== API_HOST) return none; } catch (_) { return none; }
  try { loadCerts(); fs.mkdirSync(WIRE_DIR, { recursive: true, mode: 0o700 }); } catch (e) { console.error('wire', e.message); return none; }
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + source + '-' + Math.random().toString(36).slice(2, 6);
  const st = { parts: new Map(), prev: [], meta: Object.assign({ id, source, label: String(label || '').slice(0, 200), started: new Date().toISOString(),
    ended: null, upstream: upstream().origin, requests: 0, sentBytes: 0, recvBytes: 0, inTokens: 0, outTokens: 0, actions: 0, hosts: {} }, extra || {}) };
  const srv = await proxyFor(st);
  if (!srv) return none;
  runs.set(id, st); saveMeta(st); prune();
  const proxy = 'http://127.0.0.1:' + srv.address().port;
  const e = Object.assign({}, env, {
    HTTPS_PROXY: proxy, https_proxy: proxy, NO_PROXY: '', no_proxy: '',
    NODE_EXTRA_CA_CERTS: certs.caFile,
    // keeps Claude Code from sending telemetry / update checks / error reports on its own
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  return { id, env: e,
    update(f) { Object.assign(st.meta, f || {}); saveMeta(st); },
    finish(f) {
      Object.assign(st.meta, f || {}, { ended: new Date().toISOString() }); saveMeta(st);
      setTimeout(() => { runs.delete(id); srv.close(); if (srv.closeAllConnections) srv.closeAllConnections(); }, 30000);
    } };
}

// ---------- reading ----------
function okId(id) { return /^[\w-]{1,120}$/.test(String(id || '')); }
function meta(id) {
  if (!okId(id)) return null;
  if (runs.has(id)) return runs.get(id).meta;
  try { return JSON.parse(fs.readFileSync(fileOf(id, '.meta.json'), 'utf8')); } catch (_) { return null; }
}
function list(o) {
  o = o || {};
  let files = [];
  try { files = fs.readdirSync(WIRE_DIR).filter((f) => f.endsWith('.meta.json')).sort().reverse(); } catch (_) {}
  const out = [];
  for (const f of files) {
    const m = meta(f.slice(0, -10)); if (!m) continue;
    if (o.token && m.token !== o.token && !(o.cid && m.cid === o.cid)) continue;
    out.push(Object.assign({}, m, { live: runs.has(m.id) && !m.ended, hostCount: Object.keys(m.hosts || {}).length, hosts: undefined }));
    if (out.length >= (o.limit || 300)) break;
  }
  return out;
}
function lines(id) {
  let text = '';
  try { text = fs.readFileSync(fileOf(id, '.jsonl'), 'utf8'); } catch (_) {}
  return text.split('\n').filter(Boolean).map(parseJson).filter(Boolean);
}
function get(id, from, n) {
  const m = meta(id); if (!m) return null;
  const all = lines(id), f = Math.max(0, parseInt(from, 10) || 0), k = Math.min(Math.max(parseInt(n, 10) || 20, 1), 100);
  return { meta: m, total: all.length, from: f, requests: all.slice(f, f + k) };
}
// What the agent did: every tool call the model made (from the answers) with its result (from the
// next request), plus the hosts the run connected to.
function actions(id) {
  const m = meta(id); if (!m) return null;
  const list = [], byId = new Map();
  for (const q of lines(id)) {
    const msgs = (q.request && q.request.body && Array.isArray(q.request.body.messages)) ? q.request.body.messages : [];
    for (const msg of msgs) for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b && b.type === 'tool_result' && byId.has(b.tool_use_id)) {
        const a = byId.get(b.tool_use_id); if (a.result != null) continue;
        const c = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.type === 'text' ? x.text : '[' + x.type + ']').join('\n');
        a.result = c.length > 4000 ? c.slice(0, 4000) + '\n… (' + c.length + ' chars)' : c; a.error = !!b.is_error;
      }
    }
    const rb = q.response && q.response.body;
    for (const b of (rb && Array.isArray(rb.content)) ? rb.content : []) {
      if (!b || (b.type !== 'tool_use' && b.type !== 'server_tool_use')) continue;
      const a = { req: q.n, at: q.at, id: b.id, name: b.name, input: b.input, server: b.type === 'server_tool_use' };
      list.push(a); byId.set(b.id, a);
    }
  }
  return { meta: m, actions: list, hosts: m.hosts || {} };
}
function rawPath(id) { return okId(id) && fs.existsSync(fileOf(id, '.jsonl')) ? fileOf(id, '.jsonl') : null; }

module.exports = { begin, list, get, actions, meta, rawPath, assemble, compact, getSettings, setSettings, _dir: WIRE_DIR };
