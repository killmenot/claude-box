'use strict';
// Archive, restore and delete sessions, and the Storage list in Settings — nothing runs on its own,
// every step is the user's click. Served by web-sidecar.js:
//   GET  /sessions/storage                 every session with its folder, the folder's size, archived or not
//   POST /sessions/archive  {id, force}    the folder goes, the conversation stays (gzipped), restorable
//   POST /sessions/restore  {id}           the conversation back in place, a task's worktrees cut again
//   POST /sessions/remove   {id, force}    the folder and the conversation go
// Without force, archive/remove only report what would be lost ({confirm: true, issues}) and do nothing.
//
// Whose folder may go: only a session's own folder under /workspace/tasks/<x> or /workspace/tmp/<x>,
// and only when no other (not archived) session works in it. A project folder (/workspace/<repo>) and
// /workspace/repos are never touched. A task folder goes through the task archive (web-tasks.js): its
// worktrees are removed, their branches stay in /workspace/repos, so committed work is never lost.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');

const ROOT = process.env.WORKSPACE_DIR || '/workspace';
const HOME = process.env.HOME || os.homedir();
const ARCH = process.env.WEB_ARCHIVE_DIR || path.join(HOME, '.claude', 'web-archive');
const CLAUDE = path.join(HOME, '.claude');
let deps = null;   // {registry, tasks, transcriptPath, stop}

function init(d) { deps = d; }
function run(cmd, args, opts) {
  return new Promise((res) => execFile(cmd, args, Object.assign({ timeout: 60000, maxBuffer: 8 << 20 }, opts || {}),
    (e, out) => res(e ? null : String(out || ''))));
}

// the session's own folder: /workspace/tasks/<x> or /workspace/tmp/<x> (the cwd or a parent of it)
function folderOf(cwd) {
  const rel = path.relative(ROOT, path.resolve(String(cwd || '/')));
  const m = /^(tasks|tmp)\/([^/]+)/.exec(rel.split(path.sep).join('/'));
  if (!m || rel.startsWith('..')) return null;
  return { kind: m[1] === 'tasks' ? 'task' : 'tmp', name: m[2], dir: path.join(ROOT, m[1], m[2]) };
}
function sharedWith(rec, f, all) {
  return all.filter((r) => r.token !== rec.token && !r.archived && r.cwd && (r.cwd === f.dir || r.cwd.startsWith(f.dir + path.sep)));
}
async function sizeOf(dir) {
  const out = await run('du', ['-sk', dir]);
  return out ? parseInt(out, 10) * 1024 : 0;
}
// git repos in the folder (the folder itself or one level down)
function reposIn(dir) {
  const out = [];
  if (fs.existsSync(path.join(dir, '.git'))) out.push(dir);
  let subs = []; try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')); } catch (_) {}
  for (const e of subs) if (fs.existsSync(path.join(dir, e.name, '.git'))) out.push(path.join(dir, e.name));
  return out;
}
// what deleting the folder would lose: uncommitted changes always; for a plain (tmp) folder also
// commits on no remote and the files themselves
async function losses(f) {
  const issues = [];
  for (const r of reposIn(f.dir)) {
    const name = path.relative(f.dir, r) || path.basename(r);
    const dirty = ((await run('git', ['-C', r, 'status', '--porcelain'])) || '').split('\n').filter(Boolean).length;
    if (dirty) issues.push(`${name}: ${dirty} uncommitted change(s)`);
    if (f.kind === 'tmp') {
      const ahead = ((await run('git', ['-C', r, 'log', '--oneline', '--branches', '--not', '--remotes'])) || '').split('\n').filter(Boolean).length;
      if (ahead) issues.push(`${name}: ${ahead} commit(s) on no remote`);
    }
  }
  if (f.kind === 'tmp') {
    let n = 0; try { n = fs.readdirSync(f.dir).length; } catch (_) {}
    if (n) issues.push(`the files in ${path.relative(ROOT, f.dir)} are deleted, not kept`);
  }
  return issues;
}
async function inspect(token) {
  const all = deps.registry.list(), rec = all.find((r) => r.token === token);
  if (!rec) throw new Error('no such session');
  const f = rec.archived ? null : folderOf(rec.cwd);
  const shared = f ? sharedWith(rec, f, all) : [];
  const own = f && !shared.length && fs.existsSync(f.dir) ? f : null;
  return { rec, folder: own, sharedWith: shared.map((r) => r.title || r.name || r.token), issues: own ? await losses(own) : [], size: own ? await sizeOf(own.dir) : 0 };
}

