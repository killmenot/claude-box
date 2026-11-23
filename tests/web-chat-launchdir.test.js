'use strict';
// launchDir (scripts/web-chat.js): a chat session's history and resume need the directory whose
// project folder actually holds the transcript, while the registry stores Claude's CURRENT cwd,
// which drifts deeper as the session cd-s around (the backend_core case: recorded
// /workspace/releases/backend_core, transcript in /workspace/releases).
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ld-'));
process.env.HOME = tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { launchDir } = require('../scripts/web-chat.js');
const cid = 'c-1234';
const enc = (d) => String(d).replace(/[^a-zA-Z0-9]/g, '-');      // same encoding as launchDir
const proj = path.join(tmp, '.claude', 'projects', enc(path.join(tmp, 'w', 'releases')));
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, cid + '.jsonl'), '');

test('cwd drifted deeper -> walk up to the launch dir', () => {
  assert.strictEqual(launchDir(cid, path.join(tmp, 'w', 'releases', 'backend_core')), path.join(tmp, 'w', 'releases'));
});
test('recorded cwd is the launch dir -> kept as is', () => {
  assert.strictEqual(launchDir(cid, path.join(tmp, 'w', 'releases')), path.join(tmp, 'w', 'releases'));
});
test('no transcript anywhere -> cwd unchanged (new sessions unaffected)', () => {
  assert.strictEqual(launchDir('other', path.join(tmp, 'w', 'releases', 'backend_core')), path.join(tmp, 'w', 'releases', 'backend_core'));
  assert.strictEqual(launchDir(cid, ''), '');
});
