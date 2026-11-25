'use strict';
// Session registry (scripts/web-registry.js) + tmux preview (scripts/web-preview.js).
// Ownership / list / delete through the CLI are covered by tests/web-menu.test.sh.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-reg-'));
process.env.HOME = tmp;
process.env.TMUX_TMPDIR = tmp;                       // a private tmux server: never the developer's own
delete process.env.TMUX;
// `claude` for restore(): a stand-in that just stays alive
const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexec sleep 300\n', { mode: 0o755 });
process.env.PATH = bin + ':' + process.env.PATH;
// tmux runs inside the claude-box image; a host without it (macOS) skips the tmux tests
const NO_TMUX = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return false; } catch (_) { return 'tmux not installed'; } })();
const tmux = (...a) => { try { return execFileSync('tmux', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { return null; } };
test.after(() => { tmux('kill-server'); fs.rmSync(tmp, { recursive: true, force: true }); });

const reg = require('../scripts/web-registry.js');
const { preview } = require('../scripts/web-preview.js');

test('upsert: one record per Claude session, title and mode survive an update without them', () => {
  const t1 = reg.upsert({ cid: 'cid-1', cwd: '/w/a', name: 'web-1', state: 'working', tmux: 'web-1', title: 'Fix the bug', mode: 'chat' });
  assert.match(t1, /^[0-9a-f]{8}$/);
  const t2 = reg.upsert({ cid: 'cid-1', cwd: '/w/a', name: 'web-1', state: 'done', tmux: 'web-1' });
  assert.strictEqual(t2, t1);
  const r = reg.get(t1);
  assert.strictEqual(r.state, 'done');
  assert.strictEqual(r.title, 'Fix the bug');
  assert.strictEqual(r.mode, 'chat');
  assert.notStrictEqual(reg.upsert({ cid: 'cid-2', cwd: '/w/b' }), t1);
  assert.strictEqual(reg.get('nope'), null);
});

test('concurrent CLI upserts do not lose records', () => {
  const cli = path.join(__dirname, '..', 'scripts', 'web-registry.js');
  const { spawn } = require('child_process');
  return Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((res) => {
    spawn(process.execPath, [cli, 'upsert', '--claude-id', 'par-' + i, '--cwd', '/w'], { stdio: 'ignore' }).on('exit', res);
  }))).then(() => {
    const ids = reg.list().map((r) => r.claudeSessionId).filter((c) => c.startsWith('par-'));
    assert.strictEqual(ids.length, 8);
  });
});

test('snapshot keeps the newest record per live tmux session; restore brings it back stamped', { skip: NO_TMUX }, () => {
  const cwd = fs.mkdtempSync(path.join(tmp, 'proj-'));
  fs.writeFileSync(reg.REG, JSON.stringify({
    old: { token: 'old', claudeSessionId: 'c-old', cwd, name: 'web-7', tmuxSession: 'web-7', lastActivity: 1 },
    new: { token: 'new', claudeSessionId: 'c-new', cwd, name: 'web-7', tmuxSession: 'web-7', lastActivity: 2 },
    gone: { token: 'gone', claudeSessionId: 'c-gone', cwd, name: 'web-8', tmuxSession: 'web-8', lastActivity: 3 },
  }));
  tmux('new-session', '-d', '-s', 'web-7', 'sleep 300');
  reg.snapshot();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'web-live-sessions.json'), 'utf8')), ['new']);

  tmux('kill-server');                                   // "container restart"
  const proj = path.join(tmp, '.claude', 'projects', 'p'); fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'c-new.jsonl'), '');  // only a saved conversation can be resumed
  reg.restore(() => {});
  assert.strictEqual((tmux('show-option', '-t', 'web-7', '-qv', '@cbtoken') || '').trim(), 'new');
  assert.strictEqual(reg.owns('new'), 'web-7');
  assert.strictEqual(reg.owns('old'), null);
});

test('restore skips a record with no saved conversation', () => {
  const cwd = fs.mkdtempSync(path.join(tmp, 'proj-'));
  fs.writeFileSync(reg.REG, JSON.stringify({ sdk: { token: 'sdk', claudeSessionId: 'c-sdk', cwd, tmuxSession: 'shell', lastActivity: 1 } }));
  fs.writeFileSync(path.join(tmp, '.claude', 'web-live-sessions.json'), JSON.stringify(['sdk']));
  const said = []; reg.restore((m) => said.push(m));
  assert.ok(said.some((m) => /no transcript/.test(m)), said.join('\n'));
  assert.strictEqual(reg.owns('sdk'), null);
});

test('preview: live capture is cached and served after the session dies', { skip: NO_TMUX }, async () => {
  fs.writeFileSync(reg.REG, JSON.stringify({ pv: { token: 'pv', claudeSessionId: 'c-pv', cwd: tmp, tmuxSession: 'pv-1', lastActivity: 1 } }));
  tmux('new-session', '-d', '-s', 'pv-1', '-x', '80', '-y', '20', 'printf "line-%s\\n" $(seq 1 15); sleep 300');
  await new Promise((r) => setTimeout(r, 300));
  const live = await preview('pv', true);
  assert.strictEqual(live.live, true);
  assert.match(live.ansi, /line-1\b/);
  const thumb = await preview('pv', false);
  assert.ok(thumb.ansi.split('\n').length <= 12);
  tmux('kill-session', '-t', 'pv-1');
  const dead = await preview('pv', true);
  assert.strictEqual(dead.live, false);
  assert.match(dead.ansi, /line-15/);
  assert.deepStrictEqual(await preview('', false), { ansi: '', live: false, ts: 0 });
});
