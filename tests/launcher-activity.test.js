'use strict';
// The chat's activity line (html/launcher.html: actStart, actOn, actView, actClock): what it says
// while a turn runs, from the SDK messages a session streams. The functions are lifted out of the
// page and run in a sandbox.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'html', 'launcher.html'), 'utf8');
function slice(from, to) {
  const a = html.indexOf(from); assert.ok(a >= 0, from + ' not found in launcher.html');
  const b = html.indexOf(to, a); assert.ok(b > a, to + ' not found after ' + from);
  return html.slice(a, b);
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext([
  slice('function ctxK(', '\n'),
  // the page declares fmtDur twice; the later one (next to fmtAgo) is the one in effect
  slice('function fmtDur(ms){ var s=Math.round(', 'function fmtAgo('),
  slice('var ACT_STALL=', '// flow: the caller'),
].join('\n'), ctx);
const { actStart, actOn, actView, actClock, actPrompt } = ctx;

const se = (event, parent) => ({ type: 'stream_event', event, parent_tool_use_id: parent || null });
const T0 = 1_000_000;

test('a fresh turn waits for the model and counts the seconds', () => {
  const a = actStart(T0);
  let v = actView(a, T0 + 12000);
  assert.strictEqual(v.label, 'Waiting for the model…');
  assert.strictEqual(v.meta, '12s');
  assert.strictEqual(v.stalled, false);
  a.boot = true;
  assert.strictEqual(actView(a, T0).label, 'Starting…');
  actOn(a, se({ type: 'message_start' }), T0 + 1000);
  assert.strictEqual(a.boot, false);
});

test('thinking: the label, a rough token count and the last line of the thought', () => {
  const a = actStart(T0);
  actOn(a, se({ type: 'content_block_start', content_block: { type: 'thinking' } }), T0 + 2000);
  actOn(a, se({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'First idea.\nNow checking the ' } }), T0 + 3000);
  actOn(a, se({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'org settings' + 'x'.repeat(1300) } }), T0 + 4000);
  const v = actView(a, T0 + 7000);
  assert.strictEqual(v.label, 'Thinking…');
  assert.strictEqual(v.meta, '5s · ~335 tokens');
  assert.ok(v.tail.startsWith('…') && v.tail.length === 161, v.tail);
  assert.doesNotMatch(v.tail, /First idea/);
});

test('the reply being typed hides the line; its cursor says enough', () => {
  const a = actStart(T0);
  actOn(a, se({ type: 'content_block_start', content_block: { type: 'text' } }), T0 + 1000);
  assert.strictEqual(actView(a, T0 + 2000), null);
});

test('tools: preparing, running, several at once, done when every result is back', () => {
  const a = actStart(T0);
  actOn(a, se({ type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Bash' } }), T0 + 1000);
  actOn(a, se({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"command":"ls -la"}' } }), T0 + 1500);
  let v = actView(a, T0 + 3000);
  assert.strictEqual(v.label, 'Preparing Bash…');
  assert.strictEqual(v.meta, '2s · ~5 tokens');
  actOn(a, se({ type: 'content_block_stop' }), T0 + 3000);
  actOn(a, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } }, T0 + 3000);
  actOn(a, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__claude_ai_Atlassian__getJiraIssue' }] } }, T0 + 3100);
  v = actView(a, T0 + 10000);
  assert.strictEqual(v.label, 'Running Bash + 1 more…');
  assert.strictEqual(v.meta, '7s');
  actOn(a, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }, T0 + 11000);
  assert.strictEqual(actView(a, T0 + 11000).label, 'Running Atlassian: getJiraIssue…');
  actOn(a, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2' }] } }, T0 + 12000);
  v = actView(a, T0 + 15000);
  assert.strictEqual(v.label, 'Waiting for the model…');
  assert.strictEqual(v.meta, '3s');
});

test('no event for 90 s turns the line amber, but a running tool never stalls', () => {
  const a = actStart(T0);
  assert.strictEqual(actView(a, T0 + 89000).stalled, false);
  let v = actView(a, T0 + 90000);
  assert.strictEqual(v.stalled, true);
  assert.strictEqual(v.label, 'No response from the model for 1m 30s');
  assert.strictEqual(v.meta, '');
  actOn(a, se({ type: 'content_block_start', content_block: { type: 'text' } }), T0 + 100000);
  assert.strictEqual(actView(a, T0 + 120000), null);
  assert.strictEqual(actView(a, T0 + 200000).stalled, true);   // a reply stuck mid-sentence shows again
  actOn(a, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash' }] } }, T0 + 200000);
  v = actView(a, T0 + 900000);
  assert.strictEqual(v.stalled, false);
  assert.strictEqual(v.label, 'Running Bash…');
});

test('a sub-agent keeps the turn alive without changing what the parent is doing', () => {
  const a = actStart(T0);
  actOn(a, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ag', name: 'Agent' }] } }, T0 + 1000);
  actOn(a, se({ type: 'content_block_start', content_block: { type: 'text' } }, 'ag'), T0 + 50000);
  assert.strictEqual(a.last, T0 + 50000);
  assert.strictEqual(actView(a, T0 + 60000).label, 'Running Agent…');
});

test('after the result, background agents keep the turn open without a stall', () => {
  const a = actStart(T0);
  actOn(a, { type: 'result', subtype: 'success' }, T0 + 1000);
  const v = actView(a, T0 + 600000);
  assert.strictEqual(v.label, 'Background agents are working…');
  assert.strictEqual(v.stalled, false);
});

test('a reloaded page replays the turn: start time from the prompt, the tool still running', () => {
  const items = [
    { type: 'user', message: { content: 'old prompt' }, ts: T0 - 600000 },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'o', name: 'Read' }] }, ts: T0 - 590000 },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'o' }] }, ts: T0 - 589000 },
    { type: 'user', message: { content: [{ type: 'text', text: 'give the VM read access' }] }, ts: T0 - 60000 },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash' }] }, ts: T0 - 20000 },
  ];
  const a = actStart(T0);
  items.forEach((m) => { if (actPrompt(m) && m.ts) a.t0 = m.ts; actOn(a, m, m.ts || a.last); });
  assert.strictEqual(a.t0, T0 - 60000);
  const v = actView(a, T0);
  assert.strictEqual(v.label, 'Running Bash…');
  assert.strictEqual(v.meta, '20s');
  assert.strictEqual(actPrompt({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b' }] } }), false);
});

test('actClock: m:ss, and h:mm:ss past an hour', () => {
  assert.strictEqual(actClock(0), '0:00');
  assert.strictEqual(actClock(42000), '0:42');
  assert.strictEqual(actClock(605000), '10:05');
  assert.strictEqual(actClock(3725000), '1:02:05');
});
