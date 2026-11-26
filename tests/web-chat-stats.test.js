'use strict';
// The /context and /usage dialogs: what scripts/web-chat.js makes of the SDK's answers, that a
// stopped session is never resumed to answer them (a resumed process writes a zeroed cost-state
// into the transcript), and the dialog HTML the launcher renders from them.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-stats-'));
process.env.HOME = tmp;
fs.mkdirSync(path.join(tmp, '.claude'));      // the ring's measurements are saved there
// after the ring's debounced save (1 s) has written into tmp
test.after(async () => { await new Promise((r) => setTimeout(r, 1300)); fs.rmSync(tmp, { recursive: true, force: true }); });

// A stand-in for the Agent SDK: every query() is recorded with its options.
const CONTEXT = {
  categories: [
    { id: 'system_prompt', name: 'System prompt', tokens: 1924, color: 'promptBorder', kind: 'used' },
    { id: 'system_tools', name: 'System tools', tokens: 8167, color: 'inactive', kind: 'used' },
    { id: 'system_tools_deferred', name: 'System tools (deferred)', tokens: 13396, color: 'inactive', isDeferred: true, kind: 'deferred' },
    { id: 'memory_files', name: 'Memory files', tokens: 331, color: 'claude', kind: 'used' },
    { id: 'messages', name: 'Messages', tokens: 0, color: 'x', kind: 'used' },
    { id: 'autocompact_buffer', name: 'Autocompact buffer', tokens: 33000, color: 'inactive', kind: 'buffer' },
    { id: 'free_space', name: 'Free space', tokens: 954514, color: 'promptBorder', kind: 'free' },
  ],
  totalTokens: 12486, maxTokens: 1000000, rawMaxTokens: 1000000, percentage: 1, model: 'claude-opus-5-5',
  memoryFiles: [{ path: '/home/node/.claude/CLAUDE.md', type: 'User', tokens: 331 }],
  mcpTools: [{ name: 'a', serverName: 'atlassian', tokens: 500 }, { name: 'b', serverName: 'atlassian', tokens: 300, isLoaded: false }],
  skills: { totalSkills: 13, includedSkills: 13, tokens: 2064, skillFrontmatter: [] },
  autoCompactThreshold: 967000, isAutoCompactEnabled: true,
  messageBreakdown: { toolCallTokens: 1, toolResultTokens: 2, attachmentTokens: 0, assistantMessageTokens: 3, userMessageTokens: 4 },
  apiUsage: null,
};
const USAGE = {
  session: { total_cost_usd: 0.57, total_api_duration_ms: 126000, total_duration_ms: 398000, total_lines_added: 3, total_lines_removed: 1,
    model_usage: { 'claude-opus-5-5': { inputTokens: 47200, outputTokens: 4100, cacheReadInputTokens: 449500, cacheCreationInputTokens: 0, costUSD: 0.56 } } },
  subscription_type: 'pro', rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 11, resets_at: '2026-11-27T06:10:00Z' }, seven_day: { utilization: 67, resets_at: '2026-11-30T17:00:00Z' },
    seven_day_opus: null, model_scoped: [{ display_name: 'Fable', utilization: 95, resets_at: null }] },
  behaviors: { day: { request_count: 120, session_count: 4, behaviors: [],
    recommendations: [{ key: 'long_context', pct: 76, title: 'Start fresh when you switch tasks', detail: 'run /clear' }],
    agents: [], skills: [], plugins: [], mcp_servers: [{ name: 'atlassian', pct: 1 }] }, week: null },
};
const sdkFile = path.join(tmp, 'mock-sdk.mjs');
fs.writeFileSync(sdkFile, `
export function query({ prompt, options }) {
  const rec = { options, closed: false, usageOpts: [] };
  (globalThis.__probes = globalThis.__probes || []).push(rec);
  return {
    getContextUsage: async () => (${JSON.stringify(CONTEXT)}),
    accountInfo: async () => ({ email: 'a@example.test', organization: 'Org <b>', tokenSource: 'claude.ai', apiProvider: 'firstParty' }),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (o) => { rec.usageOpts.push(o); const u = ${JSON.stringify(USAGE)};
      if (o && o.skipBehaviors) u.behaviors = null; return u; },
    supportedCommands: async () => [], supportedModels: async () => [], getSettings: async () => ({ applied: {} }),
    close() { rec.closed = true; },
    [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; },
  };
}
`);
// web-chat.js loads the SDK only when the ws module is there (it is in the image, not on a Mac)
const mods = path.join(tmp, 'node_modules');
fs.mkdirSync(path.join(mods, 'ws'), { recursive: true });
fs.writeFileSync(path.join(mods, 'ws', 'index.js'), 'exports.WebSocketServer = class {};');
process.env.WEB_CHAT_MODULES = mods;
process.env.WEB_CHAT_SDK = sdkFile;
process.env.WEB_RESUME_LOOPS = '0';

