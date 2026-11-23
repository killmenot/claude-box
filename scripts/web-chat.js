'use strict';
// claude-box web chat: drives Claude sessions through the Claude Agent SDK and streams them to
// the browser over ONE multiplexed WebSocket (/chat/ws). Loaded by web-sidecar.js.
//
// A Claude session is driven by exactly ONE owner at a time:
//   chat    — an Agent SDK query() owned by this module (HTML UI in the launcher)
//   console — `claude --resume` inside tmux (the classic terminal, via ttyd)
// Switching hands the session over: "release" stops the chat process before the console
// starts; "takeover" kills the console's tmux session before the chat resumes. Both write the
// same ~/.claude/projects/<cwd>/<id>.jsonl, so history carries over in both directions.
//
// Wire protocol (JSON text frames). `key` is the client's handle for a session: a registry
// token, or a client-made "new-N" for a session that has no Claude id yet.
//   client -> server:
//     {op:'open', key, token?, cwd?}   subscribe (+ history); cwd for a brand-new session
//     {op:'close', key}                unsubscribe
//     {op:'send', key, text, files?}   user message; files: [{name, type, data: base64}] (starts/resumes lazily)
//     {op:'interrupt', key}            stop the current turn
//     {op:'perm', key, id, allow, always?, answers?}   answer a permission / question request
//     {op:'mode', key, mode}           permission mode (default|acceptEdits|plan|auto)
//     {op:'release', key}              stop the chat process (before switching to console)
//     {op:'takeover', key}             kill the console tmux session (before switching to chat)
//     {op:'draft', key, text, voice}   the unsent composer text (kept per session, sent to other viewers);
//                                      voice: the dictation language when part of it was dictated
//     {op:'older', key, before}        an older page of history, ending before message uuid `before`
//   server -> client:
//     {ev:'history', key, items, state, console, info, more}   more = older items not sent yet
//     {ev:'older', key, items, more}
//     {ev:'draft', key, text, at, voice} another viewer changed the unsent text; history carries draft too
//     {ev:'msg', key, m}               raw SDK message (assistant/user/stream_event/result/system)
//     {ev:'state', key, state}         idle | running | requires_action | starting | stopped
//     {ev:'token', key, token}         the session now has a registry token (new or after /clear)
//     {ev:'perm', key, id, tool, input, reason, suggestions}
//     {ev:'perm_done', key, id}
//     {ev:'info', key, info}           model, permissionMode, cwd, slash commands, last cost
//     {ev:'released', key} / {ev:'console', key, active}
//     {ev:'error', key, text}

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
// The environment for Claude sessions: never the web login or the tunnel token (web-serve.js
// already drops them; this keeps a standalone sidecar safe too). CLAUDE_WEB_CHAT tells the
// tmux hook (notify.sh) that this module keeps the session's registry record itself.
function sessionEnv() {
  const e = Object.assign({}, process.env, { CLAUDE_WEB_CHAT: '1' });
  delete e.WEB_TERMINAL_PASSWORD; delete e.NGROK_AUTHTOKEN;
  return e;
}
const { pathToFileURL } = require('url');
let wire = null;   // model traffic recorder (web-wire.js), only when switched on in Settings
try { wire = require(process.env.WEB_WIRE_MODULE || './web-wire.js'); } catch (e) { console.error('wire log disabled:', e.message); }

const MODULES = process.env.WEB_CHAT_MODULES || '/opt/claude-web-chat/node_modules';
// files attached in the chat composer are saved here (one folder per message) and the folder is
// granted to every chat session via additionalDirectories, so Read works without a prompt
const UPLOADS = process.env.WEB_CHAT_UPLOADS || path.join(require('os').homedir(), '.claude', 'web-uploads');
const IMG_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMG_INLINE_MAX = 3.75 * 1024 * 1024;     // the API's 5 MB base64 limit per image
const MAX_FILES = 20;
const IDLE_MIN = parseInt(process.env.WEB_CHAT_IDLE_MINUTES || '60', 10);   // stop idle SDK processes
const WS_ROOT = process.env.WORKSPACE_DIR || '/workspace';

let WebSocketServer = null, sdk = null, loadError = null;
try {
  WebSocketServer = require(path.join(MODULES, 'ws')).WebSocketServer;
} catch (e) { loadError = 'ws module not found: ' + e.message; }
const sdkReady = (async () => {
  if (loadError) return;
  try {
    // The SDK is ESM-only; import it by absolute path (it lives outside the sidecar's module tree).
    // WEB_CHAT_SDK overrides it (used by the tests with a mock SDK).
    const p = process.env.WEB_CHAT_SDK ||
      require.resolve('@anthropic-ai/claude-agent-sdk', { paths: [MODULES] });
    sdk = await import(pathToFileURL(p).href);
  } catch (e) { loadError = 'Agent SDK not available: ' + e.message; }
})();

function log(...a) { console.error('[chat]', ...a); }
function sh(cmd, args) {
  return new Promise((res) => execFile(cmd, args, { maxBuffer: 4 << 20 }, (e, out) => res(e ? null : String(out))));
}
const reg = require('./web-registry.js');
const registry = {
  async get(token) { try { return reg.get(token); } catch (_) { return null; } },
  async upsert(f) {
    try {
      return reg.upsert({ cid: f.cid, cwd: f.cwd, name: f.name, tmux: f.name, state: f.state, title: f.title, mode: 'chat' });
    } catch (e) { log('registry upsert failed:', e.message); return ''; }
  },
};
async function tmuxAlive(name) {
  if (!name) return false;
  return (await sh('tmux', ['has-session', '-t', '=' + name])) !== null;
}

