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
  body += `{"uuid":"p${i}","sessionId":"c-titles","timestamp":"2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z","type":"user","message":{"role":"user","content":"prompt ${i}"}}\n`;
  body += `{"uuid":"a${i}","sessionId":"c-titles","timestamp":"2026-01-01T00:${String(i % 60).padStart(2, '0')}:30Z","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"answer ${i}"}],"usage":{"input_tokens":100}}}\n`;
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

test('forkFrom: copies the prefix up to the chosen message, rewrites sessionId, appends "Fork: …"', () => {
  const before = fs.readFileSync(file, 'utf8');
  // a user prompt branches BEFORE it (re-ask differently): prompt 15 itself is not copied
  const r = wc.forkFrom({ cid, cwd: '/w/x' }, 'p15');
  let forked = fs.readFileSync(path.join(proj, r.cid + '.jsonl'), 'utf8');
  let fl = forked.split('\n').filter((l) => l.startsWith('{'));
  assert.ok(fl.some((l) => l.includes('"uuid":"a14"')));
  assert.ok(!fl.some((l) => l.includes('"uuid":"p15"')), 'fork leaked past the chosen prompt');
  assert.ok(!fl.some((l) => l.includes('"uuid":"p16"')));
  // an assistant answer branches AFTER it: answer 15 is copied
  const r2 = wc.forkFrom({ cid, cwd: '/w/x' }, 'a15');
  forked = fs.readFileSync(path.join(proj, r2.cid + '.jsonl'), 'utf8');
  fl = forked.split('\n').filter((l) => l.startsWith('{'));
  assert.ok(fl.some((l) => l.includes('"uuid":"a15"')));
  assert.ok(!fl.some((l) => l.includes('"uuid":"p16"')), 'fork leaked past the chosen message');
  assert.ok(!forked.includes('"sessionId":"c-titles"'), 'sessionId not rewritten');
  assert.ok(forked.includes('"sessionId":"' + r2.cid + '"'));
  assert.match(fl[fl.length - 1], /"customTitle":"Fork: Renamed"/);
  // the original is untouched
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('forkFrom: unknown uuid -> error', () => {
  assert.throws(() => wc.forkFrom({ cid, cwd: '/w/x' }, 'nope'), /not found/);
});

test('runInShell: fresh bash, output captured, bounded', async () => {
  const r1 = await wc.runInShell({ cwd: '/tmp' }, 'echo hello-run');
  assert.strictEqual(r1.code, 0);
  assert.match(r1.out, /hello-run/);
  assert.ok(r1.ms >= 0);
  const r2 = await wc.runInShell({ cwd: '/tmp' }, 'echo out; echo err >&2; exit 3');
  assert.strictEqual(r2.code, 3);
  assert.match(r2.out, /out/);
  const r3 = await wc.runInShell({ cwd: '/nowhere-at-all' }, 'echo x');
  assert.notStrictEqual(r3.code, 0);                                 // a bad cwd must not look like success
  assert.strictEqual(r3.out, '');
});

test('tailPage: a prompt appended after the page was read shows up on reopen', () => {
  wc.tailPage(chat, null);                                        // builds the reader cache
  fs.appendFileSync(file, '{"uuid":"p31","sessionId":"c-titles","timestamp":"2026-01-01T00:31:00Z","type":"user","message":{"role":"user","content":"prompt 31"}}\n');
  const pg = wc.tailPage(chat, null);
  const prompts = pg.items.filter((i) => i.type === 'user').map((i) => i.message.content);
  assert.strictEqual(prompts[prompts.length - 1], 'prompt 31');
});

test('tailPage: boundary deeper than the reader cap -> seek finds the page (long session)', () => {
  // a session whose history is over READER_MAX_BYTES (4 MB): 6 prompts, one huge tool line, more prompts.
  // The tail reader stops inside the bulk; asking for a boundary behind it must still load.
  const proj2 = path.join(tmp, '.claude', 'projects', '-w-big');
  fs.mkdirSync(proj2, { recursive: true });
  const cid2 = 'c-big';
  const file2 = path.join(proj2, cid2 + '.jsonl');
  const chat2 = { cid: cid2, cwd: '/w/big', turn: [] };
  const ln = (u, t, role, content) => `{"uuid":"${u}","sessionId":"${cid2}","timestamp":"2026-01-01T00:00:00Z","type":"${t}","message":{"role":"${role}","content":${content}}}\n`;
  let body2 = '';
  for (let i = 1; i <= 6; i++) {
    body2 += ln('P' + i, 'user', 'user', JSON.stringify('big prompt ' + i));
    body2 += ln('A' + i, 'assistant', 'assistant', JSON.stringify([{ type: 'text', text: 'big answer ' + i }]));
  }
  body2 += `{"uuid":"bulk","sessionId":"${cid2}","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"${'x'.repeat(5 * 1024 * 1024)}"}]}}\n`;
  for (let i = 7; i <= 30; i++) {
    body2 += ln('P' + i, 'user', 'user', JSON.stringify('big prompt ' + i));
    body2 += ln('A' + i, 'assistant', 'assistant', JSON.stringify([{ type: 'text', text: 'big answer ' + i }]));
  }
  fs.writeFileSync(file2, body2);
  const pg = wc.tailPage(chat2, 'P8');                     // 5 prompts before P8 (P3..P7): behind the bulk,
  assert.ok(!pg.lost, 'seek behind the reader cap returned lost');   // so the 4 MB reader cap is hit first
  const prompts = pg.items.filter((i) => i.type === 'user').map((i) => i.message.content);
  assert.deepStrictEqual(prompts, ['big prompt 3', 'big prompt 4', 'big prompt 5', 'big prompt 6', 'big prompt 7']);
  assert.ok(pg.items.some((i) => i.type === 'assistant' && i.message.content[0].text.startsWith('x')), 'the bulk line vanished from the page');
  assert.ok(!pg.items.some((i) => i.uuid === 'P12'), 'the boundary message itself leaked into the page');
  assert.ok(pg.more > 0);
  // paging continues from the seeked page and terminates at the file start
  let cur = pg, pages = 0, seen = prompts;
  while (cur.more > 0 && pages < 8) {
    const b = cur.items.find((i) => i.type === 'user');
    cur = wc.tailPage(chat2, b.uuid); pages++;
    seen = seen.concat(cur.items.filter((i) => i.type === 'user').map((i) => i.message.content));
  }
  assert.strictEqual(cur.more, 0, 'seek paging did not terminate at the file start');
  assert.ok(seen.includes('big prompt 1'), 'the first prompt never reached a seeked page');
});

test('tailPage: seek of an unknown uuid stays lost', () => {
  const proj2 = path.join(tmp, '.claude', 'projects', '-w-big');
  const chat3 = { cid: 'c-big', cwd: '/w/big', turn: [] };   // same session: reader cap already hit
  const pg = wc.tailPage(chat3, 'nope-' + 'z'.repeat(40));
  assert.strictEqual(pg.lost, true);
  assert.deepStrictEqual(pg.items, []);
  void proj2;
});