const wc = require('../scripts/web-chat.js');
const probes = () => globalThis.__probes || [];

test('ctxView: every row with its kind, memory files, MCP servers by name', () => {
  const v = wc.ctxView(CONTEXT);
  assert.strictEqual(v.total, 12486); assert.strictEqual(v.max, 1000000); assert.strictEqual(v.pct, 1);
  assert.deepStrictEqual(v.cats.map((k) => k.id),
    ['system_prompt', 'system_tools', 'system_tools_deferred', 'memory_files', 'autocompact_buffer', 'free_space']);   // empty rows dropped
  assert.deepStrictEqual(v.mcp, [{ name: 'atlassian', tokens: 800, tools: 2, loaded: 1 }]);
  assert.strictEqual(v.memory[0].tokens, 331);
  assert.strictEqual(v.autoCompact, 967000);
  assert.strictEqual(wc.ctxView({}), null);
});

test('usageView: limits, account and session totals; null for an unknown shape', () => {
  const v = wc.usageView(USAGE, { email: 'e', subscriptionType: 'max', apiProvider: 'firstParty' });
  assert.strictEqual(v.plan, 'pro');
  assert.strictEqual(v.limitsAvailable, true);
  assert.strictEqual(v.limits.five_hour.utilization, 11);
  assert.strictEqual(v.session.cost, 0.57);
  assert.deepStrictEqual(v.session.models['claude-opus-5-5'], { input: 47200, output: 4100, cacheRead: 449500, cacheWrite: 0, cost: 0.56 });
  assert.strictEqual(v.account.provider, 'firstParty');
  assert.strictEqual(wc.usageView({ something: 1 }, null), null);
  assert.strictEqual(wc.usageView(null, null), null);
});

test('stats on a stopped session: no resume, last measurement for /context, a fresh process for /usage', async () => {
  const cwd = fs.mkdtempSync(path.join(tmp, 'w-'));
  const chat = new wc.Chat({ cid: 'cid-stopped', cwd, name: 'chat-x', token: 'tok1' });
  await new Promise((r) => setTimeout(r, 50));       // the constructor's command-list probe
  const before = probes().length;

  // never measured: the folder's baseline from a probe
  const c = await chat.stats('context');
  assert.strictEqual(c.live, false); assert.strictEqual(c.baseline, true);
  assert.strictEqual(c.data.total, 12486);

  const u = await chat.stats('usage');
  assert.strictEqual(u.live, false);
  assert.strictEqual(u.data.session, null);           // a fresh process has no totals of this session
  assert.strictEqual(u.data.limits.seven_day.utilization, 67);
  assert.strictEqual(u.data.account.organization, 'Org <b>');

  const mine = probes().slice(before);
  assert.strictEqual(mine.length, 2);
  for (const p of mine) {
    assert.strictEqual(p.options.resume, undefined, 'a probe must never resume the session');
    assert.strictEqual(p.closed, true, 'a probe is closed after it answered');
  }
  assert.deepStrictEqual(mine[1].usageOpts, [{ skipBehaviors: true }]);
  await assert.rejects(chat.stats('nope'), /unknown stats/);
});