// ---------- async input queue for the SDK's streaming-input mode ----------
class InputQueue {
  constructor() { this.items = []; this.waiters = []; this.done = false; }
  push(v) { const w = this.waiters.shift(); if (w) w({ value: v, done: false }); else this.items.push(v); }
  end() { this.done = true; this.waiters.splice(0).forEach((w) => w({ value: undefined, done: true })); }
  [Symbol.asyncIterator]() {
    return { next: () => this.items.length ? Promise.resolve({ value: this.items.shift(), done: false })
      : this.done ? Promise.resolve({ value: undefined, done: true })
      : new Promise((r) => this.waiters.push(r)) };
  }
}

// ---------- one chat-owned Claude session ----------
const CHATS = new Set();            // all live Chat objects
const BY_CID = new Map();           // claude session id -> Chat
let permSeq = 0, newSeq = 0;

function fmtSize(n) {
  return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
}
// files: [{name, type, data: base64}] from the composer -> UPLOADS/<stamp>/<safe name>
function saveUploads(files) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const dir = path.join(UPLOADS, stamp + '-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(dir, { recursive: true });
  return files.map((f) => {
    let name = path.basename(String(f.name || 'file')).replace(/[\x00-\x1f\/\\:*?"<>|]/g, '_').slice(0, 120) || 'file';
    if (name.startsWith('.')) name = '_' + name;
    let p = path.join(dir, name);
    for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, name.replace(/(\.[^.]*)?$/, `-${i}$1`));
    const buf = Buffer.from(String(f.data || ''), 'base64');
    fs.writeFileSync(p, buf);
    return { path: p, name: path.basename(p), type: String(f.type || ''), size: buf.length, buf };
  });
}

// ---------- unsent drafts ----------
// What is typed in a chat's composer but not sent yet, per registry token, so it survives a
// reload or restart and shows on other devices. A sent message leaves an empty entry with its
// time, so an older copy kept in a browser can't bring the sent text back.
const DRAFT_FILE = process.env.WEB_CHAT_DRAFTS || path.join(require('os').homedir(), '.claude', 'web-drafts.json');
const DRAFT_MAX = 100000, DRAFT_KEEP_MS = 30 * 86400000;
let DRAFTS = {};
try { DRAFTS = JSON.parse(fs.readFileSync(DRAFT_FILE, 'utf8')) || {}; } catch (_) {}
let draftTimer = null;
function saveDrafts() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const now = Date.now();
    for (const k of Object.keys(DRAFTS)) if (!DRAFTS[k] || now - (DRAFTS[k].at || 0) > DRAFT_KEEP_MS) delete DRAFTS[k];
    const tmp = DRAFT_FILE + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(DRAFTS)); fs.renameSync(tmp, DRAFT_FILE); }
    catch (e) { log('drafts: save failed', e.message); }
  }, 1000);
}
// Store a draft and pass it to the session's other viewers (not the one that typed it).
function setDraft(chat, text, from, voice) {
  if (!chat.token) return;
  const d = { text: String(text || '').slice(0, DRAFT_MAX), at: Date.now() };
  if (voice && d.text) d.voice = /^[\w-]{2,12}$/.test(String(voice)) ? String(voice) : 'en-US';   // dictation language
  DRAFTS[chat.token] = d; saveDrafts();
  for (const s of chat.subs) {
    if (from && s.ws === from.ws && s.key === from.key) continue;
    try { s.ws.send(JSON.stringify({ ev: 'draft', key: s.key, text: d.text, at: d.at, voice: d.voice || '' })); } catch (_) {}
  }
}

// ---------- slash command list for the composer's "/" autocomplete ----------
// Kept per folder (project commands and skills differ) plus the latest list as a fallback, and
// saved to disk, so a session whose claude process is not running yet still gets suggestions.
const CMD_FILE = process.env.WEB_CHAT_COMMANDS || path.join(require('os').homedir(), '.claude', 'web-commands.json');
let CMD = { last: [], byCwd: {} };
try { CMD = Object.assign(CMD, JSON.parse(fs.readFileSync(CMD_FILE, 'utf8'))); } catch (_) {}
function rememberCommands(cwd, list) {
  const clean = (Array.isArray(list) ? list : []).filter((c) => c && c.name).slice(0, 500).map((c) => ({
    name: String(c.name).slice(0, 80), description: String(c.description || '').slice(0, 300),
    argumentHint: String(c.argumentHint || '').slice(0, 120), aliases: (c.aliases || []).slice(0, 5).map(String) }));
  if (!clean.length) return cachedCommands(cwd);
  CMD.last = clean; if (cwd) CMD.byCwd[cwd] = clean;
  const keys = Object.keys(CMD.byCwd); if (keys.length > 200) delete CMD.byCwd[keys[0]];
  try { const tmp = CMD_FILE + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(CMD)); fs.renameSync(tmp, CMD_FILE); } catch (_) {}
  return clean;
}
function cachedCommands(cwd) { return (cwd && CMD.byCwd[cwd]) || CMD.last || []; }
// Ask a claude process for the list without sending it anything: it starts, answers
// supportedCommands() (~1 s, no API call, no transcript) and is closed again.
const WARMING = new Set();
async function warmCommands(cwd) {
  if (!cwd || WARMING.has(cwd) || CMD.byCwd[cwd]) return;
  WARMING.add(cwd);
  let stop = null, q = null;
  const never = { [Symbol.asyncIterator]() { return { next: () => new Promise((r) => { stop = () => r({ done: true, value: undefined }); }) }; } };
  const timer = setTimeout(() => { try { q && q.close(); } catch (_) {} }, 30000);
  try {
    await sdkReady; if (!sdk) return;
    q = sdk.query({ prompt: never, options: { cwd, systemPrompt: { type: 'preset', preset: 'claude_code' },
      env: sessionEnv() } });
    if (!q.supportedCommands) return;
    const list = rememberCommands(cwd, await q.supportedCommands());
    for (const c of CHATS) if (c.cwd === cwd && !c.q) { c.info.commandList = list; c.emit({ ev: 'info', info: c.info }); }
  } catch (e) { log('warm commands', cwd, e.message); }
  finally { clearTimeout(timer); if (stop) stop(); try { q && q.close(); } catch (_) {} WARMING.delete(cwd); }
}

