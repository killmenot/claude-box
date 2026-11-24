'use strict';
// Task workspaces for the launcher: one folder per task, so many parallel tasks never share files.
//
//   WORKSPACE_DIR/repos/<repo>/            base clones — the source every task is cut from
//   WORKSPACE_DIR/tasks/<slug>/.task.json  what the task is (id, title, link, repos, branch, state)
//   WORKSPACE_DIR/tasks/<slug>/<repo>/     the task's own clone of <repo> on branch <slug>
//
// A task clone is a plain local `git clone` of the base repo (objects are copied locally, no
// network), with origin re-pointed at the real remote. Plain clones (not worktrees) keep working
// when the same folder is opened from the host, where /workspace has a different absolute path.
//
// Lifecycle: create -> work -> archive (branch is saved into the base repo, the clone is removed,
// .task.json stays) -> reopen (clone again, check the branch out) -> forget (remove the folder).
// Archiving refuses uncommitted changes, so nothing is lost by removing a clone.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = process.env.WORKSPACE_DIR || '/workspace';
const REPOS = path.join(ROOT, 'repos');
const TASKS = path.join(ROOT, 'tasks');
const META = '.task.json';

function git(args, opts) {
  opts = opts || {};
  return new Promise((res, rej) => execFile('git', args, {
    cwd: opts.cwd || ROOT, timeout: opts.timeout || 120000, maxBuffer: 16 << 20,
    env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }),
  }, (e, out, err) => {
    if (e) { const m = String(err || e.message).trim().split('\n').pop(); rej(new Error(m || 'git failed')); }
    else res(String(out).trim());
  }));
}
const gitOk = (args, opts) => git(args, opts).then(() => true, () => false);
const gitOut = (args, opts) => git(args, opts).catch(() => '');

function safeName(n) {
  n = String(n == null ? '' : n).trim();
  if (!n || n.length > 120 || n === '.' || n === '..' || /[\/\\\0]/.test(n) || n.startsWith('.')) throw new Error('invalid name: ' + n);
  return n;
}
// "PROJ-123", "Fix grafana alerts!" -> "PROJ-123-fix-grafana-alerts"
function slugify(key, title) {
  const t = String(title || '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-').slice(0, 48)
    .replace(/-+$/, '');
  const k = String(key || '').replace(/[^A-Za-z0-9_-]/g, '');
  return (k && t ? k + '-' + t : k || t || 'task').replace(/^[.-]+/, '');
}
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

function readMeta(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, META), 'utf8')); } catch (_) { return null; } }
function writeMeta(dir, m) {
  const f = path.join(dir, META), tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n'); fs.renameSync(tmp, f);
}
function taskDirs() {
  try { return fs.readdirSync(TASKS, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => path.join(TASKS, d.name)); }
  catch (_) { return []; }
}
function findTask(id) {
  for (const d of taskDirs()) { const m = readMeta(d); if (m && m.id === id) return { dir: d, meta: m }; }
  return null;
}
function bySlug(slug) {
  const dir = path.join(TASKS, safeName(slug)); const meta = readMeta(dir);
  if (!meta) throw new Error('no such task: ' + slug);
  return { dir, meta };
}

