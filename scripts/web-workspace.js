'use strict';
// claude-box workspace manager for the launcher's Workspace page: a small file manager over
// /workspace — browse folders, create, rename, copy, move, delete (to a trash folder), upload,
// download, and clone git repositories. Loaded by web-sidecar.js.
// Every path is a path RELATIVE to WORKSPACE_DIR and is confined to it (no "..", no symlink
// escapes); names of new entries are single path segments.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(process.env.WORKSPACE_DIR || '/workspace');
const TRASH = '.trash';
const UPLOAD_MAX = parseInt(process.env.WEB_UPLOAD_MAX_MB || '2048', 10) * 1048576;
let REAL_ROOT = ROOT; try { REAL_ROOT = fs.realpathSync(ROOT); } catch (_) {}

function safeName(n) {
  n = String(n == null ? '' : n).trim();
  if (!n || n.length > 200 || n === '.' || n === '..' || /[\/\\\0]/.test(n)) throw new Error('invalid name: ' + JSON.stringify(n));
  return n;
}
// relative path -> absolute path inside ROOT (the target itself may not exist yet)
function abs(rel) {
  rel = String(rel == null ? '' : rel).replace(/^\/+|\/+$/g, '');
  if (rel.split('/').some((s) => s === '..' || s === '.' || s.includes('\0'))) throw new Error('invalid path');
  const p = path.resolve(ROOT, rel);
  if (p !== ROOT && !p.startsWith(ROOT + '/')) throw new Error('path outside the workspace');
  // the deepest existing ancestor must really be inside the workspace (symlinks)
  let q = p;
  while (!fs.existsSync(q) && q !== ROOT) q = path.dirname(q);
  let real = q; try { real = fs.realpathSync(q); } catch (_) {}
  if (real !== REAL_ROOT && !real.startsWith(REAL_ROOT + '/') && real !== ROOT && !real.startsWith(ROOT + '/')) {
    throw new Error('path outside the workspace');
  }
  return p;
}
const relOf = (p) => path.relative(ROOT, p);
function mustExist(p, what) { if (!fs.existsSync(p)) throw new Error((what || 'not found') + ': ' + relOf(p)); return p; }

// git info straight from .git (no subprocess per folder): branch + origin URL without credentials
function gitInfo(dir) {
  const g = path.join(dir, '.git');
  let head;
  try { head = fs.readFileSync(path.join(g, 'HEAD'), 'utf8').trim(); } catch (_) { return null; }
  const m = /^ref: refs\/heads\/(.+)$/.exec(head);
  const info = { branch: m ? m[1] : head.slice(0, 8) };
  try {
    const cfg = fs.readFileSync(path.join(g, 'config'), 'utf8');
    const r = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
    if (r) info.remote = r[1].replace(/\/\/[^@/]+@/, '//');      // drop user:token@
  } catch (_) {}
  return info;
}

// one folder's entries: folders first; dotfiles only with hidden=true. At the root, tasks/ and
// repos/ belong to the task manager (web-tasks.js) and folders being cloned are left out.
function ls(rel, hidden) {
  const dir = mustExist(abs(rel));
  if (!fs.statSync(dir).isDirectory()) throw new Error('not a folder: ' + rel);
  const atRoot = dir === ROOT;
  const cloning = new Set([...JOBS.values()].filter((j) => j.state === 'running').map((j) => j.path));
  const entries = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!hidden && d.name.startsWith('.')) continue;
    if (atRoot && (d.name === 'tasks' || d.name === 'repos' || d.name === TRASH)) continue;
    const p = path.join(dir, d.name);
    if (cloning.has(p)) continue;
    let st; try { st = fs.statSync(p); } catch (_) { continue; }        // dangling symlink
    const isDir = st.isDirectory();
    entries.push({ name: d.name, path: p, dir: isDir, size: isDir ? null : st.size, mtime: st.mtimeMs,
      link: d.isSymbolicLink() || undefined, git: isDir ? gitInfo(p) : null });
  }
  return { root: ROOT, rel: relOf(dir), path: dir, entries, jobs: jobList() };
}
// legacy shape (root folders only), kept for older launchers
function list() {
  const o = ls('');
  return { root: ROOT, dirs: o.entries.filter((e) => e.dir), jobs: o.jobs };
}

function mkdir(name, dir) {
  const p = path.join(mustExist(abs(dir || '')), safeName(name));
  abs(relOf(p));
  if (fs.existsSync(p)) throw new Error('already exists: ' + name);
  fs.mkdirSync(p);
  return { path: p, rel: relOf(p) };
}

// rename(from, to): legacy root-folder names, or rename({path, to}) for any entry
function rename(from, to) {
  const a = mustExist(abs(from)), b = path.join(path.dirname(a), safeName(to));
  if (a === ROOT) throw new Error('cannot rename the workspace root');
  if (fs.existsSync(b)) throw new Error('already exists: ' + to);
  fs.renameSync(a, b);
  return { path: b, rel: relOf(b) };
}