class Chat {
  constructor({ cid, cwd, name, token }) {
    this.cid = cid || null; this.cwd = cwd; this.name = name; this.token = token || null;
    this.subs = new Set();            // {ws, key}
    this.state = 'stopped'; this.q = null; this.input = null;
    this.perms = new Map();           // id -> {resolve, tool, input, reason, suggestions}
    this.turn = [];                   // SDK messages of the current turn (for late subscribers)
    this.info = { cwd, model: '', permissionMode: '', commands: [], cost: null, commandList: cachedCommands(cwd) };
    if (!CMD.byCwd[cwd]) warmCommands(cwd);
    this.titled = !!token; this.idleTimer = null; this.closing = null;
    CHATS.add(this); if (this.cid) BY_CID.set(this.cid, this);
  }
  setCommands(list) {
    this.info.commandList = rememberCommands(this.cwd, list);
    this.emit({ ev: 'info', info: this.info });
  }
  emit(obj) {
    for (const s of this.subs) {
      try { s.ws.send(JSON.stringify(Object.assign({ key: s.key }, obj))); } catch (_) {}
    }
  }
  setState(st) {
    if (this.state === st) return;
    this.state = st; this.emit({ ev: 'state', state: st });
    clearTimeout(this.idleTimer);
    if (st === 'idle' && IDLE_MIN > 0) this.idleTimer = setTimeout(() => this.stop(), IDLE_MIN * 60000);
    const reg = { running: 'working', requires_action: 'waiting', idle: 'done' }[st];
    if (reg && this.cid) this.syncRegistry(reg);
  }
  async syncRegistry(state, title) {
    const tok = await registry.upsert({ cid: this.cid, cwd: this.cwd, name: this.name, state, title });
    if (tok && tok !== this.token) { this.token = tok; this.emit({ ev: 'token', token: tok }); }
    if (this.wire) this.wire.update({ token: this.token, cid: this.cid });
  }
  async start() {
    await sdkReady;
    if (!sdk) throw new Error(loadError || 'Agent SDK not loaded');
    if (this.cid && await tmuxAlive(this.name)) throw new Error('This session is open in the console. Switch to chat first (it closes the console).');
    this.input = new InputQueue();
    this.wire = wire ? await wire.begin('chat', this.name, sessionEnv(), { token: this.token, cid: this.cid, cwd: this.cwd })
      : { id: null, env: sessionEnv(), update() {}, finish() {} };
    const options = {
      cwd: this.cwd,
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      canUseTool: (tool, input, o) => this.askPermission(tool, input, o),
      // claude-notify (the tmux hook) must not touch the registry for chat-owned sessions —
      // this module keeps those records itself (see scripts/notify.sh).
      env: this.wire.env,
      additionalDirectories: [UPLOADS],
      stderr: (d) => log(this.name, String(d).trim()),
    };
    try { fs.mkdirSync(UPLOADS, { recursive: true }); } catch (_) {}
    if (this.cid) options.resume = this.cid;
    if (this.desiredMode) options.permissionMode = this.desiredMode;   // picked before the first message
    this.setState('starting');
    this.q = sdk.query({ prompt: this.input, options });
    this.loop();
  }
  async loop() {
    try {
      for await (const m of this.q) this.onMessage(m);
    } catch (e) {
      log(this.name, 'query failed:', e && e.message);
      this.emit({ ev: 'error', text: String((e && e.message) || e) });
    }
    this.q = null; this.input = null; this.turn = [];
    if (this.wire) { this.wire.finish({ cid: this.cid, token: this.token }); this.wire = null; }
    for (const [id, p] of this.perms) { p.resolve({ behavior: 'deny', message: 'session stopped' }); this.emit({ ev: 'perm_done', id }); }
    this.perms.clear();
    this.setState('stopped');
    if (this.cid && BY_CID.get(this.cid) === this) BY_CID.delete(this.cid);
    if (!this.subs.size) CHATS.delete(this);
    if (this.closing) { this.closing(); this.closing = null; }
  }
  onMessage(m) {
    if (m.type === 'system' && m.subtype === 'init') {
      if (m.session_id && m.session_id !== this.cid) {        // new session, or a fork on resume
        if (this.cid && BY_CID.get(this.cid) === this) BY_CID.delete(this.cid);
        this.cid = m.session_id; BY_CID.set(this.cid, this);
        this.syncRegistry('working', this.titled ? '' : this.pendingTitle);
        this.titled = true;
      }
      this.info = Object.assign(this.info, { model: m.model, permissionMode: m.permissionMode,
        cwd: m.cwd || this.cwd, commands: m.slash_commands || [] });
      this.emit({ ev: 'info', info: this.info });
      // names come with init; descriptions and argument hints need one more call
      const q = this.q;
      if (q && q.supportedCommands) q.supportedCommands().then((list) => this.setCommands(list), (e) => log('commands', e.message));
      return;
    }
    if (m.type === 'system' && m.subtype === 'commands_changed' && Array.isArray(m.commands)) {
      this.setCommands(m.commands); return;
    }
    if (m.type === 'system' && m.subtype === 'session_state_changed') { this.setState(m.state); return; }
    if (m.type === 'system' && m.subtype === 'status' && m.permissionMode) {
      this.info.permissionMode = m.permissionMode; this.emit({ ev: 'info', info: this.info });
    }
    if (m.type === 'result') {
      this.info.cost = m.total_cost_usd; this.emit({ ev: 'info', info: this.info });
      measureCtx(this);
      this.turn = [];
      this.emit({ ev: 'msg', m });
      if (this.state !== 'requires_action') this.setState('idle');
      return;
    }
    // task_* frames: skills such as /code-review run as a forked sub-agent; the launcher shows
    // them as one collapsible block that collects the sub-agent's tool calls
    if (m.type === 'assistant' || m.type === 'user' || m.type === 'stream_event' ||
        (m.type === 'system' && ['local_command_output', 'compact_boundary', 'task_started', 'task_progress', 'task_notification'].includes(m.subtype))) {
      const working = m.type !== 'system' || m.subtype === 'task_started';
      if (this.state !== 'running' && this.state !== 'requires_action' && working) this.setState('running');
      if (m.type !== 'stream_event') { if (!m.ts) m.ts = Date.now(); this.turn.push(m); }   // when it arrived, for the chat's time stamps
      this.emit({ ev: 'msg', m });
    }
  }
  askPermission(tool, input, o) {
    return new Promise((resolve) => {
      const id = 'p' + (++permSeq);
      const p = { resolve, tool, input, reason: o && o.decisionReason, suggestions: (o && o.suggestions) || [] };
      this.perms.set(id, p);
      this.setState('requires_action');
      this.emit({ ev: 'perm', id, tool, input, reason: p.reason, suggestions: p.suggestions.length > 0 });
      p.done = () => {
        this.perms.delete(id); this.emit({ ev: 'perm_done', id });
        if (!this.perms.size && this.q) this.setState('running');   // the turn continues
      };
      if (o && o.signal) o.signal.addEventListener('abort', () => {
        if (!this.perms.has(id)) return;
        resolve({ behavior: 'deny', message: 'cancelled' }); p.done();
      });
    });
  }
  answer(id, msg) {
    const p = this.perms.get(id); if (!p) return;
    if (p.tool === 'AskUserQuestion' && msg.answers) {
      p.resolve({ behavior: 'allow', updatedInput: Object.assign({}, p.input, { answers: msg.answers }) });
    } else if (msg.allow) {
      const r = { behavior: 'allow', updatedInput: p.input };
      if (msg.always && p.suggestions.length) r.updatedPermissions = p.suggestions;
      p.resolve(r);
    } else {
      p.resolve({ behavior: 'deny', message: msg.message || 'The user denied this action.' });
    }
    p.done();
  }
  async send(text, files) {
    const saved = files && files.length ? saveUploads(files) : [];
    if (!this.titled && !this.pendingTitle) {
      this.pendingTitle = (text.replace(/\s+/g, ' ').trim() || (saved[0] && saved[0].name) || '').slice(0, 80);
    }
    let content = text;
    if (saved.length) {
      // images also go inline so Claude sees them right away; every file is listed by path.
      // The "[Attached files]" block is parsed back by the launcher to show attachment chips.
      content = saved.filter((f) => IMG_TYPES.has(f.type) && f.size <= IMG_INLINE_MAX).map((f) =>
        ({ type: 'image', source: { type: 'base64', media_type: f.type, data: f.buf.toString('base64') } }));
      const list = '[Attached files]\n' + saved.map((f) => `- ${f.path} (${f.name}, ${fmtSize(f.size)})`).join('\n');
      content.push({ type: 'text', text: (text.trim() ? text.replace(/\s+$/, '') + '\n\n' : '') + list });
    }
    if (!this.q) await this.start();
    clearTimeout(this.idleTimer);
    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
  }
  async interrupt() { if (this.q) { try { await this.q.interrupt(); } catch (e) { log('interrupt', e.message); } } }
  async setMode(mode) {
    if (!['default', 'acceptEdits', 'plan', 'auto'].includes(mode)) return;
    this.desiredMode = mode;
    if (this.q) await this.q.setPermissionMode(mode);
    this.info.permissionMode = mode; this.emit({ ev: 'info', info: this.info });
  }
  stop() {
    if (!this.q) return Promise.resolve();
    return new Promise((res) => {
      this.closing = res;
      try { this.input.end(); } catch (_) {}
      try { this.q.close(); } catch (_) {}
      setTimeout(() => { if (this.closing) { this.closing(); this.closing = null; } }, 5000);
    });
  }
}

