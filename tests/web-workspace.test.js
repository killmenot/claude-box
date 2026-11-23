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
cp.execFile = (cmd, args, opts, cb) => { captured = { cmd, args, opts }; cb(null, '', ''); };

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
