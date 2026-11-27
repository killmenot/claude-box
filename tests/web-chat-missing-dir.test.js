'use strict';
// A resumed chat whose folder was deleted (scripts/web-chat.js assertDir): the claude spawn would
// fail with ENOENT, which the Agent SDK words as a libc mismatch ("native binary … exists but
// failed to launch"). start() must refuse first and name the missing folder instead.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-md-'));
process.env.HOME = tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Chat } = require('../scripts/web-chat.js');

test('deleted session folder -> a clear error, no spawn', async () => {
  const gone = path.join(tmp, 'workspace', 'tmp', '2026-11-26-1232-b2w');
  const chat = new Chat({ cid: 'c-1', cwd: gone, name: 'chat-gone' });
  await assert.rejects(chat.start(), (e) => {
    assert.match(e.message, /folder .*2026-11-26-1232-b2w no longer exists/);
    assert.match(e.message, /mkdir -p /);
    assert.doesNotMatch(e.message, /libc|native binary/);
    return true;
  });
  assert.strictEqual(chat.q || null, null);
});

test('a file in place of the folder is refused too', async () => {
  const file = path.join(tmp, 'not-a-dir');
  fs.writeFileSync(file, '');
  await assert.rejects(new Chat({ cid: 'c-2', cwd: file, name: 'chat-file' }).start(), /no longer exists/);
});
