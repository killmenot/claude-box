'use strict';
// Task workspaces (scripts/web-tasks.js) against throwaway git repos: a bare "remote", a base
// clone in repos/, then the full lifecycle create -> commit -> archive -> reopen -> forget.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-tasks-'));
process.env.WORKSPACE_DIR = path.join(W, 'ws');
fs.mkdirSync(process.env.WORKSPACE_DIR);
const G = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }) }).trim();

// remote with one commit on main
const remote = path.join(W, 'remote.git');
G(['init', '-q', '--bare', '-b', 'main', remote]);
const seed = path.join(W, 'seed');
G(['clone', '-q', remote, seed]);
fs.writeFileSync(path.join(seed, 'README.md'), 'hello\n');
G(['add', '.'], seed); G(['commit', '-q', '-m', 'init'], seed); G(['push', '-q', 'origin', 'HEAD:main'], seed);
// an existing workspace folder that becomes a base repo via {from}
G(['clone', '-q', remote, path.join(process.env.WORKSPACE_DIR, 'api.develop')]);

const tasks = require('../scripts/web-tasks.js');
const until = async (f) => { for (let i = 0; i < 100; i++) { if (await f()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timeout'); };

test('slugify: key + title, unicode, no leading dots', () => {
  assert.strictEqual(tasks.slugify('PROJ-123', 'Paging for /v1/deposits!'), 'PROJ-123-paging-for-v1-deposits');
  assert.strictEqual(tasks.slugify('', 'Починить алерты Grafana'), 'починить-алерты-grafana');
  assert.strictEqual(tasks.slugify('', '...'), 'task');
});

test('lifecycle: base repo, open, commit, archive, reopen, forget', async () => {
  const l0 = await tasks.list();
  assert.deepStrictEqual(l0.candidates, ['api.develop']);
  const j = tasks.addRepo({ from: 'api.develop' });                 // ".develop" suffix dropped
  assert.strictEqual(j.name, 'api');
  await until(() => j.state !== 'running');
  assert.strictEqual(j.state, 'done', j.error);
  const base = path.join(tasks.REPOS, 'api');
  assert.strictEqual(G(['remote', 'get-url', 'origin'], base), remote);   // real remote, not the folder

  const t = await tasks.open({ key: 'proj-123', title: 'Paging', url: 'https://jira/PROJ-123', repos: ['api'] });
  assert.strictEqual(t.created, true); assert.deepStrictEqual(t.errors, []);
  assert.strictEqual(t.slug, 'PROJ-123-paging'); assert.strictEqual(t.id, 'PROJ-123');
  const clone = path.join(t.path, 'api');
  assert.strictEqual(G(['rev-parse', '--abbrev-ref', 'HEAD'], clone), 'PROJ-123-paging');
  assert.strictEqual(G(['remote', 'get-url', 'origin'], clone), remote);
  assert.strictEqual(t.state, 'clean');                                  // nothing new yet

  const again = await tasks.open({ key: 'PROJ-123', title: 'whatever' });     // same id -> same task
  assert.strictEqual(again.created, false); assert.strictEqual(again.slug, t.slug);

  fs.writeFileSync(path.join(clone, 'a.txt'), 'x');
  let d = (await tasks.list()).tasks[0];
  assert.strictEqual(d.state, 'dirty');
  await assert.rejects(tasks.archive(t.slug), /uncommitted/);
  G(['add', '.'], clone); G(['commit', '-q', '-m', 'work'], clone);
  d = (await tasks.list()).tasks[0];
  assert.strictEqual(d.state, 'unpushed'); assert.strictEqual(d.repos[0].unpushed, 1);

  const a = await tasks.archive(t.slug);
  assert.strictEqual(a.state, 'archived');
  assert.ok(!fs.existsSync(clone)); assert.ok(fs.existsSync(path.join(t.path, '.task.json')));
  assert.strictEqual(G(['log', '-1', '--format=%s', 'PROJ-123-paging'], base), 'work');   // branch kept in base

  const r = await tasks.reopen(t.slug);
  assert.strictEqual(r.archived, false);
  assert.strictEqual(G(['log', '-1', '--format=%s'], clone), 'work');
  assert.strictEqual(G(['rev-parse', '--abbrev-ref', 'HEAD'], clone), 'PROJ-123-paging');

  assert.throws(() => tasks.forget(t.slug), /archive the task first/);
  await tasks.archive(t.slug);
  tasks.forget(t.slug);
  assert.ok(!fs.existsSync(t.path));
});

test('a title equal to the key does not repeat in the folder name', async () => {
  const t = await tasks.open({ key: 'PROJ-456', title: 'PROJ-456' });
  assert.strictEqual(t.slug, 'PROJ-456');
});

test('tasks without a Jira key get a local id; unknown repos are reported, not fatal', async () => {
  const t = await tasks.open({ title: 'Fix grafana alerts', repos: ['nope'] });
  assert.match(t.id, /^local:fix-grafana-alerts$/);
  assert.strictEqual(t.errors.length, 1);
  await assert.rejects(tasks.open({}), /title or a key/);
});

test.after(() => fs.rmSync(W, { recursive: true, force: true }));
