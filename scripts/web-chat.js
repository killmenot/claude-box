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
//     {op:'open', key, cwd, title}     a new session; title = its name (kept like /rename)
//     {op:'model', key, model}         "provider/model id" (web-models.js): same provider switches
//                                      live; another provider restarts the process and resumes
//     {op:'release', key}              stop the chat process (before switching to console)
//     {op:'takeover', key}             kill the console tmux session (before switching to chat)
//     {op:'draft', key, text, voice}   the unsent composer text (kept per session, sent to other viewers);
//                                      voice: the dictation language when part of it was dictated
//     {op:'older', key, before}        an older page of history, ending before message uuid `before`
//     {op:'stats', key, kind, req}     the data behind /context or /usage (kind) for the launcher's dialog
//   server -> client:
//     {ev:'history', key, items, state, console, info, more}   more = older items not sent yet
//     {ev:'older', key, items, more}
//     {ev:'draft', key, text, at, voice} another viewer changed the unsent text; history carries draft too
//     {ev:'msg', key, m}               raw SDK message (assistant/user/stream_event/result/system)
//     {ev:'state', key, state}         idle | running | requires_action | starting | stopped
//     {ev:'token', key, token}         the session now has a registry token (new or after /clear)
//     {ev:'perm', key, id, tool, input, reason, suggestions}
//     {ev:'perm_done', key, id}
//     {ev:'info', key, info}           model, modelRef, permissionMode, cwd, slash commands, last cost
//     {ev:'stats', key, kind, req, live, data, baseline?, error?}   data null: not available, send the command instead
//     {ev:'stats', key, kind:'usage', req, part:'behaviors', behaviors}   the slower second half of /usage
//     {ev:'released', key} / {ev:'console', key, active}
//     {ev:'error', key, text}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
let tasksMod = null; // task folders: their repos join the session as extra directories (web-tasks.js)
try { tasksMod = require(process.env.WEB_TASKS_MODULE || './web-tasks.js'); } catch (e) { console.error('task repos disabled:', e.message); }
function taskDirs(cwd) { try { return tasksMod ? tasksMod.taskRepoDirs(cwd) : []; } catch (_) { return []; } }
let models = null;   // providers and per-session models (web-models.js)
try { models = require(process.env.WEB_MODELS_MODULE || './web-models.js'); } catch (e) { console.error('models disabled:', e.message); }
const registry = {
  async get(token) { try { return reg.get(token); } catch (_) { return null; } },
  async upsert(f) {
    try {
      return reg.upsert({ cid: f.cid, cwd: f.cwd, name: f.name, tmux: f.name, state: f.state, title: f.title, mode: 'chat', model: f.model });
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
// ---------- model list for the composer's model picker ----------
// supportedModels() of a claude process; the same for every folder, so one list, saved to disk.
const MODELS_FILE = process.env.WEB_CHAT_MODELS || path.join(require('os').homedir(), '.claude', 'web-models.json');
let MODELS = []; try { MODELS = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')) || []; } catch (_) {}
let modelsFresh = false;           // asked a claude process since this server started
let defaultEffort = null;          // the effort a fresh session gets (settings, model default), from the probe
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
function rememberModels(list) {
  const clean = (Array.isArray(list) ? list : []).filter((m) => m && m.value).slice(0, 50).map((m) => ({
    value: String(m.value).slice(0, 120), resolvedModel: m.resolvedModel ? String(m.resolvedModel).slice(0, 120) : '',
    displayName: String(m.displayName || m.value).slice(0, 80), description: String(m.description || '').slice(0, 200),
    efforts: m.supportsEffort && Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((e) => EFFORTS.includes(e)) : [] }));
  if (!clean.length) return MODELS;
  modelsFresh = true;
  if (JSON.stringify(clean) === JSON.stringify(MODELS)) return MODELS;
  MODELS = clean;
  try { const tmp = MODELS_FILE + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(MODELS)); fs.renameSync(tmp, MODELS_FILE); } catch (_) {}
  for (const c of CHATS) { c.info.models = MODELS; c.emit({ ev: 'info', info: c.info }); }
  return MODELS;
}
// A claude process that is never sent a prompt: it answers control requests (supportedCommands,
// getContextUsage, …) with no API call and no transcript of its own, and is closed after `fn`.
// Never with `resume`: a resumed process appends a cost-state record (zeroed totals) to the
// session's transcript even when nothing is sent.
async function withProbe(cwd, fn, ms = 30000) {
  assertDir(cwd);
  await sdkReady;
  if (!sdk) throw new Error(loadError || 'Agent SDK not loaded');
  let stop = null, q = null;
  const never = { [Symbol.asyncIterator]() { return { next: () => new Promise((r) => { stop = () => r({ done: true, value: undefined }); }) }; } };
  const timer = setTimeout(() => { try { q && q.close(); } catch (_) {} }, ms);
  try {
    q = sdk.query({ prompt: never, options: { cwd, systemPrompt: { type: 'preset', preset: 'claude_code' }, env: sessionEnv() } });
    return await fn(q);
  } finally { clearTimeout(timer); if (stop) stop(); try { q && q.close(); } catch (_) {} }
}
// A missing cwd makes the claude spawn fail with ENOENT, which the SDK reports as a libc mismatch
// ("native binary … exists but failed to launch"). Say what is actually wrong instead.
function assertDir(cwd) {
  let ok = false;
  try { ok = !cwd || fs.statSync(cwd).isDirectory(); } catch (_) {}
  if (!ok) throw new Error(`The session's folder ${cwd} no longer exists. Create it again (mkdir -p ${cwd}) to continue the session; its history is kept.`);
}
// Ask a claude process for the lists without sending it anything: it starts, answers
// supportedCommands() / supportedModels() (~1 s) and is closed again.
const WARMING = new Set();
// Warmups run ONE at a time: each spawns a full `claude` process (all MCP servers start with it),
// and a burst of those on parallel session opens stole CPU from the whole server (UI-wide stalls).
const WARM_QUEUE = [];
async function warmCommands(cwd) {
  if (!cwd || WARMING.has(cwd) || (CMD.byCwd[cwd] && modelsFresh) || WARM_QUEUE.includes(cwd)) return;
  if (WARMING.size > 0) { WARM_QUEUE.push(cwd); return; }   // wait for the current warmup + 3 s spacing
  WARMING.add(cwd);
  try {
    await sdkReady; if (!sdk) return;
    await withProbe(cwd, (q) => warmFrom(q, cwd));
  } catch (e) { log('warm commands', cwd, e.message); }
  finally {
    WARMING.delete(cwd);
    const next = WARM_QUEUE.shift();
    if (next) setTimeout(() => warmCommands(next).catch(() => {}), 3000);   // spacing between claude spawns
  }
}
async function warmFrom(q, cwd) {
  if (q.supportedModels && !modelsFresh) rememberModels(await q.supportedModels());
  if (q.getSettings && defaultEffort == null) {
    const a = (await q.getSettings() || {}).applied;
    if (a && a.effort) {
      defaultEffort = a.effort;
      for (const c of CHATS) if (!c.q && !c.desiredEffort && !c.info.effort) { c.info.effort = defaultEffort; c.emit({ ev: 'info', info: c.info }); }
    }
  }
  if (!q.supportedCommands || CMD.byCwd[cwd]) return;
  const list = rememberCommands(cwd, await q.supportedCommands());
  for (const c of CHATS) if (c.cwd === cwd && !c.q) { c.info.commandList = list; c.emit({ ev: 'info', info: c.info }); }
}

// ---------- sub-agents ----------
const AGENT_TOOLS = new Set(['Agent', 'Task']);
// Totals Claude Code appends to an agent's result or task-notification, in either spelling:
//   <usage>subagent_tokens: 26451\ntool_uses: 1\nduration_ms: 14821</usage>
//   <usage><subagent_tokens>97313</subagent_tokens><tool_uses>18</tool_uses><duration_ms>138165</duration_ms></usage>
// (older versions say total_tokens). Text taken from a raw transcript line has "\n" escaped; both work.
function agentUsage(text) {
  const u = /<usage>([\s\S]{0,400}?)<\/usage>/.exec(String(text || ''));
  if (!u) return {};
  const body = u[1].replace(/\\n/g, '\n');
  const num = (k) => { const r = new RegExp('(?:^|[^a-z_])' + k + '(?:>|:\\s*)(\\d+)').exec(body); return r ? +r[1] : undefined; };
  const out = {}, tok = num('subagent_tokens') != null ? num('subagent_tokens') : num('total_tokens');
  if (tok != null) out.tokens = tok;
  if (num('tool_uses') != null) out.tools = num('tool_uses');
  if (num('duration_ms') != null) out.ms = num('duration_ms');
  return out;
}

class Chat {
  constructor({ cid, cwd, name, token, model }) {
    this.cid = cid || null; this.cwd = cwd; this.name = name; this.token = token || null;
    this.modelRef = model || '';      // the picked "provider/model"; '' = the default (web-models.js)
    this.subs = new Set();            // {ws, key}
    this.state = 'stopped'; this.q = null; this.input = null;
    this.perms = new Map();           // id -> {resolve, tool, input, reason, suggestions}
    this.turn = [];                   // SDK messages of the current turn (for late subscribers)
    this.info = { cwd, model: '', modelRef: '', effort: defaultEffort, permissionMode: '', commands: [], cost: null, commandList: cachedCommands(cwd), models: MODELS };
    this.info.modelRef = this.pickModel() ? this.pickModel().ref : '';
    this.agents = new Map();          // Agent tool_use_id -> {state, model, tokens, tools, ms, at}: what this process saw
    if (!CMD.byCwd[cwd] || !modelsFresh) warmCommands(cwd);
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
    const tok = await registry.upsert({ cid: this.cid, cwd: this.cwd, name: this.name, state, title, model: this.modelRef });
    if (tok && tok !== this.token) { this.token = tok; this.emit({ ev: 'token', token: tok }); }
    if (this.wire) this.wire.update({ token: this.token, cid: this.cid });
  }
  pickModel() { return models ? models.resolve(this.modelRef) : null; }
  async start() {
    assertDir(this.cwd);
    await sdkReady;
    if (!sdk) throw new Error(loadError || 'Agent SDK not loaded');
    if (this.cid && await tmuxAlive(this.name)) throw new Error('This session is open in the console. Switch to chat first (it closes the console).');
    this.input = new InputQueue();
    // the provider's env (key, base URL) for the model this session runs; see web-models.js
    const sel = this.pickModel(), env = models ? models.envFor(sel, sessionEnv()) : sessionEnv();
    this.running = sel; this.info.modelRef = sel ? sel.ref : '';
    // a task folder: each of its repos is an extra directory, so their CLAUDE.md and skills load
    const repoDirs = taskDirs(this.cwd); this.repoDirs = repoDirs.join('\n');
    if (repoDirs.length) env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1';
    // which window of the box browser Claude's playwright tools get (web-browser.js resolves the name)
    env.CB_SESSION = this.token || this.name;
    this.wire = wire ? await wire.begin('chat', this.name, env, { token: this.token, cid: this.cid, cwd: this.cwd })
      : { id: null, env, update() {}, finish() {} };
    const options = {
      cwd: this.cwd,
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      canUseTool: (tool, input, o) => this.askPermission(tool, input, o),
      // the box's browser (playwright tools on the Browser tab's Chromium) holds the user's logins:
      // the first use in a session asks, in any permission mode (auto included); see browserGate
      // timeout: the hook waits for the user's answer; onFailure block: an error or a timeout means no
      hooks: { PreToolUse: [{ matcher: 'mcp__playwright__.*', timeout: 86400, onFailure: 'block', hooks: [(input, id, o) => this.browserGate(input, o)] }] },
      // claude-notify (the tmux hook) must not touch the registry for chat-owned sessions —
      // this module keeps those records itself (see scripts/notify.sh).
      env: this.wire.env,
      additionalDirectories: [UPLOADS].concat(repoDirs),
      stderr: (d) => log(this.name, String(d).trim()),
    };
    try { fs.mkdirSync(UPLOADS, { recursive: true }); } catch (_) {}
    if (this.cid) options.resume = this.cid;
    if (this.desiredMode) options.permissionMode = this.desiredMode;   // picked before the first message
    if (sel) options.model = sel.model;
    if (this.desiredEffort) options.effort = this.desiredEffort;
    this.agents.clear();              // sub-agents die with the claude process
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
      if (m.effort !== undefined) this.info.effort = m.effort;
      else if (this.desiredEffort) this.info.effort = this.desiredEffort;
      this.emit({ ev: 'info', info: this.info });
      this.refreshApplied();
      // names come with init; descriptions and argument hints need one more call
      const q = this.q;
      if (q && q.supportedCommands) q.supportedCommands().then((list) => this.setCommands(list), (e) => log('commands', e.message));
      if (q && q.supportedModels) q.supportedModels().then(rememberModels, (e) => log('models', e.message));
      return;
    }
    if (m.type === 'system' && m.subtype === 'commands_changed' && Array.isArray(m.commands)) {
      this.setCommands(m.commands); return;
    }
    if (m.type === 'system' && m.subtype === 'session_state_changed') { this.setState(m.state); return; }
    if (m.type === 'system' && m.subtype === 'status' && m.permissionMode) {
      this.info.permissionMode = m.permissionMode; this.emit({ ev: 'info', info: this.info });
    }
    this.trackAgent(m);
    if (m.type === 'result') {
      // a name picked when the session was opened (New session dialog): written like /rename once
      // the transcript exists, so Claude's own generated title does not replace it
      if (this.customTitle && this.cid) { const t = this.customTitle; this.customTitle = null; setTitle(this.cid, this.cwd, t).catch((e) => log(this.name, 'title', e.message)); }
      this.info.cost = m.total_cost_usd; this.emit({ ev: 'info', info: this.info });
      measureCtx(this); this.refreshApplied();
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
  // What the launcher shows on a sub-agent's row, kept here too so a page that (re)opens the session
  // learns which agents are still running — the transcript only says how they ended.
  trackAgent(m) {
    let id = null, a = null;
    const get = (k) => { if (!k) return null; let x = this.agents.get(k); if (!x) { x = { state: 'run' }; this.agents.set(k, x); } return x; };
    if (m.type === 'system' && /^task_(started|progress|notification)$/.test(m.subtype || '') && m.tool_use_id) {
      if (!this.agents.has(m.tool_use_id)) return;          // a skill's task, not an Agent call
      id = m.tool_use_id; a = get(id);
      if (m.subtype === 'task_started') a.state = 'run';
      if (m.usage) Object.assign(a, { tokens: m.usage.total_tokens, tools: m.usage.tool_uses, ms: m.usage.duration_ms });
      if (m.subtype === 'task_notification') a.state = m.status === 'completed' ? 'done' : m.status === 'stopped' ? 'stopped' : 'err';
    } else if (m.type === 'assistant') {
      const c = m.message && m.message.content;
      if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_use' && AGENT_TOOLS.has(b.name)) get(b.id).at = Date.now();
      if (!m.parent_tool_use_id || !this.agents.has(m.parent_tool_use_id)) return;
      a = this.agents.get(m.parent_tool_use_id); if (m.message && m.message.model) a.model = m.message.model;
    } else if (m.type === 'user' && Array.isArray(m.message && m.message.content)) {
      for (const b of m.message.content) {
        const x = b && b.type === 'tool_result' && this.agents.get(b.tool_use_id);
        if (!x) continue;
        const t = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map((c) => (c && c.text) || '').join('\n') : '');
        // an async agent's answer is "launched" and it keeps working; Claude Code may run an agent
        // async without run_in_background, so the result itself decides
        const r = m.tool_use_result, launched = (r && typeof r === 'object' && (r.isAsync || r.status === 'async_launched')) ||
          /async_launched|async agent launched|launched in the background|running in the background/i.test(t);
        if (b.is_error) x.state = 'err';
        else if (!launched) x.state = 'done';
        Object.assign(x, agentUsage(t)); x.at = Date.now();
      }
      return;
    }
    if (a) a.at = Date.now();
  }
  agentsView() {
    const out = {};
    for (const [k, a] of this.agents) out[k] = Object.assign({}, a, a.state === 'run' && !this.q ? { state: 'stopped' } : null);
    return out;
  }
  // Reasoning effort, live (applyFlagSettings) or from the next start; null = the model's default
  async setEffort(effort) {
    {
      const e = EFFORTS.includes(effort) ? effort : null;
      this.desiredEffort = e;
      if (this.q && this.q.applyFlagSettings) await this.q.applyFlagSettings({ effortLevel: e });
      this.info.effort = e;
    }
    this.emit({ ev: 'info', info: this.info });
    if (this.q) await this.refreshApplied();
  }
  // The model and effort the session really runs with (settings, env overrides, org caps and
  // model-support downgrades applied): init does not carry the effort for an SDK host.
  async refreshApplied() {
    const q = this.q;
    if (!q || typeof q.getSettings !== 'function') return;
    try {
      const a = (await q.getSettings() || {}).applied;
      if (!a || q !== this.q) return;
      const effort = a.effort === undefined ? this.info.effort : a.effort, model = a.model || this.info.model;
      if (effort === this.info.effort && model === this.info.model) return;
      this.info.effort = effort; this.info.model = model;
      this.emit({ ev: 'info', info: this.info });
    } catch (e) { log(this.name, 'settings', e.message); }
  }
  // One question per session before Claude uses the box's browser: what it does there, it does as the
  // user, in every site the user signed in to. Allowed once, the rest of the session goes on its own.
  async browserGate(input, o) {
    const name = String((input && input.tool_name) || '');
    if (!/^mcp__playwright__/.test(name) || this.browserAllowed) return {};
    if (!this.browserAsking) {
      this.browserAsking = this.askPermission('Browser', Object.assign({ action: name.replace(/^mcp__playwright__browser_|^mcp__playwright__/, '') }, (input && input.tool_input) || {}),
        { decisionReason: 'Claude wants to use the box\'s browser, where you are signed in (GitHub, Slack, Jira…). Allowing lets it browse, click and type there for the rest of this session.', signal: o && o.signal })
        .then((r) => { this.browserAsking = null; if (r && r.behavior === 'allow') this.browserAllowed = true; return r; });
    }
    const r = await this.browserAsking;
    return r && r.behavior === 'allow'
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'browser allowed for this session' } }
      : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'The user did not allow the browser in this session. Ask them before trying again.' } };
  }
  // The data behind /context and /usage for the launcher's dialogs; data null = not available
  // here (the launcher then sends the command as before). A running session answers itself. A
  // stopped one is not resumed for it (see withProbe): /context shows its last measurement (or
  // the folder's baseline before the first one), /usage asks a fresh process for the plan limits.
  async stats(kind) {
    await sdkReady;
    if (!sdk) throw new Error(loadError || 'Agent SDK not loaded');
    const q = this.q;
    if (kind === 'context') {
      if (q && typeof q.getContextUsage === 'function') {
        const u = await q.getContextUsage({ detail: 'full' }), s = ctxSummary(u);
        if (s && this.cid) applyCtx(this, s);         // the ring gets the fresh numbers too
        return { live: true, data: ctxView(u) };
      }
      const last = (this.cid && CTX[this.cid]) || null;
      if (last) return { live: false, data: last };
      const base = await withProbe(this.cwd, async (p) => typeof p.getContextUsage === 'function' ? ctxView(await p.getContextUsage({ detail: 'full' })) : null);
      return { live: false, baseline: true, data: base };
    }
    if (kind === 'usage') {
      const ask = async (p) => {
        const f = usageFn(p);
        if (!f) return null;
        const [u, a] = await Promise.all([f({ skipBehaviors: true }), typeof p.accountInfo === 'function' ? p.accountInfo().catch(() => null) : null]);
        return usageView(u, a);
      };
      const data = q ? await ask(q) : await withProbe(this.cwd, ask);
      // a fresh process has no totals of this session: the transcript keeps the ones of its last run
      const empty = (x) => !x || (!x.cost && !Object.keys(x.models || {}).length);
      if (data && (!q || empty(data.session))) data.session = savedSession(this.cid ? savedCostState(this) : null) || (q ? data.session : null);
      return { live: !!q, data };
    }
    throw new Error('unknown stats: ' + kind);
  }
  askPermission(tool, input, o) {
    // the box's own artifact panel only shows a file Claude already wrote: no question for that
    if (tool === 'mcp__claude-box__show_artifact') return Promise.resolve({ behavior: 'allow', updatedInput: input });
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
    // a repo was added to the task since the process started: restart it so the new folder joins
    if (this.q && this.repoDirs !== undefined && taskDirs(this.cwd).join('\n') !== this.repoDirs && this.state !== 'running' && this.state !== 'requires_action') await this.stop();
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
  // Pick the model. Within the running provider the SDK switches it live; another provider needs
  // other credentials, so the process is closed and the next message resumes the session with them.
  async setModel(ref) {
    if (!models) throw new Error('Models are not available.');
    const sel = models.resolve(ref);
    if (!sel || sel.ref !== ref) throw new Error('That model is not connected. Add it in Settings > Models.');
    if (this.q && this.running && this.running.provider !== sel.provider && (this.state === 'running' || this.state === 'requires_action'))
      throw new Error('Wait until the answer finishes, then switch the provider.');
    this.modelRef = ref; this.info.modelRef = ref;
    if (this.q && this.running && this.running.provider === sel.provider) {
      try { await this.q.setModel(sel.model); this.running = sel; this.info.model = sel.model; }
      catch (e) { log(this.name, 'setModel', e.message); await this.stop(); }
    } else if (this.q) await this.stop();
    if (this.cid) this.syncRegistry(this.state === 'stopped' ? 'stopped' : 'done');
    this.emit({ ev: 'info', info: this.info });
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
// The ring's numbers from a getContextUsage reply (camelCase: SDKControlGetContextUsageResponse).
function ctxSummary(u) {
  const max = u && (u.rawMaxTokens || u.maxTokens), total = u && u.totalTokens;
  if (!max || total == null) return null;
  return { total, max, pct: u.percentage != null ? Math.round(u.percentage) : Math.round(total / max * 100), model: u.model || '', at: Date.now(),
    cats: (u.categories || []).filter((k) => k.kind !== 'free' && k.tokens > 0).map((k) => ({ id: k.id || '', name: k.name, tokens: k.tokens, kind: k.kind })) };
}
function applyCtx(chat, c) {
  if (chat.cid) { CTX[chat.cid] = c; CTX._max = c.max; saveCtx(); }
  chat.info.context = c; chat.emit({ ev: 'info', info: chat.info });
}
async function measureCtx(chat) {
  if (!chat.q || typeof chat.q.getContextUsage !== 'function' || !chat.cid) return;
  try {
    const u = await chat.q.getContextUsage({ detail: 'summary' });
    const c = ctxSummary(u);
    if (!c) { log(chat.name, 'context usage: unexpected reply', Object.keys(u || {}).join(',')); return; }
    applyCtx(chat, c);
  } catch (e) { log(chat.name, 'context usage', e.message); }
}
// What the /context dialog shows, from a getContextUsage({detail:'full'}) reply: the ring's numbers
// plus every row (free space and on-demand tools included), memory files, MCP servers, message parts.
function ctxView(u) {
  const s = ctxSummary(u);
  if (!s) return null;
  const servers = new Map();
  for (const t of u.mcpTools || []) {
    const k = t.serverName || '?', x = servers.get(k) || { name: k, tokens: 0, tools: 0, loaded: 0 };
    x.tokens += t.tokens || 0; x.tools++; if (t.isLoaded !== false) x.loaded++;
    servers.set(k, x);
  }
  const mb = u.messageBreakdown;
  return Object.assign(s, {
    cats: (u.categories || []).filter((k) => k.tokens > 0 || k.kind === 'free').map((k) => ({ id: k.id || '', name: k.name, tokens: k.tokens, kind: k.kind })),
    memory: (u.memoryFiles || []).map((f) => ({ path: f.path, type: f.type, tokens: f.tokens })),
    mcp: [...servers.values()].sort((a, b) => b.tokens - a.tokens),
    skills: u.skills ? { total: u.skills.totalSkills, included: u.skills.includedSkills, tokens: u.skills.tokens } : null,
    msgs: mb ? { toolCalls: mb.toolCallTokens, toolResults: mb.toolResultTokens, attachments: mb.attachmentTokens,
      assistant: mb.assistantMessageTokens, user: mb.userMessageTokens } : null,
    autoCompact: u.isAutoCompactEnabled ? (u.autoCompactThreshold || true) : false,
  });
}

// ---------- plan usage ----------
// The /usage data: SDKControlGetUsageResponse. The method is experimental and will be renamed
// when it is stabilized; without it the launcher falls back to sending /usage as a command.
const USAGE_FNS = ['getUsage', 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'];
function usageFn(q) {
  const n = USAGE_FNS.find((k) => q && typeof q[k] === 'function');
  return n ? (o) => q[n](o) : null;
}
// The session totals Claude Code saved in the transcript (its last cost-state), for a session
// that is not running: the same shape as usageView's session.
function savedSession(cs) {
  if (!cs) return null;
  const models = {};
  for (const [k, m] of Object.entries(cs.modelUsage || {})) models[k] = { input: m.inputTokens, output: m.outputTokens,
    cacheRead: m.cacheReadInputTokens, cacheWrite: m.cacheCreationInputTokens, cost: m.costUSD };
  return { cost: cs.totalCostUSD, apiMs: cs.totalAPIDuration, wallMs: cs.totalDuration, added: cs.totalLinesAdded,
    removed: cs.totalLinesRemoved, models, unknownCost: !!cs.hasUnknownModelCost, saved: true };
}
// The last non-zero cost-state of a session's transcript (Claude Code writes one when its process
// ends; a resume that sends nothing writes a zeroed one, which is skipped). Read incrementally: each
// transcript keeps its consumed size, so a repeated /usage only scans what was appended (LRU).
const COSTS = new Map();           // cid -> {file, size, cost}
function savedCostState(chat) {
  const f = chat.cid && transcriptPath(chat.cid, chat.cwd);
  let st; try { st = f ? fs.statSync(f) : null; } catch (_) { st = null; }
  if (!st) return null;
  let c = COSTS.get(chat.cid);
  if (!c || c.file !== f || st.size < c.size) { c = { file: f, size: 0, cost: null }; COSTS.delete(chat.cid); }
  cacheTouch(COSTS, chat.cid, () => c);
  if (st.size > c.size) {
    const fd = fs.openSync(f, 'r');
    try {
      const buf = Buffer.alloc(st.size - c.size);
      fs.readSync(fd, buf, 0, buf.length, c.size);
      const cut = buf.lastIndexOf(0x0a);                    // only complete lines
      if (cut >= 0) {
        for (const l of buf.toString('utf8', 0, cut).split('\n')) {
          if (!l.startsWith('{"type":"cost-state"')) continue;
          let e; try { e = JSON.parse(l); } catch (_) { continue; }
          if (e && (e.totalCostUSD > 0 || Object.keys(e.modelUsage || {}).length)) c.cost = e;
        }
        c.size += cut + 1;
      }
    } finally { fs.closeSync(fd); }
  }
  return c.cost;
}
// Where the requests go when it is not Anthropic's API (ANTHROPIC_BASE_URL): the host only.
function apiEndpoint() {
  const u = process.env.ANTHROPIC_BASE_URL;
  if (!u) return '';
  try { const h = new URL(u).host; return /(^|\.)anthropic\.com$/.test(h) ? '' : h; } catch (_) { return ''; }
}
function usageView(u, a) {
  if (!u || typeof u !== 'object' || !('rate_limits_available' in u || 'session' in u)) return null;
  const s = u.session || null, models = {};
  if (s && s.model_usage) for (const [k, m] of Object.entries(s.model_usage)) models[k] = { input: m.inputTokens, output: m.outputTokens,
    cacheRead: m.cacheReadInputTokens, cacheWrite: m.cacheCreationInputTokens, cost: m.costUSD };
  a = a || {};
  return { plan: u.subscription_type || a.subscriptionType || null, limitsAvailable: !!u.rate_limits_available, limits: u.rate_limits || null,
    session: s && { cost: s.total_cost_usd, apiMs: s.total_api_duration_ms, wallMs: s.total_duration_ms,
      added: s.total_lines_added, removed: s.total_lines_removed, models },
    account: { email: a.email || '', organization: a.organization || '', tokenSource: a.tokenSource || '',
      apiKeySource: a.apiKeySource || '', provider: a.apiProvider || '', endpoint: apiEndpoint() } };
}
// "What's contributing to your limits usage": a scan of every transcript touched in the last
// seven days. It runs in its own process (a session's process would stall its turn meanwhile),
// one at a time, and is reused for a couple of minutes.
const BEHAV_TTL = 120000;
let behav = null, behavRun = null;
function usageBehaviors(cwd) {
  if (behav && Date.now() - behav.at < BEHAV_TTL) return Promise.resolve(behav.data);
  if (!behavRun) {
    behavRun = withProbe(cwd, async (q) => { const f = usageFn(q); const u = f ? await f({}) : null; return (u && u.behaviors) || null; }, 60000)
      .then((d) => { behav = { at: Date.now(), data: d }; return d; })
      .finally(() => { behavRun = null; });
  }
  return behavRun;
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
// History is cut from the TAIL of the transcript instead of parsing it whole. Opening a session
// needs the LAST few messages; the old path made the SDK re-parse the whole file (tens of MB) on
// every open and every "loading earlier messages" page — seconds of CPU that left panes stuck in
// "Loading" and starved everything else the server serves. A per-session backward reader consumes
// the file in 512 KB windows from the end and grows toward the start only when the user asks for
// earlier pages. Parsed windows are kept per session in a small LRU (a parsed long transcript is
// hundreds of MB of JS objects; keeping all of them grew the heap until GC stalls).
const CACHE_MAX = 6;
function cacheTouch(map, cid, make) {
  let v = map.get(cid);
  if (!v) { v = make(); map.set(cid, v); }
  else { map.delete(cid); map.set(cid, v); }          // refresh LRU order
  while (map.size > CACHE_MAX) map.delete(map.keys().next().value);
  return v;
}
const PAGE_PROMPTS = 5;
const WINDOW = 512 * 1024;
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
// {type:'system', subtype:'local_command', parentUuid, content:'<local-command-stdout>…'}.
// Times: uuid -> written-at ms; transcript lines carry their own "uuid","timestamp" pair.
const UUID_TS = /"uuid":"([^"]+)","timestamp":"([^"]+)"/;
// Sub-agent facts the transcript keeps outside the messages getSessionMessages returns: the model
// (toolUseResult.resolvedModel), whether it was launched in the background, and how it ended with
// its totals (the result's <usage>, or the <task-notification> of a background agent).
function scanAgentLine(l, agents) {
  const put = (id, o) => { if (id) agents.set(id, Object.assign(agents.get(id) || {}, o)); };
  if (l.includes('"toolUseResult"') && l.includes('"agentId"')) {
    let e; try { e = JSON.parse(l); } catch (_) { e = null; }
    const r = e && e.toolUseResult, c = e && e.message && e.message.content;
    const b = Array.isArray(c) && c.find((x) => x && x.type === 'tool_result');
    if (r && typeof r === 'object' && b) {
      const bg = r.isAsync || r.status === 'async_launched';
      const t = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || '').join('\n') : '');
      const o = Object.assign({ model: r.resolvedModel || undefined }, agentUsage(t));
      if (!bg) o.state = b.is_error || r.status === 'failed' ? 'err' : 'done';
      else if (!(agents.get(b.tool_use_id) || {}).state) o.state = 'run';
      put(b.tool_use_id, o);
    }
  }
  if (l.includes('<task-notification>') && l.includes('<tool-use-id>')) {
    for (const n of l.split('<task-notification>').slice(1)) {
      const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(n), st = /<status>(\w+)<\/status>/.exec(n);
      if (!id) continue;
      put(id[1], Object.assign({ state: !st || st[1] === 'completed' ? 'done' : st[1] === 'stopped' ? 'stopped' : 'err' },
        agentUsage(n.split('</task-notification>')[0])));
    }
  }
}
const READERS = new Map();         // cid -> backward reader state (LRU, see cacheTouch)
function readerFor(chat) {
  return cacheTouch(READERS, chat.cid, () =>
    ({ file: null, front: 0, items: [], extras: new Map(), times: new Map(), agents: new Map(), atStart: false, capped: false }));
}
// One transcript line -> times/agents/extras and, for a real turn, an item in acc.win. Shared by
// the reader and the seek walker. acc.win is filled newest-first (the walk goes backward); the
// callers reverse it once at the end.
function consumeLine(l, acc) {
  const t = UUID_TS.exec(l);
  if (t) { const ms = Date.parse(t[2]); if (ms) acc.times.set(t[1], ms); }
  if (acc.agents && !l.includes('"isSidechain":true')) scanAgentLine(l, acc.agents);
  if (!l.startsWith('{')) return;
  let e; try { e = JSON.parse(l); } catch (_) { return; }
  if (e.type === 'system' && e.subtype === 'local_command' && !e.isSidechain) {
    const c = String(e.content || '').replace(/<\/?local-command-std(out|err)>/g, '').trim();
    if (c) {
      const k = e.parentUuid || '';
      acc.extras.set(k, [{ type: 'system', subtype: 'local_command_output', uuid: e.uuid, content: c }].concat(acc.extras.get(k) || []));
    }
  }
  if ((e.type !== 'user' && e.type !== 'assistant') || e.isSidechain) return;
  if (!e.uuid || !e.message) return;
  acc.win.push({ type: e.type, uuid: e.uuid, message: e.message, parent_tool_use_id: e.parent_tool_use_id || null, meta: !!e.isMeta,
    from: (e.origin && e.origin.name) || undefined });
}
// Start offset of the transcript line that ends right before byte offset `pos` (`pos` is itself a
// line start). Probes backward in growing chunks, so a line of any length costs one small probe —
// window-cut parsing never dropped whole (huge) tool-result lines this way.
function prevLineStart(f, pos) {
  let probe = 16384;
  while (true) {
    const to = pos - 1;                                  // the '\n' that ends the previous line
    if (to <= 0) return 0;
    const from = Math.max(0, to - probe);
    const fd = fs.openSync(f, 'r');
    let buf;
    try { buf = Buffer.alloc(to - from); fs.readSync(fd, buf, 0, buf.length, from); }
    finally { fs.closeSync(fd); }
    const idx = buf.lastIndexOf('\n');
    if (idx >= 0) return from + idx + 1;
    if (from === 0) return 0;
    probe *= 8;
    if (probe > 32 * 1024 * 1024) return 0;              // hopeless gap: treat as the file start
  }
}
function readLineText(f, s, e) {
  if (e <= s) return '';
  if (e - s > 8 * 1024 * 1024) return null;              // a single message over 8 MB: not worth a page
  const fd = fs.openSync(f, 'r');
  let buf;
  try { buf = Buffer.alloc(e - s); fs.readSync(fd, buf, 0, buf.length, s); }
  finally { fs.closeSync(fd); }
  return buf.toString('utf8');
}
// Consume more lines moving toward the file start, until the collected tail holds at least
// minPrompts user prompts (or the file start is reached).
// Agent-heavy sessions go megabytes without a single user prompt, so counting prompts alone made
// the reader consume whole transcripts (hundreds of MB of JS objects -> OOM-ish heap). Reading is
// bounded by bytes and items as well: a page may carry fewer prompts than requested.
const READER_MAX_BYTES = 4 * 1024 * 1024;
const READER_MAX_ITEMS = 1200;
function extendBack(entry, chat, minPrompts) {
  const f = transcriptPath(chat.cid, chat.cwd);
  if (!f) { entry.atStart = true; return; }
  let size; try { size = fs.statSync(f).size; } catch (_) { entry.atStart = true; return; }
  if (entry.file !== f) { Object.assign(entry, { file: f, size, front: size, items: [], extras: new Map(), times: new Map(), agents: new Map(), atStart: false, capped: false, read: 0 }); }
  // the lines of this call go to `win` (merged once at the end), so they count toward the page and
  // the caps as they come: counting entry.items alone walked every first open to the 4 MB cap
  const win = [];
  const have = entry.items.reduce((n, i) => n + (isPrompt(i) ? 1 : 0), 0);
  let winPrompts = 0;
  const items = () => entry.items.length + win.length;
  const enough = () => have + winPrompts >= minPrompts || items() >= READER_MAX_ITEMS || entry.read >= READER_MAX_BYTES;
  while (!entry.atStart && !enough()) {
    if (entry.front <= 0) { entry.atStart = true; break; }
    const prev = prevLineStart(f, entry.front);
    const l = readLineText(f, prev, entry.front);
    entry.read += entry.front - prev;
    const n = win.length;
    consumeLine(l || '', { times: entry.times, agents: entry.agents, extras: entry.extras, win });
    if (win.length > n && isPrompt(win[win.length - 1])) winPrompts++;
    entry.front = prev;
    if (prev <= 0) entry.atStart = true;      // isMeta stays: scheduled/cron turns are real user turns and must be visible
  }
  // a byte/item cap (not the file start) stopped the walk: deeper history exists, the next
  // "earlier" request for a boundary behind the cap goes to seekPage
  if (!entry.atStart && (items() >= READER_MAX_ITEMS || entry.read >= READER_MAX_BYTES)) entry.capped = true;
  if (win.length) { win.reverse(); entry.items = win.concat(entry.items); }
}
// The page the browser shows: the last PAGE_PROMPTS prompts counting from the end, or — with
// `beforeUuid` — the PAGE_PROMPTS prompts right before that message (the "earlier" page).
function tailPage(chat, beforeUuid) {
  if (!chat.cid) return { items: [], more: 0 };
  const entry = readerFor(chat);
  // the reader only walks backward from where it started; for the latest page, start over once the
  // transcript has grown, or prompts sent since (which never show up in chat.turn) vanish on reopen
  if (!beforeUuid && entry.file) {
    let size = -1; try { size = fs.statSync(entry.file).size; } catch (_) {}
    if (size !== entry.size) entry.file = null;
  }
  extendBack(entry, chat, PAGE_PROMPTS);
  const count = (arr) => arr.reduce((n, i) => n + (isPrompt(i) ? 1 : 0), 0);
  const at = () => entry.items.findIndex((i) => i.uuid === beforeUuid);
  let end = beforeUuid ? at() : entry.items.length;
  let guard = 0;
  while (beforeUuid && end < 0 && !entry.atStart && !entry.capped && guard++ < 8) {   // the boundary page was evicted: read further back
    extendBack(entry, chat, count(entry.items) + PAGE_PROMPTS * (guard + 1));
    end = at();
  }
  // the reader stops as soon as it holds a page, so the boundary may sit at its very front:
  // read the page that goes under it
  if (beforeUuid && end >= 0 && !entry.atStart && !entry.capped) {
    const under = count(entry.items.slice(0, end));
    if (under < PAGE_PROMPTS) { extendBack(entry, chat, count(entry.items) + PAGE_PROMPTS - under); end = at(); }
  }
  if (beforeUuid && end < 0) return seekPage(chat, beforeUuid);
  const stop = end < 0 ? entry.items.length : end;
  const start = pageStart(entry.items, stop);
  const page = entry.items.slice(start, stop);
  // a capped window may have the boundary but not a full page under it; seekPage is independent
  // of the reader's byte/item caps and fills the page from the file itself
  if (beforeUuid && entry.capped &&
      page.reduce((n, i) => n + (isPrompt(i) ? 1 : 0), 0) < PAGE_PROMPTS) return seekPage(chat, beforeUuid);
  if (!beforeUuid) {                                                 // streamed this turn, transcript may lag
    const seen = new Set(page.map((i) => i.uuid));
    for (const m of chat.turn) if (!seen.has(m.uuid))
      page.push({ type: m.type, uuid: m.uuid, message: m.message, parent_tool_use_id: m.parent_tool_use_id || null });
  }
  const out = [];
  for (const i of page) {
    if (i.type !== 'user' && i.type !== 'assistant') continue;
    const ts = entry.times.get(i.uuid) || 0;
    out.push({ type: i.type, uuid: i.uuid, message: i.message, parent_tool_use_id: i.parent_tool_use_id || null, ts: ts || undefined });
    for (const x of entry.extras.get(i.uuid) || []) out.push(x);
  }
  return { items: out, more: start > 0 ? start : (!entry.atStart ? 1 : 0) };
}
// Long sessions outgrow the reader's bounded window (READER_MAX_*): an "earlier" request whose
// boundary lies deeper than the cap used to come back empty (lost) and the UI stopped loading
// history. For that case seek the boundary in the raw file instead: find its line by a plain-text
// needle (safe: inside JSON strings the quotes are escaped, so the needle only matches a real
// "uuid" field), then parse just the one page backward from it. Nothing is kept in the LRU — the
// raw scan costs no JSON parsing, and the parse is bounded by the page itself.
const SEEK_MAX_BYTES = 64 * 1024 * 1024;
function seekPage(chat, beforeUuid) {
  const lost = { items: [], more: 0, lost: true };
  const f = transcriptPath(chat.cid, chat.cwd);
  if (!f || !beforeUuid) return lost;
  let size; try { size = fs.statSync(f).size; } catch (_) { return lost; }
  // phase 1: locate the boundary line's start offset (backward, window by window, a small carry
  // covers a needle that straddles a window edge)
  // The search runs on the raw bytes: a decoded window's string index is not a byte offset once
  // the text holds non-ASCII (Cyrillic, emoji), and a wrong offset dropped messages off the page.
  const NEEDLE = Buffer.from(`"uuid":"${beforeUuid}"`);
  let at = -1, front = size, scanned = 0, carry = Buffer.alloc(0);
  while (front > 0 && scanned < SEEK_MAX_BYTES) {
    const start = Math.max(0, front - WINDOW);
    const fd = fs.openSync(f, 'r');
    let buf;
    try { buf = Buffer.alloc(front - start); fs.readSync(fd, buf, 0, buf.length, start); }
    finally { fs.closeSync(fd); }
    scanned += buf.length;
    const hay = carry.length ? Buffer.concat([buf, carry]) : buf;   // carry: the later window's head
    const idx = hay.indexOf(NEEDLE);
    // a match that starts in the carry lies wholly in the later window, which was searched already
    if (idx >= 0 && idx < buf.length) { at = prevLineStart(f, start + idx + 1); break; }   // its line's start
    carry = buf.subarray(0, Math.min(NEEDLE.length - 1, buf.length));
    front = start;
  }
  if (at < 0) return lost;
  // phase 2: parse backward from the boundary line until the page holds PAGE_PROMPTS prompts
  const times = new Map(), extras = new Map(), win = [];
  let back = at, read = 0, atStart = false;
  while (!atStart && read < SEEK_MAX_BYTES && win.length < READER_MAX_ITEMS) {
    const prev = prevLineStart(f, back);
    read += back - prev;
    const l = readLineText(f, prev, back);
    if (l !== null) consumeLine(l, { times, agents: null, extras, win });
    back = prev;
    if (prev <= 0) atStart = true;
    else if (win.reduce((n, i) => n + (isPrompt(i) ? 1 : 0), 0) >= PAGE_PROMPTS) break;
  }
  win.reverse();                                             // the walk went backward: restore file order
  const start = pageStart(win, win.length);
  const page = win.slice(start);
  const out = [];
  for (const i of page) {
    if (i.type !== 'user' && i.type !== 'assistant') continue;
    const ts = times.get(i.uuid) || 0;
    out.push({ type: i.type, uuid: i.uuid, message: i.message, parent_tool_use_id: i.parent_tool_use_id || null, ts: ts || undefined });
    for (const x of extras.get(i.uuid) || []) out.push(x);
  }
  return { items: out, more: start > 0 || !atStart ? 1 : 0 };
}
// ---------- one-shot shell runs (the "Run" button on code blocks) ----------
// A fresh bash per run: real shell semantics ( pipes, env, builds) with a clean state and no
// surprises in a live console. Bounded by time and output size; at most a few at a time.
const RUN_MAX = 2, RUN_TIMEOUT = 120000, RUN_MAXBUF = 1 << 20;
let runsActive = 0;
function runInShell(chat, cmd) {
  return new Promise((res) => {
    if (runsActive >= RUN_MAX) { res({ code: -1, out: 'too many runs in progress, try again in a moment', ms: 0 }); return; }
    runsActive++;
    const t0 = Date.now();
    execFile('bash', ['-lc', cmd], { cwd: chat.cwd || WS_ROOT, timeout: RUN_TIMEOUT, maxBuffer: RUN_MAXBUF,
      env: Object.assign({}, process.env, { TERM: 'dumb' }) }, (e, out, err) => {
      runsActive--;
      let code = e && e.code != null ? e.code : (e ? -1 : 0);
      let text = String(out || '');
      if (err) text += (text ? '\n' : '') + String(err);
      if (e && e.killed) text += '\n[timeout after ' + Math.round(RUN_TIMEOUT / 1000) + ' s — killed]';
      if (text.length > RUN_MAXBUF) text = text.slice(0, RUN_MAXBUF) + '\n…[truncated]';
      res({ code, out: text.trim(), ms: Date.now() - t0 });
    });
  });
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
      name: rec.tmuxSession || rec.name || ('chat-' + msg.token), token: msg.token, model: rec.model || '' });
  }
  const cwd = msg.cwd && path.resolve(msg.cwd);
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('folder not found: ' + msg.cwd);
  const chat = new Chat({ cwd, name: 'chat-' + sanitizeName(path.basename(cwd)) + '-' + Date.now().toString(36).slice(-4) + (++newSeq) });
  // a name picked for the new session: shown right away (registry title) and kept (customTitle)
  const title = String(msg.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (title) { chat.pendingTitle = title; chat.customTitle = title; }
  return chat;
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
    // liveness check from the launcher; answered in order, so a wedged op chain shows up as silence
    if (msg.op === 'ping') { reply({ ev: 'pong' }); return; }
    try {
      if (msg.op === 'open') {
        let chat = mine.get(key);
        if (!chat) { chat = await chatFor(msg); mine.set(key, chat); chat.subs.add({ ws, key }); }
        const pg = tailPage(chat, null), items = pg.items, start = pg.more;
        if (!chat.info.context) chat.info.context = (chat.cid && CTX[chat.cid]) || estimateCtx(items);
        const pend = [...chat.perms].map(([id, p]) => ({ id, tool: p.tool, input: p.input, reason: p.reason, suggestions: p.suggestions.length > 0 }));
        reply({ ev: 'history', key, items, state: chat.state, console: !chat.q && await tmuxAlive(chat.name),
                info: chat.info, perms: pend, token: chat.token, more: pg.more, agents: agentFacts(chat),
                draft: (chat.token && DRAFTS[chat.token]) || null });
        return;
      }
      if (msg.op === 'older') {
        const chat = mine.get(key);
        if (!chat) { reply({ ev: 'older', key, items: [], more: 0 }); return; }
        const pg = tailPage(chat, msg.before);
        if (pg.lost) { reply({ ev: 'older', key, items: [], more: 0, lost: true }); return; }
        reply({ ev: 'older', key, items: pg.items, more: pg.more });
        return;
      }
      if (msg.op === 'run') {
        let chat = mine.get(key);
        if (!chat && msg.token) { chat = await chatFor(msg); mine.set(key, chat); chat.subs.add({ ws, key }); }
        if (!chat) { reply({ ev: 'error', key, text: 'run: session not open' }); return; }
        const cmd = String(msg.cmd || '').trim().slice(0, 4000);
        if (!cmd) { reply({ ev: 'error', key, text: 'run: empty command' }); return; }
        log('shell run:', cmd.slice(0, 120));
        runInShell(chat, cmd).then((r) => reply({ ev: 'run_result', key, cmd, code: r.code, out: r.out, ms: r.ms }));
        return;
      }
      if (msg.op === 'fork') {
        let chat = mine.get(key);
        if (!chat && msg.token) { chat = await chatFor(msg); mine.set(key, chat); chat.subs.add({ ws, key }); }
        if (!chat || !chat.cid) { reply({ ev: 'error', key, text: 'fork: session not open' }); return; }
        try {
          const r = forkFrom(chat, String(msg.uuid || ''));
          const token = registry.upsert({ cid: r.cid, cwd: chat.cwd, name: r.name, state: 'stopped', mode: 'chat' });
          reply({ ev: 'forked', key, token, name: r.name });
        } catch (e) { reply({ ev: 'error', key, text: 'fork failed: ' + e.message }); }
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
        case 'model':
          if (msg.model) await chat.setModel(String(msg.model));
          if (msg.effort !== undefined) await chat.setEffort(msg.effort);
          break;
        case 'stats': {
          // not awaited: a fresh process takes a few seconds and the socket's other ops must not wait
          const kind = String(msg.kind || ''), req = msg.req, base = { ev: 'stats', key, kind, req };
          const fail = (e) => reply(Object.assign({}, base, { error: String((e && e.message) || e) }));
          chat.stats(kind).then((r) => reply(Object.assign({}, base, r)), fail);
          if (kind === 'usage') usageBehaviors(chat.cwd).then((b) => reply(Object.assign({}, base, { part: 'behaviors', behaviors: b })),
            (e) => reply(Object.assign({}, base, { part: 'behaviors', behaviors: null, error: String((e && e.message) || e) })));
          break;
        }
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
const CLAUDE_DIR = path.join(HOME, '.claude');
const TITLES = new Map();          // cid -> {file, size, custom, ai}
// Scan offsets are persisted: without this, the first /sessions after a restart rescans every
// transcript from byte 0 (~200 MB across many sessions) and freezes the whole server for seconds.
const TITLES_FILE = path.join(CLAUDE_DIR, 'web-titles.json');
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8')) || {}))
  if (v && typeof v === 'object' && v.file) TITLES.set(k, v); } catch (_) {}
let titlesSaveT = null;
function saveTitles() {
  clearTimeout(titlesSaveT);
  titlesSaveT = setTimeout(() => {
    try { const o = {}; for (const [k, v] of TITLES) o[k] = { file: v.file, size: v.size, custom: v.custom, ai: v.ai };
      fs.writeFileSync(TITLES_FILE, JSON.stringify(o)); } catch (_) {}
  }, 1000);
}
// A cold scan of a huge transcript is capped to its head and tail: title lines are appended
// events (ai-title right after the first messages, custom-title on rename), so the middle of a
// 30 MB file is the least likely place and the most expensive to read. The cached offset jumps
// to the full size, so later appends are scanned incrementally as before.
const TITLE_COLD_HEAD = 256 * 1024, TITLE_COLD_TAIL = 2 * 1024 * 1024;
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
      const regions = [];
      if (t.size === 0 && st.size > TITLE_COLD_HEAD + TITLE_COLD_TAIL) {        // cold, huge: head + tail
        regions.push([0, TITLE_COLD_HEAD], [st.size - TITLE_COLD_TAIL, st.size]);
        t.size = st.size; t.partial = '';
      } else {
        const start = Math.max(0, t.size - 1024) - (t.partial ? t.partial.length : 0);  // overlap: a line cut last time
        regions.push([Math.max(0, start), st.size]);
      }
      for (const [from, to] of regions) {
        const buf = Buffer.alloc(to - from); fs.readSync(fd, buf, 0, buf.length, from);
        let m; TITLE_RE.lastIndex = 0;
        while ((m = TITLE_RE.exec(buf.toString('utf8')))) {
          let v; try { v = JSON.parse('"' + m[2] + '"'); } catch (_) { v = m[2]; }
          if (m[1] === 'custom-title') t.custom = v; else t.ai = v;
        }
      }
    } finally { fs.closeSync(fd); }
    t.size = st.size;                       // common for both the cold scan and the incremental delta
    saveTitles();
  }
  return t;
}

