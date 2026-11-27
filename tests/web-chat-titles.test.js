'use strict';
// The two transcript scans that used to stall the server (scripts/web-chat.js):
// - sessionTitles: cold scan is bounded (head + tail), offsets persist to web-titles.json;
// - transcriptExtras: incremental, not a whole-file re-read on every history request.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-titles-'));
process.env.HOME = tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const wc = require('../scripts/web-chat.js');

const proj = path.join(tmp, '.claude', 'projects', '-w-x');
fs.mkdirSync(proj, { recursive: true });
const cid = 'c-titles';
const file = path.join(proj, cid + '.jsonl');
// 6 MB of filler so the cold scan is bounded, titles: one in the head, one in the tail
const filler = JSON.stringify({ type: 'filler', data: 'x'.repeat(400) }) + '\n';
fs.writeFileSync(file, filler.repeat(600) +
  `{"uuid":"u1","timestamp":"2026-11-24T10:00:00Z","type":"system","subtype":"local_command","parentUuid":"p1","content":"<local-command-stdout>hi</local-command-stdout>"}\n` +
  filler.repeat(14000) +
  `{"type":"custom-title","customTitle":"Backend work"}\n` +
  `{"type":"ai-title","aiTitle":"Security audit"}\n`);

test('sessionTitles: bounded cold scan finds tail titles, offsets persisted', async () => {
  const t1 = wc.sessionTitles(cid, '/w/x');
  assert.strictEqual(t1.custom, 'Backend work');
  assert.strictEqual(t1.ai, 'Security audit');
  await new Promise((r) => setTimeout(r, 1300));                    // the save is debounced ~1s
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'web-titles.json'), 'utf8'))[cid].size, fs.statSync(file).size);
  // a later append is picked up incrementally
  fs.appendFileSync(file, `{"type":"custom-title","customTitle":"Renamed"}\n`);
  const t2 = wc.sessionTitles(cid, '/w/x');
  assert.strictEqual(t2.custom, 'Renamed');
});

test('sessionTitles: a small transcript is not re-read on every call', () => {
  const sid = 'c-small', f = path.join(proj, sid + '.jsonl');
  // many ai-title lines, as a long session has: one decode per match made this quadratic
  fs.writeFileSync(f, Array.from({ length: 300 }, (_, i) => `{"type":"ai-title","aiTitle":"Title ${i}"}\n` + filler).join(''));
  const reads = [], orig = fs.readSync;
  fs.readSync = function (fd, buf, off, len, pos) { reads.push([pos, len]); return orig.apply(fs, arguments); };
  try {
    assert.strictEqual(wc.sessionTitles(sid, '/w/x').ai, 'Title 299');
    const size = fs.statSync(f).size;
    assert.strictEqual(wc.sessionTitles(sid, '/w/x').ai, 'Title 299');
    assert.strictEqual(reads.length, 1, 'an unchanged file is not read again');
    fs.appendFileSync(f, `{"type":"ai-title","aiTitle":"Later"}\n`);
    assert.strictEqual(wc.sessionTitles(sid, '/w/x').ai, 'Later');
    assert.strictEqual(reads.length, 2);
    assert.ok(reads[1][0] >= size - 1024, 'an append is read from the last offset, not from byte 0');
  } finally { fs.readSync = orig; }
});

test('transcriptExtras: incremental across repeated calls and appends', () => {
  fs.writeFileSync(file, filler.repeat(600) +
    `{"uuid":"u1","timestamp":"2026-11-24T10:00:00Z","type":"system","subtype":"local_command","parentUuid":"p1","content":"<local-command-stdout>hi</local-command-stdout>"}\n`);
  const first = wc.transcriptExtras({ cid, cwd: '/w/x' });
  assert.strictEqual(first.extra.get('p1')[0].content, 'hi');
  assert.ok(first.times.get('u1') > 0);
  const size1 = fs.statSync(file).size;
  const again = wc.transcriptExtras({ cid, cwd: '/w/x' });          // no growth: same result, no re-read
  assert.strictEqual(again.extra.get('p1')[0].content, 'hi');
  fs.appendFileSync(file, filler.repeat(5) +
    `{"uuid":"u2","timestamp":"2026-11-24T11:00:00Z","type":"system","subtype":"local_command","parentUuid":"p2","content":"<local-command-stdout>two</local-command-stdout>"}\n`);
  const grown = wc.transcriptExtras({ cid, cwd: '/w/x' });
  assert.strictEqual(grown.extra.get('p2')[0].content, 'two');
  assert.strictEqual(grown.extra.get('p1')[0].content, 'hi');       // old entries kept
  assert.ok(fs.statSync(file).size > size1);
});

test('sessionTitles: missing transcript -> null', () => {
  assert.strictEqual(wc.sessionTitles('no-such-cid', '/w/x'), null);
});