// ---------- base repos ----------
async function originUrl(dir) { return gitOut(['-C', dir, 'remote', 'get-url', 'origin']); }
function isRepo(dir) { return fs.existsSync(path.join(dir, '.git')); }
async function repos() {
  let ents = [];
  try { ents = fs.readdirSync(REPOS, { withFileTypes: true }); } catch (_) {}
  const out = [];
  for (const d of ents) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const p = path.join(REPOS, d.name); if (!isRepo(p)) continue;
    out.push({ name: d.name, path: p, remote: (await originUrl(p)).replace(/\/\/[^@/]+@/, '//') });
  }
  return out;
}
// candidates for "add a base repo from an existing folder": top-level git repos in the workspace
function repoCandidates() {
  let ents = [];
  try { ents = fs.readdirSync(ROOT, { withFileTypes: true }); } catch (_) {}
  return ents.filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'repos' && d.name !== 'tasks' &&
    fs.existsSync(path.join(ROOT, d.name, '.git'))).map((d) => d.name).sort();
}
const JOBS = new Map(); let jobSeq = 0;
function job(name, fn) {
  const id = 'r' + (++jobSeq), j = { id, name, state: 'running', error: '', started: Date.now() };
  JOBS.set(id, j);
  fn().then(() => { j.state = 'done'; }, (e) => { j.state = 'error'; j.error = String(e.message || e).slice(0, 300); });
  return j;
}
// {url} clones a remote; {from} makes a local clone of an existing workspace folder (no network),
// then points origin at that folder's real remote.
function addRepo(o) {
  fs.mkdirSync(REPOS, { recursive: true });
  if (o.from) {
    const src = path.join(ROOT, safeName(o.from));
    if (!isRepo(src)) throw new Error('not a git repository: ' + o.from);
    const name = safeName(o.name || o.from.replace(/\.(develop\d*|main|master)$/, ''));
    const dst = path.join(REPOS, name); if (fs.existsSync(dst)) throw new Error('already exists: repos/' + name);
    return job(name, async () => {
      const url = await originUrl(src);
      await git(['clone', '-q', '--', src, dst], { timeout: 30 * 60000 });
      if (url) await git(['-C', dst, 'remote', 'set-url', 'origin', url]);
    });
  }
  const url = String(o.url || '').trim();
  if (!/^(https?:\/\/|ssh:\/\/|git@[\w.-]+:)[^\s]+$/.test(url)) throw new Error('unsupported git URL');
  const name = safeName(o.name || (/([^/:]+?)(?:\.git)?\/?$/.exec(url) || [])[1] || '');
  const dst = path.join(REPOS, name); if (fs.existsSync(dst)) throw new Error('already exists: repos/' + name);
  return job(name, () => git(['clone', '-q', '--', url, dst], { timeout: 30 * 60000 }));
}

