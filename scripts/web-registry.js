#!/usr/bin/env node
'use strict';
// On-disk registry of web sessions (survives a container restart, unlike tmux).
// One JSON object keyed by token: {token, claudeSessionId, cwd, name, state, tmuxSession, title, mode, model, lastActivity}. model: a chat's pick, "provider/model id" (web-models.js).
//
// Used as a library by the sidecar / web chat, and as a CLI (`claude-web-registry`) by the two
// remaining shell pieces — the claude-notify hook and the ttyd picker (web-menu.sh):
//   upsert --claude-id <id> --cwd <p> --name <n> --state <s> --tmux <sess> [--title t] [--mode chat|console] -> token
//   get <token>    -> JSON of the record (exit 1 if not found)
//   list           -> JSON array, newest first, with a live flag
//   delete <token> -> kill the session's tmux (only if it is provably this record's), move the record to the trash
//   trash          -> JSON array of deleted records, most recently deleted first
//   untrash <token> -> move a deleted record back into the registry (its transcript was never touched)
//   purge <token>  -> drop a deleted record for good (the transcript itself stays on disk)
//   owns <token>   -> print the token's live tmux session name (exit 1 if it has none)
//   snapshot       -> save the tokens of the currently running sessions (restored after a restart)
//   restore        -> after a container restart, recreate those sessions with claude --resume
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const HOME = process.env.HOME || '/home/node';
const REG = process.env.CLAUDE_WEB_REGISTRY || path.join(HOME, '.claude', 'web-sessions.json');
const LIVE = process.env.CLAUDE_WEB_LIVE || path.join(path.dirname(REG), 'web-live-sessions.json');
// Deleted records: {<token>: {...record, deletedAt, category?}}. Kept TRASH_DAYS, then dropped.
const TRASH = process.env.CLAUDE_WEB_TRASH || path.join(path.dirname(REG), 'web-sessions-trash.json');
const UNDEAD_SEC = 10;
const TRASH_DAYS = (() => { const n = parseFloat(process.env.CLAUDE_WEB_TRASH_DAYS || '30'); return n > 0 ? n : 30; })();
const PREVIEWS = path.join(HOME, '.claude', 'web-previews');

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---------- storage ----------
function readJson(file) {
  try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; }
  catch (_) { return {}; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);                      // atomic: readers never see a half-written file
}
const read = () => readJson(REG);
const write = (obj) => writeJson(REG, obj);
// The trash without its expired entries (older than TRASH_DAYS).
function readTrash() {
  const t = readJson(TRASH), cut = Math.floor(Date.now() / 1000) - TRASH_DAYS * 86400;
  for (const k of Object.keys(t)) if (!t[k] || (t[k].deletedAt || 0) < cut) delete t[k];
  return t;
}
// Read-modify-write under a lock: the hook (one process per Claude event) and the sidecar write
// concurrently. mkdir is atomic; a lock older than 10s is a crashed holder and is broken.
function locked(fn) {
  const dir = REG + '.lockdir';
  fs.mkdirSync(path.dirname(REG), { recursive: true });
  let held = false;
  for (let i = 0; i < 250 && !held; i++) {
    try { fs.mkdirSync(dir); held = true; }
    catch (e) {
      if (e.code !== 'EEXIST') break;
      try { if (Date.now() - fs.statSync(dir).mtimeMs > 10000) fs.rmdirSync(dir); } catch (_) {}
      sleepSync(20);
    }
  }
  try { return fn(); } finally { if (held) try { fs.rmdirSync(dir); } catch (_) {} }
}

