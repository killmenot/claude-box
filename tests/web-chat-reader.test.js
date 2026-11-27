'use strict';
// The backward transcript reader behind the chat's pages (scripts/web-chat.js tailPage):
// - opening a session reads only what the last page needs, not the whole bounded window;
// - an "earlier" page found by seeking the raw file lines up with byte offsets, also when
//   the text before it is not ASCII.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-reader-'));
process.env.HOME = tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const wc = require('../scripts/web-chat.js');
const proj = path.join(tmp, '.claude', 'projects', '-w-r');
fs.mkdirSync(proj, { recursive: true });

// n prompt/answer turns; `pad` goes into every answer
function transcript(cid, n, pad) {
  let body = '';
  for (let i = 1; i <= n; i++) {
    body += JSON.stringify({ uuid: 'p' + i, sessionId: cid, timestamp: '2026-01-01T00:00:00Z', type: 'user',
      message: { role: 'user', content: 'prompt ' + i } }) + '\n';
    body += JSON.stringify({ uuid: 'a' + i, sessionId: cid, timestamp: '2026-01-01T00:00:30Z', type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer ' + i + ' ' + pad }] } }) + '\n';
  }
  fs.writeFileSync(path.join(proj, cid + '.jsonl'), body);
  return { cid, cwd: '/w/r', turn: [] };
}
const prompts = (pg) => pg.items.filter((i) => i.type === 'user').map((i) => i.message.content);

test('tailPage: the first page reads the last turns only, not the whole capped window', () => {
  const chat = transcript('c-big', 400, 'x'.repeat(8000));          // ~3.2 MB, under the 4 MB cap
  const size = fs.statSync(path.join(proj, 'c-big.jsonl')).size;
  let bytes = 0;
  const orig = fs.readSync;
  fs.readSync = function (fd, buf, off, len) { bytes += len; return orig.apply(fs, arguments); };
  let pg;
  try { pg = wc.tailPage(chat, null); } finally { fs.readSync = orig; }
  assert.deepStrictEqual(prompts(pg), ['prompt 396', 'prompt 397', 'prompt 398', 'prompt 399', 'prompt 400']);
  assert.ok(pg.more > 0);
  assert.ok(bytes < size / 4, `read ${bytes} of ${size} bytes for one page`);
});

test('tailPage: a page found by seeking the file is exact with non-ASCII text before it', () => {
  // Cyrillic answers: two bytes per letter, so a string index and a byte offset differ a lot;
  // ~5.6 MB, the boundary deeper than the reader's 4 MB cap, so the page comes from the seek
  const chat = transcript('c-ru', 400, 'ответ на русском языке '.repeat(350));
  const pg = wc.tailPage(chat, 'p50');
  assert.deepStrictEqual(prompts(pg), ['prompt 45', 'prompt 46', 'prompt 47', 'prompt 48', 'prompt 49']);
  const last = pg.items[pg.items.length - 1];
  assert.strictEqual(last.uuid, 'a49', 'the page ends right before the boundary message');
});