// ---------- context fill ----------
// How full each session's context window is, shown as a ring in the chat's status line. Measured
// with getContextUsage('summary') after every turn (no API call: last answer's usage plus local
// estimates) and kept per session id, so a session that is not running still shows its last value.
const CTX_FILE = process.env.WEB_CHAT_CONTEXT || path.join(require('os').homedir(), '.claude', 'web-context.json');
let CTX = {}; try { CTX = JSON.parse(fs.readFileSync(CTX_FILE, 'utf8')) || {}; } catch (_) {}
let ctxTimer = null;
function saveCtx() {
  clearTimeout(ctxTimer);
  ctxTimer = setTimeout(() => {
    const keys = Object.keys(CTX).filter((k) => k !== '_max').sort((a, b) => (CTX[b].at || 0) - (CTX[a].at || 0));
    for (const k of keys.slice(500)) delete CTX[k];
    try { fs.writeFileSync(CTX_FILE + '.tmp', JSON.stringify(CTX)); fs.renameSync(CTX_FILE + '.tmp', CTX_FILE); } catch (e) { log('context save', e.message); }
  }, 1000);
}
async function measureCtx(chat) {
  if (!chat.q || typeof chat.q.getContextUsage !== 'function' || !chat.cid) return;
  try {
    const u = await chat.q.getContextUsage({ detail: 'summary' });
    // the control reply is camelCase (SDKControlGetContextUsageResponse)
    const max = u && (u.rawMaxTokens || u.maxTokens), total = u && u.totalTokens;
    if (!max || total == null) { log(chat.name, 'context usage: unexpected reply', Object.keys(u || {}).join(',')); return; }
    const c = { total, max, pct: u.percentage != null ? Math.round(u.percentage) : Math.round(total / max * 100), model: u.model || '', at: Date.now(),
      cats: (u.categories || []).filter((k) => k.kind !== 'free' && k.tokens > 0).map((k) => ({ name: k.name, tokens: k.tokens, kind: k.kind })) };
    CTX[chat.cid] = c; CTX._max = c.max; saveCtx();
    chat.info.context = c; chat.emit({ ev: 'info', info: chat.info });
  } catch (e) { log(chat.name, 'context usage', e.message); }
}
// Before the first measurement: an estimate from the last main-loop answer's usage in the transcript.
function estimateCtx(items) {
  for (let k = items.length - 1; k >= 0; k--) {
    const i = items[k], u = i.type === 'assistant' && !i.parent_tool_use_id && i.message && i.message.usage;
    if (!u || !u.input_tokens && !u.cache_read_input_tokens) continue;
    const total = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    const max = CTX._max || null;
    return { total, max, pct: max ? Math.round(total / max * 100) : null, estimated: true, cats: [] };
  }
  return null;
}

