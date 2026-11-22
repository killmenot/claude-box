'use strict';
// web-wire.js: the streamed answer is rebuilt into one message; run ids from the URL are checked.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.WEB_WIRE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-'));
process.env.WEB_WIRE_SETTINGS = path.join(process.env.WEB_WIRE_DIR, 'settings.json');
const wire = require('../scripts/web-wire.js');

test('recording is off by default and begin() then leaves the environment alone', async () => {
  assert.strictEqual(wire.getSettings().enabled, false);
  const r = await wire.begin('chat', 'x', { A: '1' });
  assert.strictEqual(r.id, null);
  assert.deepStrictEqual(r.env, { A: '1' });
});

test('compact stores only what an earlier request did not send', () => {
  const st = { parts: new Map(), prev: [] };
  const m1 = { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] };
  const m1b = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
  const a = { role: 'assistant', content: [{ type: 'text', text: 'hello' }] };
  const one = wire.compact(st, 1, { system: 'S', tools: [{ name: 'Bash' }], messages: [m1] });
  assert.strictEqual(one.system, 'S'); assert.strictEqual(one.messagesFrom, undefined);
  const two = wire.compact(st, 2, { system: 'S', tools: [{ name: 'Bash' }], messages: [m1b, a] });
  assert.deepStrictEqual(two.system, { $same_as: 1 });
  assert.deepStrictEqual(two.tools, { $same_as: 1 });
  assert.deepStrictEqual(two.messagesFrom, { req: 1, count: 1 });
  assert.deepStrictEqual(two.messages, [a]);
});

test('assemble rebuilds text, tool calls and usage from the SSE stream', () => {
  const ev = (o) => 'event: x\ndata: ' + JSON.stringify(o) + '\n\n';
  const sse = ev({ type: 'message_start', message: { id: 'm1', model: 'claude-haiku-5-5', usage: { input_tokens: 10 } } }) +
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }) +
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }) +
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'StructuredOutput', input: {} } }) +
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"kind":' } }) +
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"done"}' } }) +
    ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } });
  const m = wire.assemble(sse);
  assert.strictEqual(m.model, 'claude-haiku-5-5');
  assert.strictEqual(m.content[0].text, 'Hello');
  assert.deepStrictEqual(m.content[1].input, { kind: 'done' });
  assert.strictEqual(m.stop_reason, 'tool_use');
  assert.deepStrictEqual(m.usage, { input_tokens: 10, output_tokens: 7 });
});

test('get refuses ids that could leave the record folder', () => {
  assert.strictEqual(wire.get('../web-inbox'), null);
  assert.strictEqual(wire.get('a/b'), null);
  assert.strictEqual(wire.get('missing-run'), null);
  assert.deepStrictEqual(wire.list(), []);
});
