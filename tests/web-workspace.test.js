'use strict';
// The Workspace page's git clone (scripts/web-workspace.js): the URL guard and the ssh options
// that make a UI-driven clone work without a tty (host-key prompts were the "and the repository
// exists" failure). Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ws-'));
process.env.WORKSPACE_DIR = tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// capture execFile instead of running git: the module grabs it from child_process at load time
const cp = require('child_process');
let captured = null;
cp.execFile = (cmd, args, opts, cb) => {
  // du (folder sizes): 200 KB for a folder named "a", 4 KB for any other
  if (cmd === 'du') { const p = args[args.length - 1]; cb(null, (p.endsWith('/a') ? 200 : 4) + '\t' + p + '\n', ''); return; }
  captured = { cmd, args, opts }; cb(null, '', '');
};

const ws = require('../scripts/web-workspace.js');

test('clone: passes trust-on-first-use ssh options, no options can hide in the URL', () => {
  const job = ws.clone('git@github.com:org/repo.git', 'repo');
  assert.strictEqual(job.state, undefined);                    // job object returned, exec captured
  assert.strictEqual(captured.cmd, 'git');
  const i = captured.args.indexOf('-c');
  assert.ok(i >= 0, 'ssh -c options missing');
  assert.match(captured.args[i + 1], /StrictHostKeyChecking=accept-new/);
  assert.match(captured.args[i + 1], /BatchMode=yes/);
  assert.deepStrictEqual(captured.args.slice(-3), ['--', 'git@github.com:org/repo.git', path.join(tmp, 'repo')]);
  assert.ok(captured.opts.env.GIT_TERMINAL_PROMPT === '0');
});

test('clone: rejects URLs that are not git URLs (option smuggling)', () => {
  assert.throws(() => ws.clone('../etc'), /unsupported git URL/);
  assert.throws(() => ws.clone('https://host/repo.git --upload-pack=evil'), /unsupported git URL/);
});

test('clone: refuses to overwrite an existing folder', () => {
  fs.mkdirSync(path.join(tmp, 'repo'));
  assert.throws(() => ws.clone('git@github.com:org/repo.git', 'repo'), /already exists/);
});

test('sizes: each folder gets its du total, tasks/ is listed at the root, repos/ is not', async () => {
  fs.mkdirSync(path.join(tmp, 'sz', 'a'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'sz', 'b'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'sz', 'a', 'f.bin'), Buffer.alloc(200 * 1024));
  const s = await ws.sizes('sz');
  assert.ok(s.a >= 200 * 1024, 'a holds the 200 KB file: ' + s.a);
  assert.ok(s.b >= 0 && s.b < s.a);
  fs.mkdirSync(path.join(tmp, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'repos'), { recursive: true });
  const names = ws.ls('').entries.map((e) => e.name);
  assert.ok(names.includes('tasks'));
  assert.ok(!names.includes('repos'));
  await assert.rejects(() => ws.sizes('../etc'), /invalid path|outside/);
});