test('stats on a running session asks its own process and refreshes the ring', async () => {
  const cwd = fs.mkdtempSync(path.join(tmp, 'w-'));
  const chat = new wc.Chat({ cid: 'cid-live', cwd, name: 'chat-y', token: 'tok2' });
  await new Promise((r) => setTimeout(r, 50));
  const sdk = await import(require('url').pathToFileURL(sdkFile).href);
  chat.q = sdk.query({ prompt: null, options: { cwd, resume: 'cid-live' } });
  const before = probes().length;
  const c = await chat.stats('context');
  assert.strictEqual(c.live, true);
  assert.strictEqual(chat.info.context.total, 12486);
  const u = await chat.stats('usage');
  assert.strictEqual(u.data.session.cost, 0.57);
  assert.strictEqual(probes().length, before, 'no extra process for a running session');
  chat.q = null;
});

// ---- the launcher's dialog HTML (html/launcher.html), lifted out and run in a sandbox ----
const html = fs.readFileSync(path.join(__dirname, '..', 'html', 'launcher.html'), 'utf8');
function slice(from, to) {
  const a = html.indexOf(from); assert.ok(a >= 0, from + ' not found in launcher.html');
  const b = html.indexOf(to, a); assert.ok(b > a, to + ' not found after ' + from);
  return html.slice(a, b);
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext([
  slice('function esc(', '\n'),
  slice('function ctxK(', '\n'),
  slice('var CAT_SLOT=', "$('statclose')"),
].join('\n'), ctx);

test('launcher: /context dialog rows, colors by row id, escaped paths', () => {
  const v = wc.ctxView(Object.assign({}, CONTEXT, { memoryFiles: [{ path: '/home/node/<img src=x>.md', type: 'User', tokens: 5 }] }));
  const h = ctx.ctxHtml({ live: true, data: v });
  assert.match(h, /claude-opus-5-5/);
  assert.match(h, /12\.5k \/ 1\.00M tokens \(1%\)/);
  assert.match(h, /System prompt/); assert.match(h, /Free space/);
  assert.match(h, /System tools — loaded on demand/);
  assert.match(h, /background:var\(--cat1\)/);                 // system_prompt is slot 1
  assert.match(h, /~\/&lt;img src=x&gt;\.md/);
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /Auto-compact at 967\.0k tokens/);
  // a stopped session's last measurement: summary rows only, free space derived
  const last = { total: 50000, max: 200000, pct: 25, at: Date.now() - 600000, cats: [{ name: 'Messages', tokens: 50000, kind: 'used' }] };
  const h2 = ctx.ctxHtml({ live: false, data: last });
  assert.match(h2, /150\.0k/); assert.match(h2, /Measured 10 min ago; the session is not running/);
  assert.match(h2, /background:var\(--cat8\)/);                // matched by name when the id is missing
});

test('launcher: /usage dialog meters, account, behaviors, no-limits login', () => {
  const v = wc.usageView(USAGE, { email: 'a@example.test', organization: 'Org <b>', tokenSource: 'claude.ai', apiProvider: 'firstParty' });
  const h = ctx.usageHtml({ live: true, data: v }, USAGE.behaviors, 'day');
  assert.match(h, /Session \(5h\)/); assert.match(h, /Weekly \(7 day\)/);
  assert.match(h, /width:67%/);
  assert.match(h, /meter hi[^]*Weekly · Fable/);              // 95%: near the limit
  assert.match(h, /Claude Pro/); assert.match(h, /Org &lt;b&gt;/);
  assert.match(h, /Start fresh when you switch tasks/); assert.match(h, /atlassian/);
  assert.match(h, /\$0\.57/); assert.match(h, /2m 6s/);
  assert.match(ctx.usageHtml({ live: true, data: v }, USAGE.behaviors, 'week'), /No data for this period/);   // week: null
  // behaviors still scanning, and a login without plan limits
  const h2 = ctx.usageHtml({ live: false, data: Object.assign({}, v, { limitsAvailable: false, limits: null, session: null }) }, undefined, 'day');
  assert.match(h2, /Plan limits don't apply/);
  assert.match(h2, /Scanning this box's sessions/);
  assert.match(h2, /Totals show while the session is running/);
});