// a free name in dir: "name", "name copy", "name copy 2", … (before the extension for files)
function freeName(dir, name, tag) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name), stem = ext && ext !== name ? name.slice(0, -ext.length) : name, e = stem === name ? '' : ext;
  for (let i = 1; i < 1000; i++) {
    const n = stem + ' ' + tag + (i > 1 ? ' ' + i : '') + e;
    if (!fs.existsSync(path.join(dir, n))) return n;
  }
  throw new Error('no free name for ' + name);
}
function checkInto(src, destDir) {
  if (destDir === src || destDir.startsWith(src + '/')) throw new Error('cannot put a folder inside itself: ' + relOf(src));
}
// copy / move several entries into a folder. Copy never overwrites (a "copy" suffix instead);
// move refuses when the name is taken (nothing is moved then).
function copy(items, dest) {
  const d = mustExist(abs(dest)), done = [];
  if (!fs.statSync(d).isDirectory()) throw new Error('not a folder: ' + dest);
  const srcs = (items || []).map((r) => mustExist(abs(r)));
  srcs.forEach((s) => checkInto(s, d));
  for (const s of srcs) {
    const n = freeName(d, path.basename(s), 'copy');
    fs.cpSync(s, path.join(d, n), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    done.push(relOf(path.join(d, n)));
  }
  return { done };
}
function move(items, dest) {
  const d = mustExist(abs(dest));
  if (!fs.statSync(d).isDirectory()) throw new Error('not a folder: ' + dest);
  const srcs = (items || []).map((r) => mustExist(abs(r)));
  srcs.forEach((s) => { if (s === ROOT) throw new Error('cannot move the workspace root'); checkInto(s, d); });
  const taken = srcs.filter((s) => path.dirname(s) !== d && fs.existsSync(path.join(d, path.basename(s))));
  if (taken.length) throw new Error('already exists in ' + (relOf(d) || 'the workspace root') + ': ' + taken.map((s) => path.basename(s)).join(', '));
  const done = [];
  for (const s of srcs) {
    const t = path.join(d, path.basename(s));
    if (t === s) continue;
    try { fs.renameSync(s, t); }
    catch (e) {
      if (e.code !== 'EXDEV') throw e;           // another filesystem: copy + remove
      fs.cpSync(s, t, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      fs.rmSync(s, { recursive: true, force: true });
    }
    done.push(relOf(t));
  }
  return { done };
}
// "delete" = move into /workspace/.trash/<timestamp>/ (restorable by hand)
function trash(items) {
  const srcs = (items || []).map((r) => mustExist(abs(r)));
  srcs.forEach((s) => { if (s === ROOT || s === path.join(ROOT, TRASH)) throw new Error('cannot delete that'); });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..*$/, '');
  const bin = path.join(ROOT, TRASH, stamp); fs.mkdirSync(bin, { recursive: true });
  return move(srcs.map(relOf), relOf(bin));
}

// upload one file (streamed request body) to <dir>/<name>; name may contain subfolders
// ("photos/2026/a.jpg" from a dropped folder), which are created. 409 if it exists and !overwrite.
function upload(req, dir, name, overwrite) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      const parts = String(name || '').split('/').filter(Boolean).map(safeName);
      if (!parts.length) throw new Error('name is required');
      target = abs(path.join(relOf(mustExist(abs(dir || ''))), ...parts));
    } catch (e) { req.resume(); reject(e); return; }
    const len = parseInt(req.headers['content-length'] || '0', 10);
    if (len > UPLOAD_MAX) { req.resume(); reject(new Error('file too large (limit ' + Math.round(UPLOAD_MAX / 1048576) + ' MB)')); return; }
    if (fs.existsSync(target) && !overwrite) { req.resume(); const e = new Error('exists'); e.code = 409; reject(e); return; }
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) { req.resume(); reject(new Error('a folder with that name exists')); return; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = path.join(path.dirname(target), '.upload-' + process.pid + '-' + Date.now() + '-' + path.basename(target));
    const out = fs.createWriteStream(tmp); let n = 0, failed = false;
    const fail = (e) => { if (failed) return; failed = true; out.destroy(); fs.rm(tmp, { force: true }, () => {}); reject(e); };
    req.on('data', (c) => { n += c.length; if (n > UPLOAD_MAX) { req.destroy(); fail(new Error('file too large')); } });
    req.on('aborted', () => fail(new Error('upload aborted')));
    req.on('error', fail); out.on('error', fail);
    out.on('finish', () => {
      if (failed) return;
      try { fs.renameSync(tmp, target); resolve({ path: target, rel: relOf(target), size: n }); } catch (e) { fail(e); }
    });
    req.pipe(out);
  });
}

// GET a file: inline for text / images / pdf (opens in a browser tab), otherwise as a download
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg' };
function looksText(p) {
  try {
    const fd = fs.openSync(p, 'r'), b = Buffer.alloc(4096), n = fs.readSync(fd, b, 0, 4096, 0); fs.closeSync(fd);
    return !b.subarray(0, n).includes(0);
  } catch (_) { return false; }
}
function serveFile(res, rel, download) {
  const p = mustExist(abs(rel)), st = fs.statSync(p);
  if (st.isDirectory()) throw new Error('is a folder');
  const ext = path.extname(p).toLowerCase(), name = path.basename(p);
  let type = TYPES[ext] || (looksText(p) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
  if (ext === '.svg') type = 'text/plain; charset=utf-8';          // never run a workspace SVG's scripts on our origin
  const inline = !download && type !== 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
    'content-disposition': (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(name) });
  fs.createReadStream(p).on('error', () => res.destroy()).pipe(res);
}

