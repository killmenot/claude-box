'use strict';
// The pr-watch skill's helper (claude-defaults/skills/pr-watch/bin/pr-watch): which PRs get a review,
// and what gets posted. Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const { parseRemote, decide, plan, fingerprint, DEFAULTS } = require('../claude-defaults/skills/pr-watch/bin/pr-watch');

const NOW = Date.parse('2026-11-26T12:00:00Z');
const pr = (n, o) => Object.assign({ number: n, title: 't' + n, author: { login: 'alice' }, isDraft: false,
  headRefOid: 'sha' + n, updatedAt: '2026-11-26T10:00:00Z', reviewRequests: [], url: 'u' + n }, o || {});
const cfg = (o) => Object.assign({}, DEFAULTS, o || {});
const refs = (l) => l.map((x) => x.ref);

test('repo names from origin URLs', () => {
  assert.strictEqual(parseRemote('https://github.com/acme/api.git'), 'acme/api');
  assert.strictEqual(parseRemote('git@github.com:acme/web-app.git\n'), 'acme/web-app');
  assert.strictEqual(parseRemote('https://github.com/acme/api'), 'acme/api');
  assert.strictEqual(parseRemote('https://gitlab.com/acme/api.git'), '');
});

test('own, draft, bot, stale and baseline PRs are skipped; new ones and new commits are todo', () => {
  const state = { prs: {
    'acme/api#5': { status: 'baseline', sha: 'sha5' },
    'acme/api#6': { status: 'baseline', sha: 'old' },
    'acme/api#7': { status: 'done', sha: 'sha7' },
    'acme/api#8': { status: 'running', sha: 'x' },
    'acme/api#9': { status: 'done', sha: 'old', findings: [{ title: 'bug' }] },
    'acme/api#10': { status: 'error', sha: 'sha10', errors: 2 },
  } };
  const prs = [pr(1), pr(2, { author: { login: 'me' } }), pr(3, { isDraft: true }), pr(4, { author: { login: 'dependabot[bot]' } }),
    pr(5), pr(6), pr(7), pr(8), pr(9), pr(10), pr(11, { updatedAt: '2026-10-01T00:00:00Z' })];
  const { todo, skipped } = decide('acme/api', prs, state, cfg(), 'me', [], NOW);
  assert.deepStrictEqual(refs(todo), ['acme/api#1', 'acme/api#6', 'acme/api#9']);
  assert.strictEqual(todo.find((t) => t.number === 6).reason, 'new commits');
  assert.deepStrictEqual(todo.find((t) => t.number === 9).previous, [{ title: 'bug' }]);
  const why = Object.fromEntries(skipped.map((s) => [s.ref.split('#')[1], s.why]));
  assert.match(why[2], /own/); assert.strictEqual(why[3], 'draft'); assert.strictEqual(why[4], 'bot');
  assert.match(why[5], /baseline/); assert.match(why[7], /reviewed/); assert.match(why[8], /running/);
  assert.match(why[10], /twice/); assert.strictEqual(why[11], 'stale');
});

test('only_requested keeps the PRs that ask me or my team for a review', () => {
  const prs = [pr(1), pr(2, { reviewRequests: [{ login: 'me' }] }), pr(3, { reviewRequests: [{ slug: 'backend' }] })];
  const { todo } = decide('acme/api', prs, { prs: {} }, cfg({ only_requested: true }), 'me', ['backend'], NOW);
  assert.deepStrictEqual(refs(todo), ['acme/api#2', 'acme/api#3']);
});

test('posting: only critical/high, never habits, never twice', () => {
  const r = { findings: [
    { severity: 'high', file: 'a.ts', title: 'Bug' },
    { severity: 'medium', file: 'b.ts', title: 'Edge' },
    { severity: 'critical', file: 'c.ts', title: 'Leak', source: 'habits' },
    { severity: 'critical', file: 'd.ts', title: 'Loss' },
  ] };
  const first = plan(r, cfg(), new Set());
  assert.deepStrictEqual(first.toPost.map((f) => f.title), ['Bug', 'Loss']);
  assert.strictEqual(first.held, 1);
  const again = plan(r, cfg(), new Set([fingerprint({ file: 'a.ts', title: 'bug ' })]));
  assert.deepStrictEqual(again.toPost.map((f) => f.title), ['Loss']);
  assert.strictEqual(plan({ findings: [] }, cfg(), new Set()).blocking.length, 0);
});

test('authors: only the listed logins, for all repos or per repo', () => {
  const prs = [pr(1), pr(2, { author: { login: 'Bob' } }), pr(3, { author: { login: 'carol' } })];
  const st = { prs: {} };
  assert.deepStrictEqual(refs(decide('acme/api', prs, st, cfg({ authors: ['bob', 'carol'] }), 'me', [], NOW).todo), ['acme/api#2', 'acme/api#3']);
  const per = cfg({ authors: { 'acme/api': ['alice'], '*': ['carol'] } });
  assert.deepStrictEqual(refs(decide('acme/api', prs, st, per, 'me', [], NOW).todo), ['acme/api#1']);
  assert.deepStrictEqual(refs(decide('acme/web', prs, st, per, 'me', [], NOW).todo), ['acme/web#3']);
  const skipped = decide('acme/api', prs, st, cfg({ authors: ['bob'] }), 'me', [], NOW).skipped;
  assert.strictEqual(skipped.find((s) => s.ref === 'acme/api#1').why, 'author not watched');
});
