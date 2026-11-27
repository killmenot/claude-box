'use strict';
// The Inbox's transcript tail (scripts/web-inbox.js): an unchanged file comes from the cache,
// with the same content as the first read.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-inbox-'));
process.env.HOME = tmp;
process.env.WEB_INBOX = '0';
const inbox = require('../scripts/web-inbox.js');

const line = (o) => JSON.stringify(o) + '\n';
test('tail: a cached (unchanged) transcript gives the same text, not just the uuid', () => {
  const f = path.join(tmp, 's.jsonl');
  fs.writeFileSync(f, line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'fix the build' } }) +
    line({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Done, tests pass.' }] } }));
  const first = inbox.tail(f);
  assert.strictEqual(first.uuid, 'a1');
  assert.match(first.text, /USER: fix the build/);
  const reads = [], orig = fs.readSync;
  fs.readSync = function () { reads.push(1); return orig.apply(fs, arguments); };
  try { assert.deepStrictEqual(inbox.tail(f), first); } finally { fs.readSync = orig; }
  assert.strictEqual(reads.length, 0, 'an unchanged file is not read again');
  fs.appendFileSync(f, line({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'and deploy' } }));
  assert.strictEqual(inbox.tail(f).uuid, 'u2');
});

test('tail: a transcript without messages is remembered as empty', () => {
  const f = path.join(tmp, 'empty.jsonl');
  fs.writeFileSync(f, line({ type: 'summary', summary: 'x' }));
  assert.strictEqual(inbox.tail(f), null);
  const reads = [], orig = fs.readSync;
  fs.readSync = function () { reads.push(1); return orig.apply(fs, arguments); };
  try { assert.strictEqual(inbox.tail(f), null); } finally { fs.readSync = orig; }
  assert.strictEqual(reads.length, 0);
});