async function setTitle(cid, cwd, title) {
  await sdkReady;
  if (sdk && sdk.renameSession) { await sdk.renameSession(cid, title, { dir: cwd }); return; }
  const f = transcriptPath(cid, cwd);                                           // SDK unavailable: same entry by hand
  if (!f) throw new Error('transcript not found');
  fs.appendFileSync(f, JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: cid }) + '\n');
}
async function rename(token, title) {
  title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!title) throw new Error('empty title');
  const rec = await registry.get(token);
  if (!rec || !rec.claudeSessionId) throw new Error('unknown session');
  await setTitle(rec.claudeSessionId, rec.cwd, title);
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

// workspaceHost: where /workspace lives on the host (PROJECT_DIR from the env file), so the
// launcher can offer "open in VS Code" for file links when the browser runs on that machine
async function info() {
  await sdkReady;
  return { enabled: !!sdk, error: loadError, workspace: WS_ROOT, workspaceHost: process.env.PROJECT_DIR || '' };
}

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

// Every sub-agent of a session the page may show: what the transcript tail says (collected by the
// reader while it reads the page, so no extra pass over a large file), overlaid with what the
// running process saw. An agent left "running" whose process is gone is "stopped": background
// agents die with the claude process.
function agentFacts(chat) {
  const out = {};
  if (chat.cid) {
    const entry = readerFor(chat);
    if (!entry.file) extendBack(entry, chat, PAGE_PROMPTS);
    for (const [k, a] of entry.agents || []) out[k] = Object.assign({}, a);
  }
  const live = chat.agentsView ? chat.agentsView() : {};
  for (const k of Object.keys(live)) out[k] = Object.assign(out[k] || {}, live[k]);
  for (const k of Object.keys(out)) {
    if (out[k].state === 'run' && !live[k]) out[k].state = 'stopped';     // launched by an earlier process
    for (const f of Object.keys(out[k])) if (out[k][f] === undefined) delete out[k][f];
  }
  return out;
}

