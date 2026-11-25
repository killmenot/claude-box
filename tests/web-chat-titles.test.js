'use strict';
// The transcript page plumbing (scripts/web-chat.js):
// - sessionTitles: cold scan bounded (head + tail), scan offsets persisted to web-titles.json;
// - tailPage: the browser page is cut from the TAIL of the transcript — opening a session must
//   not parse a 30 MB file (that froze the server), and "earlier" pages walk toward the start.
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
const chat = { cid, cwd: '/w/x', turn: [] };

// 30 prompt/response turns + a slash-command output block, then titles at the very end
const filler = JSON.stringify({ type: 'filler', data: 'x'.repeat(300) }) + '\n';
let body = '';
for (let i = 1; i <= 30; i++) {
  body += `{"uuid":"p${i}","timestamp":"2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z","type":"user","message":{"role":"user","content":"prompt ${i}"}}\n`;
  body += `{"uuid":"a${i}","timestamp":"2026-01-01T00:${String(i % 60).padStart(2, '0')}:30Z","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"answer ${i}"}],"usage":{"input_tokens":100}}}\n`;
  if (i === 29) body += `{"uuid":"s${i}","timestamp":"2026-01-01T00:29:10Z","type":"system","subtype":"local_command","parentUuid":"a${i}","content":"<local-command-stdout>cost output</local-command-stdout>"}\n`;
}
body += `{"type":"custom-title","customTitle":"Backend work"}\n{"type":"ai-title","aiTitle":"Security audit"}\n`;
fs.writeFileSync(file, body + filler.repeat(300));   // the filler AFTER the titles: appended garbage is not the point here

test('tailPage: the last page holds the last 5 prompts and nothing earlier', () => {
  const pg = wc.tailPage(chat, null);
  const prompts = pg.items.filter((i) => wc.isPrompt ? false : true) && pg.items.filter((i) => i.type === 'user');
  assert.deepStrictEqual(prompts.map((i) => i.message.content), ['prompt 26', 'prompt 27', 'prompt 28', 'prompt 29', 'prompt 30']);
  assert.ok(pg.more > 0, 'more should be positive while the file head is unread');
  const last = pg.items[pg.items.length - 1];
  assert.strictEqual(last.message.content[0].text, 'answer 30');
});

test('tailPage: the slash-command output rides next to its message', () => {
  const pg = wc.tailPage(chat, null);
  const kinds = pg.items.filter((i) => i.type === 'system').map((i) => i.content);
  assert.ok(kinds.includes('cost output'), 'local_command_output missing from the page');
});

test('tailPage: "earlier" continues toward the file start, ends at 0', () => {
  const p1 = wc.tailPage(chat, null);
  const before = p1.items.find((i) => i.type === 'user');            // the oldest prompt on page 1
  const p2 = wc.tailPage(chat, before.uuid);
  const prompts2 = p2.items.filter((i) => i.type === 'user').map((i) => i.message.content);
  assert.deepStrictEqual(prompts2, ['prompt 21', 'prompt 22', 'prompt 23', 'prompt 24', 'prompt 25']);
  assert.ok(p2.more > 0);
  // walk all the way to the start: paging must terminate with more === 0
  let pg = p2, pages = 0;
  while (pg.more > 0 && pages < 12) {
    const b = pg.items.find((i) => i.type === 'user');
    pg = wc.tailPage(chat, b.uuid); pages++;
  }
  assert.strictEqual(pg.more, 0, 'paging did not terminate at the file start');
  const first = pg.items.filter((i) => i.type === 'user').map((i) => i.message.content);
  assert.ok(first.includes('prompt 1'), 'the first prompt never reached the page');
});

test('tailPage: unknown boundary uuid -> lost', () => {
  const pg = wc.tailPage(chat, 'no-such-uuid');
  assert.strictEqual(pg.lost, true);
  assert.deepStrictEqual(pg.items, []);
});

test('sessionTitles: bounded cold scan finds tail titles, offsets persisted', async () => {
  const t1 = wc.sessionTitles(cid, '/w/x');
  assert.strictEqual(t1.custom, 'Backend work');
  assert.strictEqual(t1.ai, 'Security audit');
  await new Promise((r) => setTimeout(r, 1300));                     // the save is debounced ~1s
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'web-titles.json'), 'utf8'))[cid].size, fs.statSync(file).size);
  fs.appendFileSync(file, `{"type":"custom-title","customTitle":"Renamed"}\n`);
  assert.strictEqual(wc.sessionTitles(cid, '/w/x').custom, 'Renamed');
});

test('sessionTitles: missing transcript -> null', () => {
  assert.strictEqual(wc.sessionTitles('no-such-cid', '/w/x'), null);
});