// ---------- history ----------
async function history(chat) {
  if (!chat.cid) return [];
  await sdkReady;
  let items = [];
  try { items = sdk ? await sdk.getSessionMessages(chat.cid, { dir: chat.cwd }) : []; }
  catch (e) { log('history', e.message); }
  // add what the SDK has streamed this turn but the transcript doesn't have yet
  const seen = new Set(items.map((i) => i.uuid));
  for (const m of chat.turn) if (!seen.has(m.uuid)) items.push(m);
  const out = [], { extra, times } = transcriptExtras(chat);
  for (const i of items) {
    if (i.type !== 'user' && i.type !== 'assistant') continue;
    const ts = i.ts || times.get(i.uuid) || 0;
    out.push({ type: i.type, uuid: i.uuid, message: i.message, parent_tool_use_id: i.parent_tool_use_id || null, ts: ts || undefined });
    for (const x of extra.get(i.uuid) || []) out.push(x);
  }
  return out;
}
// History is sent in pages so a long conversation doesn't flood the browser: the last
// PAGE_PROMPTS user prompts with everything after them, then older pages on request.
const PAGE_PROMPTS = 5;
function isPrompt(i) {
  if (i.type !== 'user' || i.parent_tool_use_id) return false;
  const c = i.message && i.message.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some((b) => b && (b.type === 'text' || b.type === 'image')) &&
    !c.some((b) => b && b.type === 'tool_result');
}
// Index where the page ending right before `end` starts (a prompt boundary, or 0).
function pageStart(items, end) {
  let n = 0;
  for (let k = end - 1; k >= 0; k--) if (isPrompt(items[k]) && ++n === PAGE_PROMPTS) return k;
  return 0;
}
// Output of slash commands and skills (/code-review, /cost, …) is saved in the transcript as
// {type:'system', subtype:'local_command', parentUuid, content:'<local-command-stdout>…'}, which
// getSessionMessages leaves out. Returns { extra: parentUuid -> [local_command_output messages],
// times: uuid -> when the message was written (ms) }; getSessionMessages has no timestamps either.
// A transcript line starts with its own fields, so the first "uuid":…,"timestamp":… pair is the message's.
const UUID_TS = /"uuid":"([^"]+)","timestamp":"([^"]+)"/;
function transcriptExtras(chat) {
  const map = new Map(), times = new Map();
  const f = chat.cid && transcriptPath(chat.cid, chat.cwd);
  let text = '';
  try { if (f) text = fs.readFileSync(f, 'utf8'); } catch (_) {}
  for (const l of text.split('\n')) {
    const t = UUID_TS.exec(l);
    if (t) { const ms = Date.parse(t[2]); if (ms) times.set(t[1], ms); }
    if (!l.includes('"local_command"')) continue;
    let e; try { e = JSON.parse(l); } catch (_) { continue; }
    if (e.type !== 'system' || e.subtype !== 'local_command' || e.isSidechain) continue;
    const c = String(e.content || '').replace(/<\/?local-command-std(out|err)>/g, '').trim();
    if (!c) continue;
    const k = e.parentUuid || '';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ type: 'system', subtype: 'local_command_output', uuid: e.uuid, content: c });
  }
  return { extra: map, times };
}