async function dropFolder(f) {
  if (f.kind === 'task') {
    const t = await deps.tasks.archive(f.name, true);              // worktrees removed, branches stay in repos/
    return { task: f.name, archived: !!(t && t.archived) };
  }
  fs.rmSync(f.dir, { recursive: true, force: true });
  return { removed: f.dir };
}
async function gzip(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst + '.' + process.pid + '.tmp';
  await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 9 }), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dst);
}
async function gunzip(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst + '.' + process.pid + '.tmp';
  await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dst);
}

async function archive(token, force) {
  const info = await inspect(token), rec = info.rec;
  if (rec.archived) return { ok: true, already: true };
  if (info.issues.length && !force) return { confirm: true, issues: info.issues, folder: info.folder && info.folder.dir, size: info.size };
  await deps.stop(token);
  const done = info.folder ? await dropFolder(info.folder) : null;
  const meta = { at: Date.now(), folder: info.folder ? info.folder.dir : '', kind: info.folder ? info.folder.kind : '', name: info.folder ? info.folder.name : '' };
  const t = rec.claudeSessionId && deps.transcriptPath(rec.claudeSessionId, rec.cwd);
  if (t) {
    const gz = path.join(ARCH, rec.claudeSessionId + '.jsonl.gz');
    await gzip(t, gz);
    fs.unlinkSync(t);
    Object.assign(meta, { gz, transcript: t });
  }
  deps.registry.patch(token, { archived: meta, state: 'stopped' });
  return { ok: true, folder: done, freed: info.size };
}

async function restore(token) {
  const rec = deps.registry.get(token);
  if (!rec || !rec.archived) throw new Error('not archived');
  const a = rec.archived;
  if (a.gz && fs.existsSync(a.gz)) { await gunzip(a.gz, a.transcript); fs.unlinkSync(a.gz); }
  if (a.kind === 'task' && a.name) await deps.tasks.reopen(a.name);
  else if (a.kind === 'tmp' && a.folder) fs.mkdirSync(a.folder, { recursive: true });
  deps.registry.patch(token, { archived: null });
  return { ok: true };
}

// a session's leftovers in ~/.claude: checkpoints (file-history) and todo lists
function dropLeftovers(cid) {
  if (!cid || !/^[\w-]+$/.test(cid)) return;
  try { fs.rmSync(path.join(CLAUDE, 'file-history', cid), { recursive: true, force: true }); } catch (_) {}
  try { for (const f of fs.readdirSync(path.join(CLAUDE, 'todos'))) if (f.startsWith(cid)) fs.rmSync(path.join(CLAUDE, 'todos', f), { force: true }); } catch (_) {}
}
async function remove(token, force) {
  const info = await inspect(token), rec = info.rec;
  if (info.issues.length && !force) return { confirm: true, issues: info.issues, folder: info.folder && info.folder.dir, size: info.size };
  await deps.stop(token);
  if (info.folder) {
    await dropFolder(info.folder);
    if (info.folder.kind === 'task') { try { deps.tasks.forget(info.folder.name); } catch (_) {} }
  }
  const a = rec.archived;
  if (a && a.kind && a.folder && a.kind === 'task' && a.name) { try { deps.tasks.forget(a.name); } catch (_) {} }
  if (a && a.gz) { try { fs.rmSync(a.gz, { force: true }); } catch (_) {} }
  const t = rec.claudeSessionId && deps.transcriptPath(rec.claudeSessionId, rec.cwd);
  if (t) { try { fs.rmSync(t, { force: true }); } catch (_) {} }
  dropLeftovers(rec.claudeSessionId);
  deps.registry.remove(token);
  return { ok: true, freed: info.size };
}

// Settings > Storage: every session, its own folder and that folder's size (largest first)
async function storage() {
  const all = deps.registry.list(), rows = [];
  const sizes = new Map();
  for (const r of all) {
    const f = r.archived ? null : folderOf(r.cwd);
    const own = f && !sharedWith(r, f, all).length && fs.existsSync(f.dir) ? f : null;
    if (own && !sizes.has(own.dir)) sizes.set(own.dir, await sizeOf(own.dir));
    let tsize = 0;
    const t = r.claudeSessionId && !r.archived && deps.transcriptPath(r.claudeSessionId, r.cwd);
    try { tsize = t ? fs.statSync(t).size : (r.archived && r.archived.gz ? fs.statSync(r.archived.gz).size : 0); } catch (_) {}
    rows.push({ token: r.token, title: r.title || r.name || '', cwd: r.cwd || '', lastActivity: r.lastActivity || 0, live: !!r.live,
      archived: r.archived ? { at: r.archived.at } : null, folder: own ? own.dir : '', kind: own ? own.kind : '',
      folderSize: own ? sizes.get(own.dir) : 0, conversationSize: tsize });
  }
  rows.sort((a, b) => (b.folderSize - a.folderSize) || (b.lastActivity - a.lastActivity));
  return { rows };
}

module.exports = { init, folderOf, inspect, archive, restore, remove, storage, ARCH };
