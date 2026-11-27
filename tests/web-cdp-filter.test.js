'use strict';
// web-cdp-filter.js: Claude's playwright tools in a session see only that session's tabs of the box
// browser; other sessions' and the shared window's tabs are never listed, attached or closed, a page
// that is not theirs is let go (never left paused), and a new page opens in the session's window.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const { Filter, NOT_HERE } = require('../scripts/web-cdp-filter.js');

function make(mine) {
  const toClient = [], toBrowser = [];
  const scope = new Set(mine);
  const f = new Filter({
    inScope: async (id) => scope.has(id),
    claim: (id) => scope.add(id),
    createTab: async () => { scope.add('new1'); return 'new1'; },
    toClient: (o) => toClient.push(o), toBrowser: (o) => toBrowser.push(o),
  });
  return { f, toClient, toBrowser };
}
const page = (targetId, extra) => Object.assign({ targetId, type: 'page', url: 'https://x/' + targetId }, extra || {});

test('only the session\'s own pages are attached; the others are released and let go', async () => {
  const { f, toClient, toBrowser } = make(['mine']);
  await f.fromBrowser({ method: 'Target.attachedToTarget', params: { sessionId: 'S1', targetInfo: page('mine'), waitingForDebugger: true } });
  await f.fromBrowser({ method: 'Target.attachedToTarget', params: { sessionId: 'S2', targetInfo: page('slack'), waitingForDebugger: true } });
  assert.deepStrictEqual(toClient.map((o) => o.params.sessionId), ['S1']);
  assert.deepStrictEqual(toBrowser.map((o) => o.method), ['Runtime.runIfWaitingForDebugger', 'Target.detachFromTarget']);
  assert.strictEqual(toBrowser[0].sessionId, 'S2');
  // answers to those internal calls never reach the client
  await f.fromBrowser({ id: toBrowser[0].id, result: {} });
  assert.strictEqual(toClient.length, 1);
});

test('getTargets lists only the session\'s pages; commands on another tab are refused', async () => {
  const { f, toClient, toBrowser } = make(['mine']);
  await f.fromClient({ id: 1, method: 'Target.getTargets' });
  await f.fromBrowser({ id: 1, result: { targetInfos: [page('mine'), page('other'), { targetId: 'sw', type: 'service_worker' }] } });
  assert.deepStrictEqual(toClient[0].result.targetInfos.map((t) => t.targetId), ['mine']);
  await f.fromClient({ id: 2, method: 'Target.closeTarget', params: { targetId: 'other' } });
  await f.fromClient({ id: 3, method: 'Target.attachToTarget', params: { targetId: 'other', flatten: true } });
  await f.fromClient({ id: 4, method: 'Runtime.evaluate', params: {}, sessionId: 'S-of-other' });
  await f.fromClient({ id: 5, method: 'Browser.close' });
  assert.deepStrictEqual(toClient.slice(1).map((o) => o.error && o.error.message.slice(0, 20)), [NOT_HERE.slice(0, 20), NOT_HERE.slice(0, 20), NOT_HERE.slice(0, 20), 'The box browser is s']);
  assert.strictEqual(toBrowser.length, 1, 'only getTargets went to the browser');
});

test('a new page opens in the session\'s window; its announcement comes before the answer', async () => {
  const { f, toClient } = make([]);
  const asked = f.fromClient({ id: 7, method: 'Target.createTarget', params: { url: 'about:blank' } });
  await new Promise((r) => setTimeout(r, 20));
  await f.fromBrowser({ method: 'Target.attachedToTarget', params: { sessionId: 'N', targetInfo: page('new1'), waitingForDebugger: true } });
  await asked;
  assert.deepStrictEqual(toClient.map((o) => o.method || ('answer ' + o.result.targetId)), ['Target.attachedToTarget', 'answer new1']);
  // its session works; frames under it join
  await f.fromBrowser({ sessionId: 'N', method: 'Target.attachedToTarget', params: { sessionId: 'F', targetInfo: { targetId: 'fr', type: 'iframe' } } });
  await f.fromBrowser({ sessionId: 'F', method: 'Page.frameNavigated', params: {} });
  assert.strictEqual(toClient.length, 4);
});

test('a popup of the session\'s page is the session\'s too', async () => {
  const { f, toClient } = make(['mine']);
  await f.fromBrowser({ method: 'Target.attachedToTarget', params: { sessionId: 'S1', targetInfo: page('mine') } });
  await f.fromBrowser({ method: 'Target.attachedToTarget', params: { sessionId: 'P', targetInfo: page('pop', { openerId: 'mine' }) } });
  assert.strictEqual(toClient.length, 2);
  await f.fromBrowser({ method: 'Target.targetDestroyed', params: { targetId: 'other' } });
  await f.fromBrowser({ method: 'Target.targetDestroyed', params: { targetId: 'pop' } });
  assert.strictEqual(toClient.length, 3);
});