// ---------- per-socket handling ----------
function sanitizeName(s) { return String(s || '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'chat'; }
// Launch directory of a transcript: the registry stores Claude's CURRENT cwd (it drifts deeper
// as the session cd-s around), while the transcript lives in the project dir of the LAUNCH
// directory — the same mismatch the console resume walks up for (web-menu.sh resume_cwd). Without
// this, getSessionMessages({dir}) finds nothing and an old session opens empty.
function launchDir(cid, cwd) {
  const enc = (d) => String(d).replace(/[^a-zA-Z0-9]/g, '-');
  const has = (d) => { try { return fs.existsSync(path.join(PROJECTS, enc(d), cid + '.jsonl')); } catch (_) { return false; } };
  if (!cwd || has(cwd)) return cwd;
  for (let d = path.dirname(cwd); d && d !== path.parse(d).root; d = path.dirname(d)) if (has(d)) return d;
  return cwd;
}

async function chatFor(msg) {
  if (msg.token) {
    const rec = await registry.get(msg.token);
    if (!rec) throw new Error('unknown session');
    const ex = BY_CID.get(rec.claudeSessionId);
    if (ex) return ex;
    for (const c of CHATS) if (c.token === msg.token) return c;
    return new Chat({ cid: rec.claudeSessionId, cwd: launchDir(rec.claudeSessionId, rec.cwd) || rec.cwd,
      name: rec.tmuxSession || rec.name || ('chat-' + msg.token), token: msg.token });
  }
  const cwd = msg.cwd && path.resolve(msg.cwd);
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('folder not found: ' + msg.cwd);
  return new Chat({ cwd, name: 'chat-' + sanitizeName(path.basename(cwd)) + '-' + Date.now().toString(36).slice(-4) + (++newSeq) });
}

function onConnection(ws) {
  const mine = new Map();      // key -> Chat
  const reply = (o) => { try { ws.send(JSON.stringify(o)); } catch (_) {} };
  // Handle a socket's messages strictly in order: 'open' is async (registry + history), and the
  // ops that follow it (send/takeover/...) must see the session it opened.
  let chain = Promise.resolve();
  ws.on('message', (raw) => { chain = chain.then(() => handle(raw)).catch((e) => log('ws op failed:', e && e.message)); });
  async function handle(raw) {
    let msg; try { msg = JSON.parse(String(raw)); } catch (_) { return; }
    const key = String(msg.key || '');
    try {
      if (msg.op === 'open') {
        let chat = mine.get(key);
        if (!chat) { chat = await chatFor(msg); mine.set(key, chat); chat.subs.add({ ws, key }); }
        const all = await history(chat), start = pageStart(all, all.length), items = all.slice(start);
        if (!chat.info.context) chat.info.context = (chat.cid && CTX[chat.cid]) || estimateCtx(all);
        const pend = [...chat.perms].map(([id, p]) => ({ id, tool: p.tool, input: p.input, reason: p.reason, suggestions: p.suggestions.length > 0 }));
        reply({ ev: 'history', key, items, state: chat.state, console: !chat.q && await tmuxAlive(chat.name),
                info: chat.info, perms: pend, token: chat.token, more: start,
                draft: (chat.token && DRAFTS[chat.token]) || null });
        return;
      }
      if (msg.op === 'older') {
        const chat = mine.get(key);
        if (!chat) { reply({ ev: 'older', key, items: [], more: 0 }); return; }
        const all = await history(chat), end = all.findIndex((i) => i.uuid === msg.before);
        if (end < 0) { reply({ ev: 'older', key, items: [], more: 0, lost: true }); return; }
        const start = pageStart(all, end);
        reply({ ev: 'older', key, items: all.slice(start, end), more: start });
        return;
      }
      let chat = mine.get(key);
      // Self-healing: after a reconnect or a server restart an op can arrive for a key whose
      // open was lost (the client only re-sends 'open' on its own socket reconnect). If the op
      // carries an identity, just open the session here instead of dead-ending the pane.
      if (!chat && (msg.token || msg.cwd)) {
        chat = await chatFor(msg); mine.set(key, chat); chat.subs.add({ ws, key });
      }
      if (!chat) { reply({ ev: 'error', key, text: 'session not open' }); return; }
      switch (msg.op) {
        case 'close':
          for (const s of chat.subs) if (s.ws === ws && s.key === key) chat.subs.delete(s);
          mine.delete(key);
          if (!chat.subs.size && !chat.q) CHATS.delete(chat);
          break;
        case 'send': {
          const files = Array.isArray(msg.files) ? msg.files.slice(0, MAX_FILES) : [];
          if ((msg.text && String(msg.text).trim()) || files.length) {
            setDraft(chat, '', { ws, key });
            await chat.send(String(msg.text || ''), files);
          }
          break;
        }
        case 'draft': setDraft(chat, msg.text, { ws, key }, msg.voice || ''); break;
        case 'interrupt': await chat.interrupt(); break;
        case 'perm': chat.answer(msg.id, msg); break;
        case 'mode': await chat.setMode(String(msg.mode)); break;
        case 'release': await chat.stop(); reply({ ev: 'released', key }); break;
        case 'takeover':
          if (await tmuxAlive(chat.name)) {
            await sh('tmux', ['kill-session', '-t', '=' + chat.name]);      // SIGHUP -> Claude flushes
            for (let i = 0; i < 25 && await tmuxAlive(chat.name); i++) await new Promise((r) => setTimeout(r, 200));
            await new Promise((r) => setTimeout(r, 400));
          }
          reply({ ev: 'console', key, active: false });
          break;
      }
    } catch (e) {
      reply({ ev: 'error', key, text: String((e && e.message) || e) });
    }
  }
  ws.on('close', () => {
    for (const [key, chat] of mine) {
      for (const s of chat.subs) if (s.ws === ws && s.key === key) chat.subs.delete(s);
      if (!chat.subs.size && !chat.q) CHATS.delete(chat);
    }
    mine.clear();
  });
}

let wss = null;
function handleUpgrade(req, socket, head) {
  if (!WebSocketServer) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
  if (!wss) { wss = new WebSocketServer({ noServer: true, maxPayload: 48 << 20 }); wss.on('connection', onConnection); }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}

// ---------- session titles from the transcript ----------
// Claude Code keeps a session's name in its JSONL: `custom-title` (set by /rename or the
// sidebar's Rename) and `ai-title` (auto-generated). The registry only has what the hooks saw
// (the first prompt / terminal title), so the sidebar label is resolved from the transcript.
// Transcripts are append-only, so we cache per file and only read the bytes added since last time.
const HOME = process.env.HOME || '/home/node';
const PROJECTS = path.join(HOME, '.claude', 'projects');
const TITLES = new Map();          // cid -> {file, size, custom, ai}
function transcriptPath(cid, cwd) {
  const guess = path.join(PROJECTS, String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-'), cid + '.jsonl');
  if (fs.existsSync(guess)) return guess;
  try {
    for (const d of fs.readdirSync(PROJECTS)) {
      const f = path.join(PROJECTS, d, cid + '.jsonl'); if (fs.existsSync(f)) return f;
    }
  } catch (_) {}
  return null;
}
const TITLE_RE = /"type":"(custom-title|ai-title)","(?:customTitle|aiTitle)":"((?:[^"\\]|\\.)*)"/g;
function sessionTitles(cid, cwd) {
  if (!cid) return null;
  let t = TITLES.get(cid);
  if (!t || !t.file) { t = { file: transcriptPath(cid, cwd), size: 0, custom: '', ai: '' }; TITLES.set(cid, t); }
  if (!t.file) { TITLES.delete(cid); return null; }
  let st; try { st = fs.statSync(t.file); } catch (_) { TITLES.delete(cid); return null; }
  if (st.size < t.size) { t.size = 0; t.custom = ''; t.ai = ''; }              // rewritten
  if (st.size > t.size) {
    const fd = fs.openSync(t.file, 'r');
    try {
      const start = Math.max(0, t.size - 1024);                                 // overlap: a line cut last time
      const buf = Buffer.alloc(st.size - start); fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString('utf8'); let m; TITLE_RE.lastIndex = 0;
      while ((m = TITLE_RE.exec(text))) {
        let v; try { v = JSON.parse('"' + m[2] + '"'); } catch (_) { v = m[2]; }
        if (m[1] === 'custom-title') t.custom = v; else t.ai = v;
      }
    } finally { fs.closeSync(fd); }
    t.size = st.size;
  }
  return t;
}

