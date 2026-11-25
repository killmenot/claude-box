'use strict';
// Sub-agent facts the chat sends with history (scripts/web-chat.js): totals parsed from the
// agent's <usage>, the model and the end state read from the transcript, and "stopped" for a
// background agent left running by a process that is gone.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-agents-'));
process.env.HOME = tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const wc = require('../scripts/web-chat.js');

test('agentUsage: both spellings Claude Code writes', () => {
  assert.deepStrictEqual(wc.agentUsage('report\nagentId: a1\n<usage>subagent_tokens: 26451\ntool_uses: 1\nduration_ms: 14821</usage>'),
    { tokens: 26451, tools: 1, ms: 14821 });
  assert.deepStrictEqual(wc.agentUsage('<usage><subagent_tokens>97313</subagent_tokens><tool_uses>18</tool_uses><duration_ms>138165</duration_ms></usage>'),
    { tokens: 97313, tools: 18, ms: 138165 });
  assert.deepStrictEqual(wc.agentUsage('<usage>total_tokens: 5\\ntool_uses: 2\\nduration_ms: 3</usage>'), { tokens: 5, tools: 2, ms: 3 });
  assert.deepStrictEqual(wc.agentUsage('no totals here'), {});
});

test('agentFacts: model, totals and end state from the transcript', () => {
  const cid = 'c-agents', proj = path.join(tmp, '.claude', 'projects', '-w-a');
  fs.mkdirSync(proj, { recursive: true });
  const line = (o) => JSON.stringify(o) + '\n';
  const res = (id, text, tur) => line({ type: 'user', uuid: 'r-' + id, timestamp: '2026-11-26T10:00:00Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] }, toolUseResult: tur });
  fs.writeFileSync(path.join(proj, cid + '.jsonl'),
    // a foreground agent that finished
    res('t-sync', 'done\n<usage>subagent_tokens: 1200\ntool_uses: 4\nduration_ms: 9000</usage>',
      { status: 'completed', agentId: 'a1', resolvedModel: 'claude-sonnet-5-5' }) +
    // a background agent that finished later (task-notification)
    res('t-bg', 'Async agent launched', { isAsync: true, status: 'async_launched', agentId: 'a2', resolvedModel: 'claude-opus-5-5' }) +
    line({ type: 'user', uuid: 'n1', timestamp: '2026-11-26T10:05:00Z', message: { role: 'user', content:
      '<task-notification>\n<task-id>a2</task-id>\n<tool-use-id>t-bg</tool-use-id>\n<status>completed</status>\n' +
      '<usage><subagent_tokens>97313</subagent_tokens><tool_uses>18</tool_uses><duration_ms>138165</duration_ms></usage>\n</task-notification>' } }) +
    // a background agent with no notification: its process is gone
    res('t-lost', 'Async agent launched', { isAsync: true, status: 'async_launched', agentId: 'a3', resolvedModel: 'claude-haiku-5-5' }));
  const chat = { cid, cwd: '/w/a', q: null, agentsView: () => ({}) };
  const f = wc.agentFacts(chat);
  assert.deepStrictEqual(f['t-sync'], { model: 'claude-sonnet-5-5', tokens: 1200, tools: 4, ms: 9000, state: 'done' });
  assert.deepStrictEqual(f['t-bg'], { model: 'claude-opus-5-5', state: 'done', tokens: 97313, tools: 18, ms: 138165 });
  assert.strictEqual(f['t-lost'].state, 'stopped');
  assert.strictEqual(f['t-lost'].model, 'claude-haiku-5-5');
  // the live process still runs it: its view wins
  const live = wc.agentFacts(Object.assign({}, chat, { q: {}, agentsView: () => ({ 't-lost': { state: 'run', tokens: 500 } }) }));
  assert.strictEqual(live['t-lost'].state, 'run');
  assert.strictEqual(live['t-lost'].tokens, 500);
});
