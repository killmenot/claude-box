'use strict';
// Search through session history (scripts/web-search.js) + the sidecar's /search route.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-search-'));
process.env.HOME = tmp;
process.env.TMUX_TMPDIR = tmp;                       // a private tmux server: never the developer's own
delete process.env.TMUX;                             // (inside tmux, $TMUX would point back at the real one)
process.env.CLAUDE_PROJECTS_DIR = path.join(tmp, 'projects');
process.env.CLAUDE_WEB_REGISTRY = path.join(tmp, 'web-sessions.json');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const proj = path.join(tmp, 'projects', '-test-proj');
fs.mkdirSync(proj, { recursive: true });
const line = (o) => JSON.stringify(o) + '\n';
fs.writeFileSync(path.join(proj, 'sess-alpha.jsonl'),
  line({ type: 'user', message: { content: 'hello WORLD foo' }, timestamp: '2026-06-28T10:00:00Z' }) +
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'assistant says banana' }] }, timestamp: '2026-06-28T10:00:05Z' }) +
  line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'world tool noise' }] }, timestamp: '2026-06-28T10:00:06Z' }) +
  'not a valid json line\n' +
  line({ type: 'user', message: { content: 'math a+b=c result' }, timestamp: '2026-06-28T10:00:07Z' }) +
  line({ type: 'user', message: { content: 'xay regextrap' }, timestamp: '2026-06-28T10:00:08Z' }) +
  line({ type: 'user', message: { content: 'hi ΜΗΛΟ' }, timestamp: '2026-06-28T10:01:00Z' }));
fs.writeFileSync(path.join(proj, 'sess-beta.jsonl'),
  line({ type: 'user', message: { content: 'another WORLD here' }, timestamp: '2026-06-28T09:00:00Z' }));
fs.writeFileSync(path.join(proj, 'orphan.jsonl'),
  line({ type: 'user', message: { content: 'WORLD orphan not in registry' }, timestamp: '2026-06-28T11:00:00Z' }));
fs.writeFileSync(process.env.CLAUDE_WEB_REGISTRY, JSON.stringify({
  'tok-a': { token: 'tok-a', claudeSessionId: 'sess-alpha', cwd: '/test/proj', name: 'Alpha', state: 'done', tmuxSession: 'alpha-x', lastActivity: 1782000000 },
  'tok-b': { token: 'tok-b', claudeSessionId: 'sess-beta', cwd: '/test/proj', name: 'Beta', state: 'done', tmuxSession: 'beta-x', lastActivity: 1782000001 },
}));

const { search } = require('../scripts/web-search.js');

test('prompts: registry sessions only, tool results ignored, newest first', async () => {
  const r = await search('world', 'prompts');
  assert.deepStrictEqual(r.map((x) => x.token), ['tok-a', 'tok-b']);
  assert.match(r[0].snippet.toLowerCase(), /world/);
});
test('assistant text only under scope "all"', async () => {
  assert.strictEqual((await search('banana', 'prompts')).length, 0);
  assert.strictEqual((await search('banana')).length, 0);                 // default scope is prompts
  const r = await search('banana', 'all');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].type, 'assistant');
});
test('unicode case-insensitive (and a broken line is skipped)', async () => {
  const r = await search('μηλο', 'prompts');
  assert.deepStrictEqual(r.map((x) => x.token), ['tok-a']);
});
test('the query is literal, not a regex', async () => {
  assert.strictEqual((await search('a+b', 'prompts')).length, 1);
  assert.strictEqual((await search('x.y', 'prompts')).length, 0);
});
test('empty query -> []', async () => {
  assert.deepStrictEqual(await search('', 'prompts'), []);
});

test('sidecar /search route', async (t) => {
  const port = String(20000 + Math.floor(Math.random() * 20000));
  Object.assign(process.env, { WEB_TERMINAL_PORT: port, WEB_TERMINAL_INTERFACE: '127.0.0.1', WEB_TERMINAL_PASSWORD: '' });
  delete process.env.WEB_TLS_CERT; delete process.env.WEB_TLS_KEY;
  process.env.WEB_CHAT_MODULE = '/nonexistent';                          // no Agent SDK needed here
  process.env.WEB_WORKSPACE_MODULE = '/nonexistent';
  const errors = console.error; console.error = () => {};
  const servers = require('../scripts/web-sidecar.js').start();
  console.error = errors;
  t.after(() => servers.forEach((s) => s.close()));
  const get = (p) => new Promise((res, rej) => http.get('http://127.0.0.1:' + port + p, (r) => {
    let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(JSON.parse(b)));
  }).on('error', rej));
  for (let i = 0; i < 50; i++) { try { await get('/search?q='); break; } catch (_) { await new Promise((r) => setTimeout(r, 100)); } }
  assert.deepStrictEqual(await get('/search?q='), []);
  const r = await get('/search?q=another+world&scope=prompts');
  assert.deepStrictEqual(r.map((x) => x.token), ['tok-b']);
});