async function rename(token, title) {
  title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!title) throw new Error('empty title');
  const rec = await registry.get(token);
  if (!rec || !rec.claudeSessionId) throw new Error('unknown session');
  await sdkReady;
  if (sdk && sdk.renameSession) {
    await sdk.renameSession(rec.claudeSessionId, title, { dir: rec.cwd });
  } else {                                                                      // SDK unavailable: same entry by hand
    const f = transcriptPath(rec.claudeSessionId, rec.cwd);
    if (!f) throw new Error('transcript not found');
    fs.appendFileSync(f, JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: rec.claudeSessionId }) + '\n');
  }
  return title;
}

// Overlay live chat state and transcript titles onto the registry list (registry only knows tmux).
function decorate(rows) {
  rows = rows.map((r) => {
    const t = sessionTitles(r.claudeSessionId, r.cwd);
    const title = (t && (t.custom || t.ai)) || r.title;
    return title === r.title ? r : Object.assign({}, r, { title });
  });
  return rows.map((r) => {
    const c = BY_CID.get(r.claudeSessionId);
    if (c && c.q) {
      const st = { running: 'working', requires_action: 'waiting', idle: 'done', starting: 'working' }[c.state] || r.state;
      return Object.assign({}, r, { live: true, mode: 'chat', state: st });
    }
    return Object.assign({}, r, { mode: r.live ? 'console' : (r.mode || 'console') });
  });
}

// Workspace folders for the "new chat" picker, most recently modified first.
function dirs() {
  let out = [];
  try {
    out = fs.readdirSync(WS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => { const p = path.join(WS_ROOT, d.name); let t = 0; try { t = fs.statSync(p).mtimeMs; } catch (_) {} return { path: p, name: d.name, mtime: t }; })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) {}
  return [{ path: WS_ROOT, name: path.basename(WS_ROOT) + ' (root)', mtime: 0 }].concat(out);
}

async function stopByToken(token) {
  for (const c of CHATS) if (c.token === token) await c.stop();
}

async function info() { await sdkReady; return { enabled: !!sdk, error: loadError }; }

// ---------- resume /loop-style sessions after a restart ----------
// A self-paced loop lives in the claude process: each tick ends with ScheduleWakeup(delay, prompt)
// and that timer dies with the process (container restart, sidecar crash). On startup, look at the
// chat sessions active in the last few hours: if a session's last ScheduleWakeup was not a stop,
// re-send its prompt when the wakeup was due (or shortly after startup if it is overdue).
const RESUME_LOOPS = process.env.WEB_RESUME_LOOPS !== '0';
const RESUME_MAX_H = parseFloat(process.env.WEB_RESUME_LOOPS_MAX_HOURS || '12');
const REGISTRY_FILE = process.env.CLAUDE_WEB_REGISTRY || path.join(HOME, '.claude', 'web-sessions.json');
const TAIL_BYTES = 4 << 20;

// last ScheduleWakeup tool call in a transcript: {prompt, delay, stop, at(ms)} or null
function lastWakeup(file) {
  let buf;
  try {
    const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES); buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
  } catch (_) { return null; }
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"ScheduleWakeup"') || !l.startsWith('{"')) continue;
    let e; try { e = JSON.parse(l); } catch (_) { continue; }
    if (e.type !== 'assistant' || e.isSidechain) continue;              // skip api-request blobs, subagents
    const c = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (let j = c.length - 1; j >= 0; j--) {
      const b = c[j];
      if (b.type === 'tool_use' && b.name === 'ScheduleWakeup') {
        const inp = b.input || {};
        return { prompt: String(inp.prompt || ''), delay: Number(inp.delaySeconds) || 0, stop: !!inp.stop, at: Date.parse(e.timestamp) || 0 };
      }
    }
  }
  return null;
}

