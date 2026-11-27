'use strict';
// web-context.js: the session's context strip. Links of every form become one item per PR / Slack
// message / Jira issue; the transcript is read once and then only what was appended; a task folder
// adds its issue; facts come from gh (CI, review) and the Today panel's snapshot (Jira, Slack).
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ctx-')));
process.env.WEB_PANEL_FILE = path.join(tmp, 'web-panel.json');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ctx = require('../scripts/web-context.js');

test('links of every form, one item each, in order', () => {
  const t = 'see https://github.com/acme/api/pull/2290/files#diff-1 and https://github.com/acme/api/pull/2290 again;\\n' +
    'thread https://acme.slack.com/archives/C07QKABCD/p1764152345123456?thread_ts=1764150000.000100&cid=C07QKABCD done\\n' +
    'issue https://acme.atlassian.net/browse/PROJ-42, repo https://github.com/acme/web.git/pull/88)';
  const it = ctx.extract(t);
  assert.deepStrictEqual(it.map((x) => x.key), ['acme/api#2290', 'acme/api#2290', 'acme/C07QKABCD/1764152345123456', 'PROJ-42', 'acme/web#88']);
  assert.strictEqual(it[0].url, 'https://github.com/acme/api/pull/2290');
  assert.strictEqual(it[2].url, 'https://acme.slack.com/archives/C07QKABCD/p1764152345123456?thread_ts=1764150000.000100&cid=C07QKABCD');
  assert.strictEqual(it[2].ts, 1764152345.123456);
  assert.strictEqual(it[3].url, 'https://acme.atlassian.net/browse/PROJ-42');
  assert.strictEqual(it[4].url, 'https://github.com/acme/web/pull/88');
});

test('the transcript is read in full once, then only what was appended (partial lines wait)', () => {
  const f = path.join(tmp, 's.jsonl');
  fs.writeFileSync(f, '{"type":"user","m":"https://github.com/acme/api/pull/1"}\n{"type":"user","m":"https://github.com/acme/api/pu');
  assert.deepStrictEqual(ctx.scanFile(f).map((x) => x.key), ['acme/api#1']);
  fs.appendFileSync(f, 'll/2"}\n{"type":"user","m":"https://github.com/acme/api/pull/1 again"}\n');
  assert.deepStrictEqual(ctx.scanFile(f).map((x) => x.key), ['acme/api#1', 'acme/api#2']);
});

test('links in what the harness injects (CLAUDE.md attachments, meta turns, request blobs) do not count', () => {
  const f = path.join(tmp, 'inj.jsonl');
  fs.writeFileSync(f, [
    '{"type":"attachment","attachment":{"content":"e.g. [PROJ-7](https://acme.atlassian.net/browse/PROJ-7)"}}',
    '{"type":"api-request-blob","x":"https://github.com/acme/api/pull/9"}',
    '{"type":"user","isMeta":true,"message":{"content":"skill: https://github.com/acme/api/pull/8"}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"https://github.com/acme/api/pull/3"}]}}',
  ].join('\n') + '\n');
  assert.deepStrictEqual(ctx.scanFile(f).map((x) => x.key), ['acme/api#3']);
});

test('CI, review and comments of a PR from gh', () => {
  assert.strictEqual(ctx.ciOf([]), '');
  assert.strictEqual(ctx.ciOf([{ conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]), 'ok');
  assert.strictEqual(ctx.ciOf([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }]), 'pend');
  assert.strictEqual(ctx.ciOf([{ conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }]), 'fail');
  assert.deepStrictEqual(ctx.prFacts({ state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', comments: [{}, {}], reviews: [{ body: 'lgtm' }, { body: '' }],
    labels: [{ name: 'bug' }], statusCheckRollup: [{ conclusion: 'SUCCESS' }] }),
  { title: '', author: '', state: 'open', ci: 'ok', review: 'approved', comments: 3, labels: ['bug'] });
  assert.strictEqual(ctx.prFacts({ state: 'OPEN', isDraft: true }).state, 'draft');
  assert.strictEqual(ctx.prFacts({ state: 'MERGED' }).state, 'merged');
});

test('a task folder adds its issue first; Jira and Slack facts come from the Today snapshot', () => {
  const task = path.join(tmp, 'tasks', 'proj-42');
  fs.mkdirSync(path.join(task, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(task, '.task.json'), JSON.stringify({ key: 'PROJ-42', url: 'https://acme.atlassian.net/browse/PROJ-42' }));
  fs.writeFileSync(process.env.WEB_PANEL_FILE, JSON.stringify({ agent: {
    jira: [{ key: 'PROJ-42', title: 'summary groupBy=all', status: 'In Review' }],
    slack: [{ channel: 'team-chat', from: 'Alex', url: 'https://acme.slack.com/archives/C07QKABCD/p1764152345123456' }] } }));
  const f = path.join(tmp, 't.jsonl');
  fs.writeFileSync(f, '{"type":"user","m":"https://acme.slack.com/archives/C07QKABCD/p1764152345123456 and https://acme.atlassian.net/browse/PROJ-1"}\n');
  const items = ctx.forSession(f, path.join(task, 'sub'));
  assert.deepStrictEqual(items.map((x) => x.kind + ':' + x.key), ['jira:PROJ-42', 'slack:acme/C07QKABCD/1764152345123456', 'jira:PROJ-1']);
  assert.strictEqual(items[0].status, 'In Review');
  assert.strictEqual(items[0].own, true);
  assert.strictEqual(items[1].channelName, 'team-chat');
  assert.strictEqual(items[1].from, 'Alex');
});