// ---------- fork: a new session continuing from a chosen message ----------
// Claude Code transcripts are line-per-message files keyed by filename; a fork is a copy of the
// prefix (everything up to and including the chosen message) under a NEW session id, with the
// copied lines' sessionId rewritten. The original session stays untouched; sending a message to
// the fork resumes the new id and continues exactly from the fork point. A custom-title line is
// appended so "Fork: …" sticks as the session name.
function forkFrom(chat, uuid) {
  const f = transcriptPath(chat.cid, chat.cwd);
  if (!f) throw new Error('transcript not found');
  const text = fs.readFileSync(f, 'utf8');
  const lines = text.split('\n');
  const cut = lines.findIndex((l) => l.includes('"uuid":"' + uuid + '"'));
  if (cut < 0) throw new Error('message not found in transcript');
  // forking from a user prompt branches BEFORE it (re-ask differently); from an answer — after it
  let userType = false;
  try { userType = JSON.parse(lines[cut]).type === 'user'; } catch (_) {}
  const keep = userType ? cut : cut + 1;
  const newId = crypto.randomUUID();
  const prefix = lines.slice(0, keep)
    .map((l) => l.split(`"sessionId":"${chat.cid}"`).join(`"sessionId":"${newId}"`))
    .join('\n') + '\n';
  const title = (sessionTitles(chat.cid, chat.cwd) || {});
  const name = 'Fork: ' + (title.custom || title.ai || chat.name || path.basename(chat.cwd || 'session'));
  fs.writeFileSync(path.join(path.dirname(f), newId + '.jsonl'),
    prefix + `{"type":"custom-title","customTitle":${JSON.stringify(name)}}\n`);
  return { cid: newId, name };
}

module.exports = { Chat, ctxView, usageView, savedSession, launchDir, sessionTitles, tailPage, forkFrom, runInShell, agentUsage, agentFacts, handleUpgrade, decorate, dirs, stopByToken, info, rename, apiNew, apiStatus, getSdk,
  pendingPerms, answerPerm, sendTo, transcriptPath };
