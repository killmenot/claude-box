'use strict';
// Workspace file manager (scripts/web-workspace.js) on a throwaway folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ws-'));
const ROOT = path.join(W, 'ws'); fs.mkdirSync(ROOT);
const OUT = path.join(W, 'outside'); fs.mkdirSync(OUT); fs.writeFileSync(path.join(OUT, 'secret'), 's');
process.env.WORKSPACE_DIR = ROOT;
const ws = require('../scripts/web-workspace.js');
const names = (rel, hidden) => ws.ls(rel, hidden).entries.map((e) => e.name + (e.dir ? '/' : '')).sort();
const body = (text, extra) => Object.assign(Readable.from([Buffer.from(text)]), { headers: { 'content-length': String(text.length) } }, extra);

test('browse, create, rename', () => {
  ws.mkdir('proj');
  ws.mkdir('docs', 'proj');
  fs.writeFileSync(path.join(ROOT, 'proj', 'a.txt'), 'hello');
  fs.writeFileSync(path.join(ROOT, 'proj', '.env'), 'x');
  assert.deepStrictEqual(names('proj'), ['a.txt', 'docs/']);
  assert.deepStrictEqual(names('proj', true), ['.env', 'a.txt', 'docs/']);
  const a = ws.ls('proj').entries.find((e) => e.name === 'a.txt');
  assert.strictEqual(a.size, 5);
  ws.rename('proj/docs', 'notes');
  assert.deepStrictEqual(names('proj'), ['a.txt', 'notes/']);
  assert.throws(() => ws.rename('proj/notes', 'a.txt'), /already exists/);
  assert.throws(() => ws.mkdir('x/y', 'proj'), /invalid name/);
});

test('paths stay inside the workspace', () => {
  assert.throws(() => ws.ls('..'), /invalid path/);
  assert.throws(() => ws.ls('proj/../..'), /invalid path/);
  fs.symlinkSync(OUT, path.join(ROOT, 'escape'));
  assert.throws(() => ws.ls('escape'), /outside the workspace/);
  assert.throws(() => ws.copy(['escape/secret'], 'proj'), /outside the workspace/);
  fs.unlinkSync(path.join(ROOT, 'escape'));
});

test('copy keeps both, move refuses a taken name, trash is restorable', () => {
  ws.copy(['proj/a.txt'], 'proj');
  assert.deepStrictEqual(names('proj'), ['a copy.txt', 'a.txt', 'notes/']);
  ws.copy(['proj/notes'], '');
  assert.ok(fs.existsSync(path.join(ROOT, 'notes')));
  assert.throws(() => ws.copy(['proj'], 'proj/notes'), /inside itself/);
  fs.writeFileSync(path.join(ROOT, 'notes', 'a.txt'), 'other');
  assert.throws(() => ws.move(['proj/a.txt'], 'notes'), /already exists/);
  assert.ok(fs.existsSync(path.join(ROOT, 'proj', 'a.txt')));              // nothing moved
  const m = ws.move(['proj/a copy.txt'], 'notes');
  assert.deepStrictEqual(m.done, ['notes/a copy.txt']);
  const t = ws.trash(['notes']);
  assert.ok(!fs.existsSync(path.join(ROOT, 'notes')));
  assert.match(t.done[0], /^\.trash\/[\d-]+\/notes$/);
  assert.strictEqual(fs.readFileSync(path.join(ROOT, t.done[0], 'a.txt'), 'utf8'), 'other');
  assert.ok(!names('').includes('.trash/'));
});

test('upload: subfolders, no silent overwrite', async () => {
  const r = await ws.upload(body('one'), 'proj', 'pics/2026/x.png');
  assert.strictEqual(r.rel, 'proj/pics/2026/x.png'); assert.strictEqual(r.size, 3);
  await assert.rejects(ws.upload(body('two'), 'proj', 'pics/2026/x.png'), (e) => e.code === 409);
  await ws.upload(body('two'), 'proj', 'pics/2026/x.png', true);
  assert.strictEqual(fs.readFileSync(path.join(ROOT, 'proj/pics/2026/x.png'), 'utf8'), 'two');
  await assert.rejects(ws.upload(body('z'), 'proj', '../evil'), /invalid name/);
  assert.deepStrictEqual(names('proj/pics/2026', true), ['x.png']);          // no temp files left
});

test.after(() => fs.rmSync(W, { recursive: true, force: true }));