// ---------- tmux ----------
function tmux(args) {
  const t0 = Date.now();
  try { return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (_) { return null; }
  finally {
    const dt = Date.now() - t0;
    if (dt > 300) console.error(`[tmux] ${args[0]} took ${dt}ms at ${new Date().toISOString()}`);   // the tmux server briefly stalling blocks the whole node loop
  }
}
// name -> {stamp, title} of every live tmux session, in ONE tmux call.
function tmuxSessions() {
  const out = tmux(['list-sessions', '-F', '#{session_name}\t#{@cbtoken}\t#{pane_title}']);
  const m = new Map();
  for (const line of (out || '').split('\n')) {
    if (!line) continue;
    const [name, stamp, ...t] = line.split('\t');
    m.set(name, { stamp: stamp || '', title: t.join('\t') });
  }
  return m;
}

// Does the live tmux session <name> belong to the record of <token>? The stored name is NOT proof
// of identity: web-N names are recycled (web-menu.sh:next_name) and rename-session moves them
// freely, so after a restart a dead record's name is routinely taken by an unrelated session.
// Proof is the @cbtoken stamp put on by claude-notify / the resume path. A session with no stamp
// predates stamping: then the name is all we have, and we trust it only if a single record claims it.
function ownsSession(reg, sessions, name, token) {
  if (!name) return false;
  const s = sessions.get(name);
  if (!s) return false;
  if (s.stamp) return s.stamp === token;
  return Object.values(reg).filter((r) => r.tmuxSession === name).length === 1;
}

// ---------- operations ----------
function genToken() { return crypto.randomBytes(4).toString('hex'); }

function upsert(f) {
  if (!f || !f.cid) throw new Error('upsert: claude id required');
  return locked(() => {
    const reg = read();
    let token = Object.keys(reg).find((t) => reg[t].claudeSessionId === f.cid);
    let prev = token ? reg[token] : null;
    if (!token) {
      // a deleted session that is running again (resumed by hand) leaves the trash under its old token
      const trash = readTrash(), tt = Object.keys(trash).find((t) => trash[t].claudeSessionId === f.cid);
      // ...but not the last hook / state event of the process that the delete itself just stopped
      if (tt && Date.now() / 1000 - (trash[tt].deletedAt || 0) < UNDEAD_SEC) return '';
      if (tt) { token = tt; prev = trash[tt]; delete trash[tt]; writeJson(TRASH, trash); }
    }
    token = token || genToken();
    prev = prev || {};
    reg[token] = {
      token, claudeSessionId: f.cid, cwd: f.cwd || '', name: f.name || '', state: f.state || '',
      tmuxSession: f.tmux || '',
      title: f.title || prev.title || '',
      mode: f.mode || prev.mode || '',
      model: f.model || prev.model || '',
      lastActivity: Math.floor(Date.now() / 1000),
    };
    write(reg);
    return token;
  });
}

function get(token) { return read()[token] || null; }

function list() {
  const reg = read(), sessions = tmuxSessions();
  return Object.values(reg).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)).map((r) => {
    const live = ownsSession(reg, sessions, r.tmuxSession, r.token);
    // a live session's CURRENT pane title (Claude's own) beats the one stored at hook time
    const pt = live ? sessions.get(r.tmuxSession).title : '';
    return Object.assign({}, r, { live, title: pt || r.title || '' });
  });
}

function owns(token) {
  const reg = read(), rec = reg[token];
  return rec && ownsSession(reg, tmuxSessions(), rec.tmuxSession, token) ? rec.tmuxSession : null;
}

// set or clear extra fields of a record (archived: see web-archive.js); null removes a field
function patch(token, fields) {
  return locked(() => {
    const reg = read(), rec = reg[token];
    if (!rec) return null;
    for (const [k, v] of Object.entries(fields || {})) { if (v === null || v === undefined) delete rec[k]; else rec[k] = v; }
    write(reg);
    return rec;
  });
}

// Delete from the dashboard: stop the session and move its record to the trash. `extra` is kept
// with it (the sidecar stores the session's category there, to put it back on restore).
function remove(token, extra) {
  return locked(() => {
    const reg = read(), rec = reg[token];
    // only if the session is still THIS record's — a recycled name would kill a stranger's work
    if (rec && ownsSession(reg, tmuxSessions(), rec.tmuxSession, token)) tmux(['kill-session', '-t', '=' + rec.tmuxSession]);
    if (rec) {
      const trash = readTrash();
      trash[token] = Object.assign({}, rec, extra || {}, { deletedAt: Math.floor(Date.now() / 1000) });
      writeJson(TRASH, trash);
    }
    delete reg[token];
    write(reg);
    try { fs.unlinkSync(path.join(PREVIEWS, token + '.ansi')); } catch (_) {}
    return true;
  });
}

function trash() {
  return Object.values(readTrash()).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
}

// Put a deleted record back. It comes back as just used, so it lands among the recent sessions
// rather than in the collapsed "Older" group. -> the restored record (with its stored extras), or null.
function untrash(token) {
  return locked(() => {
    const t = readTrash(), rec = t[token];
    if (!rec) return null;
    delete t[token];
    const reg = read();
    // resumed meanwhile under a new token: that record stands, the trashed one just goes
    const other = Object.values(reg).find((r) => r.claudeSessionId === rec.claudeSessionId);
    if (!other) {
      const r = Object.assign({}, rec, { state: '', lastActivity: Math.floor(Date.now() / 1000) });
      delete r.deletedAt; delete r.category;
      reg[token] = r;
      write(reg);
    }
    writeJson(TRASH, t);
    return Object.assign({}, other || reg[token], { category: rec.category || '' });
  });
}

function purge(token) {
  return locked(() => {
    const t = readTrash();
    const had = token in t;
    delete t[token];
    writeJson(TRASH, t);
    return had;
  });
}

