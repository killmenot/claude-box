'use strict';
// web-archive.js: archive / restore / delete a session with its folder. Only a session's own folder
// under tasks/ or tmp/ goes, never a project folder or one another session uses; nothing is removed
// without the user's confirmation when work would be lost; the conversation is gzipped and comes back.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-arch-')));
const WS = path.join(tmp, 'workspace'), HOME = path.join(tmp, 'home');
process.env.WORKSPACE_DIR = WS; process.env.HOME = HOME;
process.env.GIT_CONFIG_NOSYSTEM = '1';
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const a = require('../scripts/web-archive.js');

const reg = {}, trash = {}, tasksCalls = [];
const T = path.join(HOME, '.claude', 'projects', 'p');
fs.mkdirSync(T, { recursive: true });
const transcript = (cid) => path.join(T, cid + '.jsonl');
a.init({
  registry: { list: () => Object.values(reg).map((r) => Object.assign({}, r)), get: (t) => reg[t] || null,
    patch: (t, f) => { for (const [k, v] of Object.entries(f)) { if (v === null) delete reg[t][k]; else reg[t][k] = v; } return reg[t]; },
    remove: (t) => { trash[t] = Object.assign({}, reg[t], { deletedAt: 1 }); delete reg[t]; },
    trash: () => Object.values(trash).map((r) => Object.assign({}, r)), purge: (t) => { const had = !!trash[t]; delete trash[t]; return had; } },
  tasks: { archive: async (slug) => { tasksCalls.push('archive ' + slug); return { archived: true }; },
    reopen: async (slug) => { tasksCalls.push('reopen ' + slug); }, forget: (slug) => { tasksCalls.push('forget ' + slug); } },
  transcriptPath: (cid) => (fs.existsSync(transcript(cid)) ? transcript(cid) : null),
  stop: async () => {},
});
function session(token, cwd, cid) { reg[token] = { token, cwd, claudeSessionId: cid }; fs.writeFileSync(transcript(cid), '{"m":"hello ' + cid + '"}\n'.repeat(50)); }
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }) });

test('a session owns only a folder under tasks/ or tmp/', () => {
  assert.deepStrictEqual(a.folderOf(path.join(WS, 'tasks', 'proj-1', 'api')), { kind: 'task', name: 'proj-1', dir: path.join(WS, 'tasks', 'proj-1') });
  assert.strictEqual(a.folderOf(path.join(WS, 'tmp', 'x')).kind, 'tmp');
  assert.strictEqual(a.folderOf(path.join(WS, 'claude-box')), null, 'a project folder is never the session\'s');
  assert.strictEqual(a.folderOf(path.join(WS, 'repos', 'api')), null);
  assert.strictEqual(a.folderOf('/etc'), null);
});

test('unsaved work is reported and nothing is removed without force; a shared folder stays', async () => {
  const d = path.join(WS, 'tmp', 'scratch');
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q'); fs.writeFileSync(path.join(d, 'a.txt'), 'x'); git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'c1');
  fs.writeFileSync(path.join(d, 'a.txt'), 'changed');
  session('s1', d, 'cid-1');
  const r = await a.archive('s1', false);
  assert.strictEqual(r.confirm, true);
  assert.ok(r.issues.some((i) => /uncommitted/.test(i)) && r.issues.some((i) => /on no remote/.test(i)) && r.issues.some((i) => /deleted, not kept/.test(i)), r.issues.join('; '));
  assert.ok(fs.existsSync(d) && fs.existsSync(transcript('cid-1')), 'nothing removed');
  session('s2', path.join(d, 'sub'), 'cid-2');
  const shared = await a.inspect('s1');
  assert.strictEqual(shared.folder, null);
  assert.strictEqual(shared.sharedWith.length, 1);
  delete reg.s2;
});

test('archive: the folder goes, the conversation is gzipped; restore brings it back', async () => {
  const r = await a.archive('s1', true);
  assert.strictEqual(r.ok, true);
  const d = path.join(WS, 'tmp', 'scratch');
  assert.ok(!fs.existsSync(d), 'folder removed');
  assert.ok(!fs.existsSync(transcript('cid-1')), 'transcript moved');
  const gz = reg.s1.archived.gz;
  assert.match(zlib.gunzipSync(fs.readFileSync(gz)).toString(), /hello cid-1/);
  assert.ok(reg.s1.archived.at > 0);
  await a.restore('s1');
  assert.match(fs.readFileSync(transcript('cid-1'), 'utf8'), /hello cid-1/);
  assert.ok(!fs.existsSync(gz) && !reg.s1.archived && fs.existsSync(d), 'conversation back, folder recreated');
});

test('a task folder goes through the task archive (branches kept); delete removes it all', async () => {
  const d = path.join(WS, 'tasks', 'proj-7');
  fs.mkdirSync(path.join(d, 'api'), { recursive: true });
  session('t1', path.join(d, 'api'), 'cid-7');
  fs.mkdirSync(path.join(HOME, '.claude', 'file-history', 'cid-7'), { recursive: true });
  const r = await a.archive('t1', false);
  assert.strictEqual(r.ok, true, 'a clean task folder needs no confirmation');
  assert.deepStrictEqual(tasksCalls, ['archive proj-7']);
  assert.strictEqual(reg.t1.archived.kind, 'task');
  await a.restore('t1');
  assert.deepStrictEqual(tasksCalls, ['archive proj-7', 'reopen proj-7']);
  await a.remove('t1', true);
  assert.ok(!reg.t1, 'record gone');
  assert.ok(!trash.t1, 'not left in the trash either');
  assert.ok(!fs.existsSync(transcript('cid-7')), 'conversation gone');
  assert.ok(!fs.existsSync(path.join(HOME, '.claude', 'file-history', 'cid-7')), 'checkpoints gone');
  assert.ok(tasksCalls.includes('forget proj-7'));
});

test('a session in a project folder: delete keeps the folder', async () => {
  const d = path.join(WS, 'claude-box');
  fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'keep.txt'), 'x');
  session('p1', d, 'cid-p');
  const info = await a.inspect('p1');
  assert.strictEqual(info.folder, null);
  await a.remove('p1', true);
  assert.ok(fs.existsSync(path.join(d, 'keep.txt')), 'project folder untouched');
  assert.ok(!fs.existsSync(transcript('cid-p')));
});

test('Delete forever from the trash: the folder and the conversation go, the trash entry too', async () => {
  const d = path.join(WS, 'tmp', 'scratch-9');
  fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'notes.txt'), 'x');
  session('x1', d, 'cid-9');
  trash.x1 = Object.assign({}, reg.x1, { deletedAt: 1 }); delete reg.x1;      // Delete: moved to the trash
  assert.ok(fs.existsSync(d) && fs.existsSync(transcript('cid-9')), 'the trash changes nothing on disk');
  const info = await a.inspect('x1');
  assert.strictEqual(info.folder.dir, d);
  assert.ok(info.issues.some((i) => /deleted, not kept/.test(i)));
  const r = await a.remove('x1', false);
  assert.strictEqual(r.confirm, true, 'losses are confirmed first');
  await a.remove('x1', true);
  assert.ok(!fs.existsSync(d), 'folder gone');
  assert.ok(!fs.existsSync(transcript('cid-9')), 'conversation gone');
  assert.ok(!trash.x1, 'trash entry gone');
});