async function resumeLoops() {
  await sdkReady;
  if (!sdk || !RESUME_LOOPS) return;
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); } catch (_) { return; }
  const now = Date.now(), maxAge = RESUME_MAX_H * 3600e3;
  const seen = new Set();
  const recs = Object.values(reg).filter((r) => r && r.claudeSessionId && r.mode === 'chat')
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  for (const r of recs) {
    if (seen.has(r.claudeSessionId)) continue; seen.add(r.claudeSessionId);
    if (r.lastActivity && now - r.lastActivity * 1000 > maxAge) continue;
    const file = transcriptPath(r.claudeSessionId, r.cwd); if (!file) continue;
    const w = lastWakeup(file);
    if (!w || w.stop || !w.prompt || /^<<autonomous-loop/.test(w.prompt) || now - w.at > maxAge) continue;
    const due = Math.max(w.at + w.delay * 1000, now + 20000);
    log('loop resume:', r.token, path.basename(r.cwd || ''), 'in', Math.round((due - now) / 1000) + 's');
    setTimeout(() => fireLoop(r, w.prompt).catch((e) => log('loop resume failed', r.token, e.message)), due - now);
  }
}
async function fireLoop(r, prompt) {
  let chat = BY_CID.get(r.claudeSessionId);
  if (!chat) for (const c of CHATS) if (c.token === r.token) chat = c;
  if (chat && chat.q) { log('loop resume skipped (session already running):', r.token); return; }
  const name = r.tmuxSession || r.name || ('chat-' + r.token);
  if (await tmuxAlive(name)) { log('loop resume skipped (open in console):', r.token); return; }
  if (!chat) chat = new Chat({ cid: r.claudeSessionId, cwd: r.cwd, name, token: r.token });
  await chat.send(prompt);
  log('loop resumed:', r.token);
}
setTimeout(() => resumeLoops().catch((e) => log('resumeLoops', e.message)), 5000);
setTimeout(() => { if (!CMD.last.length) warmCommands(WS_ROOT); }, 8000);

// ---------- headless API (cb-session) ----------
// Lets an agent start chat sessions that run on their own (e.g. one review per PR) and poll
// them. They are ordinary chat sessions: listed in the sidebar, open and continue like any other.
async function apiNew(o) {
  await sdkReady;
  if (!sdk) throw new Error(loadError || 'Agent SDK not loaded');
  const prompt = String((o && o.prompt) || '').trim();
  if (!prompt) throw new Error('prompt is required');
  const chat = await chatFor({ cwd: o.cwd });
  if (o.mode) await chat.setMode(String(o.mode));
  if (o.title) chat.pendingTitle = String(o.title).slice(0, 80);
  await chat.send(prompt);
  for (let i = 0; i < 300 && !chat.token; i++) await new Promise((r) => setTimeout(r, 100));   // init -> registry
  if (!chat.token) throw new Error('session did not start in 30s');
  return { token: chat.token, cid: chat.cid, cwd: chat.cwd };
}
// state: running | requires_action | idle | starting | stopped | unknown (+ the last answer text)
async function apiStatus(token) {
  const rec = await registry.get(token);
  let chat = rec && BY_CID.get(rec.claudeSessionId);
  if (!chat) for (const c of CHATS) if (c.token === token) chat = c;
  if (!rec && !chat) throw new Error('unknown session');
  const out = { token, cid: (chat && chat.cid) || rec.claudeSessionId, cwd: (chat && chat.cwd) || rec.cwd,
    live: !!(chat && chat.q), state: chat ? chat.state : 'stopped', cost: chat ? chat.info.cost : null,
    pending: chat ? [...chat.perms.values()].map((p) => p.tool) : [] };
  if (out.cid && sdk) {
    try {
      const items = await sdk.getSessionMessages(out.cid, { dir: out.cwd });
      for (let i = items.length - 1; i >= 0; i--) {
        const m = items[i], c = m.type === 'assistant' && m.message && m.message.content;
        const t = Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
        if (t && !m.parent_tool_use_id) { out.last = t.slice(-4000); break; }
      }
    } catch (_) {}
  }
  return out;
}

async function getSdk() { await sdkReady; return sdk; }

// ---------- for the Inbox coordinator (web-inbox.js) ----------
function chatByToken(rec, token) {
  let c = rec && BY_CID.get(rec.claudeSessionId);
  if (!c) for (const x of CHATS) if (x.token === token) c = x;
  return c || null;
}
// Permission / question requests a chat session is waiting on.
async function pendingPerms(token) {
  const c = chatByToken(await registry.get(token), token);
  return c ? [...c.perms].map(([id, p]) => ({ id, tool: p.tool, input: p.input })) : [];
}
async function answerPerm(token, id, allow) {
  const c = chatByToken(await registry.get(token), token);
  if (!c || !c.perms.has(id)) throw new Error('that request is no longer pending');
  c.answer(id, { allow: !!allow });
}
// Send a user message: into the console when the session is open there, else as chat (resumes it).
async function sendTo(token, text) {
  text = String(text || '').trim();
  if (!text) throw new Error('empty message');
  const rec = await registry.get(token);
  if (!rec || !rec.claudeSessionId) throw new Error('unknown session');
  let c = chatByToken(rec, token);
  const name = rec.tmuxSession || rec.name || ('chat-' + token);
  if (!(c && c.q) && await tmuxAlive(name)) {
    if (await sh('tmux', ['send-keys', '-t', '=' + name + ':', '-l', text.replace(/\s*\n\s*/g, ' ')]) === null ||
        await sh('tmux', ['send-keys', '-t', '=' + name + ':', 'Enter']) === null) throw new Error('could not type into the console');
    return { via: 'console' };
  }
  await sdkReady;
  if (!sdk) throw new Error(loadError || 'Agent SDK not loaded');
  if (!c) c = new Chat({ cid: rec.claudeSessionId, cwd: rec.cwd, name, token });
  await c.send(text);
  return { via: 'chat' };
}

module.exports = { launchDir, handleUpgrade, decorate, dirs, stopByToken, info, rename, apiNew, apiStatus, getSdk,
  pendingPerms, answerPerm, sendTo, transcriptPath };