// Remember which sessions are running RIGHT NOW, so a container restart can bring them back.
// A tmux session may own several records (after /clear Claude starts a new id in the same pane)
// -> keep only the most recently active record per tmux session.
function snapshot() {
  const reg = read(), alive = tmuxSessions(), best = new Map();
  for (const r of Object.values(reg)) {
    if (!alive.has(r.tmuxSession)) continue;
    const b = best.get(r.tmuxSession);
    if (!b || (r.lastActivity || 0) > (b.lastActivity || 0)) best.set(r.tmuxSession, r);
  }
  const tmp = `${LIVE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...best.values()].map((r) => r.token)));
  fs.renameSync(tmp, LIVE);
}

// Bring back the sessions of the last snapshot: each gets its tmux session (same name as before)
// running `claude --resume <id>` in its original cwd, stamped with its token.
// A run that never saved a conversation (an SDK job, a one-off -p call) has nothing to resume.
function hasTranscript(id) {
  const dir = path.join(HOME, '.claude', 'projects');
  if (!fs.existsSync(dir)) return false;
  try { return fs.readdirSync(dir).some((d) => fs.existsSync(path.join(dir, d, id + '.jsonl'))); } catch (_) { return true; }
}
function restore(log = (s) => console.error(s)) {
  let toks = [];
  try { toks = JSON.parse(fs.readFileSync(LIVE, 'utf8')); } catch (_) { return; }
  const reg = read();
  for (const tok of Array.isArray(toks) ? toks : []) {
    const r = reg[tok];
    if (!r) continue;                                             // deleted from the dashboard meanwhile
    const sess = r.tmuxSession || 'web-' + tok;
    if (!r.claudeSessionId || !r.cwd || !fs.existsSync(r.cwd)) { log(`restore: skip ${sess} (folder ${r.cwd} is gone)`); continue; }
    if (!hasTranscript(r.claudeSessionId)) { log(`restore: skip ${sess} (no transcript for ${r.claudeSessionId})`); continue; }
    if (tmux(['has-session', '-t', '=' + sess]) !== null) continue;   // already running
    const ok = spawnSync('tmux', ['-u', 'new-session', '-d', '-s', sess, '-c', r.cwd, 'claude-default', '--resume', r.claudeSessionId],
      { stdio: 'ignore' }).status === 0;
    if (ok) {
      tmux(['set-option', '-t', '=' + sess + ':', '@cbtoken', tok]);   // '=name:' — set-option rejects a bare '=name'
      log(`restore: ${sess} -> claude --resume ${r.claudeSessionId} (${r.cwd})`);
    } else log(`restore: failed to start ${sess}`);
    sleepSync(500);                                  // stagger startups: they all touch ~/.claude.json
  }
}

module.exports = { REG, TRASH, upsert, get, list, owns, patch, remove, trash, untrash, purge, snapshot, restore };

// ---------- CLI ----------
if (require.main === module) {
  const [cmd, ...a] = process.argv.slice(2);
  const out = (s) => process.stdout.write(s);
  try {
    switch (cmd) {
      case 'upsert': {
        const f = {};
        const keys = { '--claude-id': 'cid', '--cwd': 'cwd', '--name': 'name', '--state': 'state',
          '--tmux': 'tmux', '--title': 'title', '--mode': 'mode' };
        for (let i = 0; i < a.length; i++) if (keys[a[i]]) f[keys[a[i]]] = a[++i] || '';
        if (!f.cid) { console.error('upsert: --claude-id required'); process.exit(2); }
        out(upsert(f));
        break;
      }
      case 'get': { const r = get(a[0] || ''); if (!r) process.exit(1); out(JSON.stringify(r) + '\n'); break; }
      case 'list': out(JSON.stringify(list()) + '\n'); break;
      case 'delete': if (!a[0]) { console.error('delete: token required'); process.exit(2); } remove(a[0]); out('ok'); break;
      case 'trash': out(JSON.stringify(trash()) + '\n'); break;
      case 'untrash': { if (!a[0]) { console.error('untrash: token required'); process.exit(2); } const r = untrash(a[0]); if (!r) process.exit(1); out(r.token); break; }
      case 'purge': if (!a[0]) { console.error('purge: token required'); process.exit(2); } if (!purge(a[0])) process.exit(1); out('ok'); break;
      case 'owns': { if (!a[0]) { console.error('owns: token required'); process.exit(2); } const s = owns(a[0]); if (!s) process.exit(1); out(s); break; }
      case 'snapshot': snapshot(); break;
      case 'restore': restore(); break;
      default: console.error('usage: claude-web-registry upsert|get|list|delete|trash|untrash|purge|owns|snapshot|restore'); process.exit(2);
    }
  } catch (e) { console.error('claude-web-registry:', e.message); process.exit(1); }
}