// default branch of a base repo's origin, e.g. "main"
async function defaultBranch(base) {
  const h = await gitOut(['-C', base, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (h) return h.replace(/^origin\//, '');
  for (const b of ['main', 'master', 'develop']) if (await gitOk(['-C', base, 'rev-parse', '--verify', '-q', 'origin/' + b])) return b;
  return (await gitOut(['-C', base, 'rev-parse', '--abbrev-ref', 'HEAD'])) || 'main';
}

// clone base -> dir and check out `branch`: the saved branch if the base has it (reopen),
// otherwise a new branch from the base's freshest origin/<default>.
async function cutClone(repo, dir, branch) {
  const base = path.join(REPOS, safeName(repo));
  if (!isRepo(base)) throw new Error('base repo not found: repos/' + repo);
  const saved = await gitOk(['-C', base, 'rev-parse', '--verify', '-q', 'refs/heads/' + branch]);
  let from = '';
  if (!saved) {
    await gitOk(['-C', base, 'fetch', '-q', 'origin'], { timeout: 120000 });       // best effort (needs creds)
    const def = await defaultBranch(base);
    from = (await gitOut(['-C', base, 'rev-parse', '--verify', '-q', 'origin/' + def])) ||
           (await git(['-C', base, 'rev-parse', 'HEAD']));
  }
  await git(['clone', '-q', '--no-checkout', '--', base, dir], { timeout: 30 * 60000 });
  if (saved) await git(['-C', dir, 'checkout', '-q', '-b', branch, 'origin/' + branch]);
  else await git(['-C', dir, 'checkout', '-q', '-b', branch, from]);
  const url = await originUrl(base);
  if (url) await git(['-C', dir, 'remote', 'set-url', 'origin', url]);
  return { name: repo, branch, base: from || 'saved' };
}

// "https://github.com/Org/Repo.git", "git@github.com:org/repo" -> "github.com/org/repo" (to compare remotes)
function remoteId(u) {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/i.exec(String(u || '').trim());
  return m ? (m[1] + '/' + m[2]).toLowerCase() : '';
}
// The base repo for a remote URL: the one in repos/ whose origin is that URL, or a fresh clone of it
// there (named after the repo, or owner-repo when the short name is taken by another remote).
const BASE_BUSY = new Map();
async function ensureBase(url) {
  url = String(url || '').trim();
  if (!/^(https?:\/\/|ssh:\/\/|git@[\w.-]+:)[^\s]+$/.test(url)) throw new Error('unsupported git URL');
  const want = remoteId(url);
  for (const r of await repos()) if (remoteId(r.remote) === want) return r.name;
  if (BASE_BUSY.has(want)) return BASE_BUSY.get(want);
  const parts = want.split('/'), short = safeName(parts[parts.length - 1]);
  const name = fs.existsSync(path.join(REPOS, short)) ? safeName(parts.slice(-2).join('-')) : short;
  const p = (async () => {
    fs.mkdirSync(REPOS, { recursive: true });
    const dst = path.join(REPOS, name);
    if (fs.existsSync(dst)) throw new Error('already exists: repos/' + name);
    await git(['clone', '-q', '--', url, dst], { timeout: 30 * 60000 });
    return name;
  })().finally(() => BASE_BUSY.delete(want));
  BASE_BUSY.set(want, p);
  return p;
}

// ---------- tasks ----------
// o: {id?, key?, title, url?, text?, source?, repos: [name | {url}]}; returns the existing task for a
// known id. A {url} repo is taken from repos/ when it is there already, otherwise cloned there first.
async function open(o) {
  const key = String(o.key || '').trim().toUpperCase();
  const id = String(o.id || (JIRA_KEY.test(key) ? key : '') || '').trim().slice(0, 120);
  if (id) { const ex = findTask(id); if (ex) return Object.assign({ created: false }, await describe(ex.dir, ex.meta)); }
  const title = String(o.title || '').trim().slice(0, 200);
  if (!title && !key) throw new Error('a task needs a title or a key');
  fs.mkdirSync(TASKS, { recursive: true });
  // a title that is just the key again ("PROJ-456") adds nothing to the folder name
  let slug = slugify(key, title.toUpperCase() === key ? '' : title), dir = path.join(TASKS, slug);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(TASKS, slug + '-' + i);
  slug = path.basename(dir);
  fs.mkdirSync(dir);
  const meta = {
    id: id || 'local:' + slug, key: key || '', title: title || key, url: String(o.url || '').slice(0, 500),
    source: String(o.source || (JIRA_KEY.test(key) ? 'jira' : 'manual')).slice(0, 40),
    text: String(o.text || '').slice(0, 20000), branch: slug, repos: [], created: Date.now(), archived: false,
  };
  writeMeta(dir, meta);
  const want = (Array.isArray(o.repos) ? o.repos : []).filter(Boolean).slice(0, 10);
  const errors = [];
  for (const w of want) {
    const label = typeof w === 'object' ? String(w.url || '') : String(w);
    try {
      const r = typeof w === 'object' ? await ensureBase(w.url) : String(w);
      meta.repos.push(await cutClone(r, path.join(dir, safeName(r)), slug));
    } catch (e) { errors.push(label + ': ' + e.message); }
  }
  writeMeta(dir, meta);
  return Object.assign({ created: true, errors }, await describe(dir, meta));
}

async function repoState(dir, branch) {
  if (!isRepo(dir)) return { present: false };
  const st = await gitOut(['-C', dir, 'status', '--porcelain']);
  const head = (await gitOut(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])) || branch;
  const unpushed = parseInt(await gitOut(['-C', dir, 'rev-list', '--count', 'HEAD', '--not', '--remotes=origin']), 10) || 0;
  const def = await defaultBranch(dir);
  const merged = await gitOk(['-C', dir, 'merge-base', '--is-ancestor', 'HEAD', 'origin/' + def]);
  return { present: true, branch: head, dirty: st ? st.split('\n').length : 0, unpushed, merged, def };
}
function lastTouched(dir) {
  let t = 0;
  try { t = fs.statSync(dir).mtimeMs; } catch (_) {}
  try { for (const n of fs.readdirSync(dir)) { try { t = Math.max(t, fs.statSync(path.join(dir, n)).mtimeMs); } catch (_) {} } } catch (_) {}
  return t;
}
async function describe(dir, meta) {
  const rs = [];
  for (const r of meta.repos || []) rs.push(Object.assign({ name: r.name }, await repoState(path.join(dir, r.name), meta.branch)));
  const present = rs.filter((r) => r.present);
  let state = 'clean';
  if (meta.archived) state = 'archived';
  else if (present.some((r) => r.dirty)) state = 'dirty';
  else if (present.some((r) => r.unpushed && !r.merged)) state = 'unpushed';
  return { slug: path.basename(dir), path: dir, id: meta.id, key: meta.key, title: meta.title, url: meta.url,
    source: meta.source, branch: meta.branch, createdAt: meta.created, archived: !!meta.archived,
    touched: lastTouched(dir), state, repos: rs, text: meta.text };
}
async function list() {
  const out = [];
  for (const d of taskDirs()) { const m = readMeta(d); if (m) out.push(await describe(d, m)); }
  out.sort((a, b) => (a.archived - b.archived) || (b.touched - a.touched));
  return { root: ROOT, tasks: out, repos: await repos(), candidates: repoCandidates(),
    jobs: [...JOBS.values()].slice(-10) };
}

// save each repo's branch into its base (refs/heads/<branch>), then remove the clones
async function archive(slug, force) {
  const { dir, meta } = bySlug(slug);
  if (meta.archived) return describe(dir, meta);
  for (const r of meta.repos || []) {
    const rd = path.join(dir, r.name); if (!isRepo(rd)) continue;
    const s = await repoState(rd, meta.branch);
    if (s.dirty && !force) throw new Error(r.name + ' has ' + s.dirty + ' uncommitted change(s) — commit or discard them first');
  }
  for (const r of meta.repos || []) {
    const rd = path.join(dir, r.name); if (!isRepo(rd)) continue;
    const base = path.join(REPOS, r.name), br = (await gitOut(['-C', rd, 'rev-parse', '--abbrev-ref', 'HEAD'])) || meta.branch;
    if (isRepo(base)) await git(['-C', base, 'fetch', '-q', rd, '+refs/heads/' + br + ':refs/heads/' + meta.branch]);
    else throw new Error('base repo missing: repos/' + r.name + ' — cannot save the branch');
    fs.rmSync(rd, { recursive: true, force: true });
  }
  meta.archived = true; meta.archivedAt = Date.now(); writeMeta(dir, meta);
  return describe(dir, meta);
}
async function reopen(slug) {
  const { dir, meta } = bySlug(slug);
  for (const r of meta.repos || []) {
    const rd = path.join(dir, r.name); if (isRepo(rd)) continue;
    await cutClone(r.name, rd, meta.branch);
  }
  meta.archived = false; delete meta.archivedAt; writeMeta(dir, meta);
  return describe(dir, meta);
}
async function addRepos(slug, names) {
  const { dir, meta } = bySlug(slug);
  for (const n of (names || []).map(String)) {
    if ((meta.repos || []).some((r) => r.name === n)) continue;
    meta.repos.push(await cutClone(n, path.join(dir, safeName(n)), meta.branch));
  }
  writeMeta(dir, meta); return describe(dir, meta);
}
// fetch every clone of the task from the real remote (updates the merged / unpushed state)
async function refresh(slug) {
  const { dir, meta } = bySlug(slug);
  for (const r of meta.repos || []) { const rd = path.join(dir, r.name); if (isRepo(rd)) await gitOk(['-C', rd, 'fetch', '-q', 'origin']); }
  return describe(dir, meta);
}
// only archived tasks can be forgotten (their branches stay in the base repos)
function forget(slug) {
  const { dir, meta } = bySlug(slug);
  if (!meta.archived) throw new Error('archive the task first');
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

module.exports = { list, open, archive, reopen, addRepos, refresh, forget, addRepo, slugify, remoteId, ensureBase, TASKS, REPOS };