// GET an image by absolute path, for pictures Claude shows in chat (screenshots in /tmp, files
// in the session folder, …). Raster images only: an SVG could run script on this origin.
const IMG_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const IMG_MAX = 30 * 1048576;
function serveImage(res, p) {
  p = String(p || '');
  if (!path.isAbsolute(p) || p.includes('\0')) throw new Error('need an absolute path');
  const real = fs.realpathSync(path.resolve(p)), type = IMG_TYPES[path.extname(real).toLowerCase()];
  if (!type || !IMG_TYPES[path.extname(p).toLowerCase()]) throw new Error('not an image');
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > IMG_MAX) throw new Error('image too large');
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=60', 'content-security-policy': "default-src 'none'",
    'content-disposition': "inline; filename*=UTF-8''" + encodeURIComponent(path.basename(real)) });
  fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
}

// ---------- the text editor: read a text file, save it back (whole file, atomic) ----------
const EDIT_MAX = 2 * 1048576;
function readText(rel) {
  const p = mustExist(abs(rel)), st = fs.statSync(p);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > EDIT_MAX) throw new Error('too large to edit (limit 2 MB)');
  if (!looksText(p)) throw new Error('not a text file');
  return { rel: relOf(p), text: fs.readFileSync(p, 'utf8'), mtime: st.mtimeMs, size: st.size };
}
// raw body = the new text. mtime = what the editor loaded; a file changed on disk since then
// is not overwritten (409) unless force. Writes a temp file next to the real one and renames it.
function saveText(req, rel, mtime, force) {
  return new Promise((resolve, reject) => {
    let target, st;
    try {
      const p = mustExist(abs(rel)); st = fs.statSync(p);
      if (!st.isFile()) throw new Error('not a file');
      target = fs.realpathSync(p); abs(relOf(target));               // a symlink must point inside the workspace
      if (!force && mtime && Math.abs(st.mtimeMs - Number(mtime)) > 1) { const e = new Error('changed on disk since you opened it'); e.code = 409; throw e; }
    } catch (e) { req.resume(); reject(e); return; }
    const chunks = []; let n = 0, failed = false;
    const fail = (e) => { if (!failed) { failed = true; reject(e); } };
    req.on('data', (c) => { n += c.length; if (n > EDIT_MAX) { req.destroy(); fail(new Error('too large (limit 2 MB)')); } else chunks.push(c); });
    req.on('aborted', () => fail(new Error('save aborted'))); req.on('error', fail);
    req.on('end', () => {
      if (failed) return;
      const tmp = path.join(path.dirname(target), '.save-' + process.pid + '-' + Date.now() + '-' + path.basename(target));
      try {
        fs.writeFileSync(tmp, Buffer.concat(chunks), { mode: st.mode & 0o7777 });
        fs.renameSync(tmp, target);
        resolve({ rel: relOf(target), mtime: fs.statSync(target).mtimeMs, size: n });
      } catch (e) { fs.rm(tmp, { force: true }, () => {}); fail(e); }
    });
  });
}

// ---------- git clone as a background job (big repos outlive an HTTP request) ----------
const JOBS = new Map(); let jobSeq = 0;
function jobList() {
  return [...JOBS.values()].slice(-10).map((j) => ({ id: j.id, url: j.url, name: j.name, path: j.path, state: j.state, error: j.error, started: j.started }));
}
function repoName(url) {
  const m = /([^/:]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return m ? m[1] : '';
}
function clone(url, name, dir) {
  url = String(url || '').trim();
  // https://host/..., ssh://..., git@host:org/repo — no options smuggled as the URL
  if (!/^(https?:\/\/|ssh:\/\/|git@[\w.-]+:)[^\s]+$/.test(url)) throw new Error('unsupported git URL');
  const dirName = safeName(name || repoName(url));
  const target = path.join(mustExist(abs(dir || '')), dirName);
  if (fs.existsSync(target)) throw new Error('already exists: ' + dirName);
  const id = 'j' + (++jobSeq);
  const job = { id, url: url.replace(/\/\/[^@/]+@/, '//'), name: dirName, path: target, state: 'running', error: '', started: Date.now() };
  JOBS.set(id, job);
  execFile('git', ['clone', '--', url, target],
    { cwd: ROOT, timeout: 30 * 60000, maxBuffer: 8 << 20, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) },
    (e, _out, err) => {
      if (e) { job.state = 'error'; job.error = (String(err || e.message).trim().split('\n').pop() || 'clone failed').slice(0, 300); }
      else job.state = 'done';
    });
  return { id, name: dirName, path: target };
}

module.exports = { ROOT, list, ls, mkdir, rename, copy, move, trash, upload, serveFile, serveImage, clone, readText, saveText };
