'use strict';
// Container startup pieces of scripts/web-serve.js + a smoke test of scripts/web-metrics.js.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-serve-'));
process.env.HOME = tmp;
process.env.TMUX_TMPDIR = tmp;
delete process.env.TMUX;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const def = path.join(tmp, 'defaults');
fs.mkdirSync(def);
fs.writeFileSync(path.join(def, 'settings.json'), JSON.stringify({ theme: 'dark' }));
fs.writeFileSync(path.join(def, 'mcp.json'), JSON.stringify({ mcpServers: { grafana: { command: 'mcp-grafana' } } }));
process.env.CLAUDE_DEFAULTS = def;

const { seedDefaults } = require('../scripts/web-serve.js');
const read = (f) => JSON.parse(fs.readFileSync(path.join(tmp, f), 'utf8'));

test('first start: settings copied, MCP merged, notify hooks installed', () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'x';
  seedDefaults();
  const s = read('.claude/settings.json');
  assert.strictEqual(s.theme, 'dark');
  assert.strictEqual(s.hooks.Stop[0].hooks[0].command, 'claude-notify done');
  assert.strictEqual(s.hooks.Notification[0].hooks[0].command, 'claude-notify waiting');
  assert.strictEqual(s.hooks.UserPromptSubmit[0].hooks[0].command, 'claude-notify working');
  const c = read('.claude.json');
  assert.deepStrictEqual(c.mcpServers, { grafana: { command: 'mcp-grafana' } });
  assert.strictEqual(c.hasCompletedOnboarding, true);
});

test('later starts keep the user\'s own settings and MCP servers', () => {
  fs.writeFileSync(path.join(tmp, '.claude/settings.json'), JSON.stringify({ theme: 'light', hooks: { PreToolUse: [] } }));
  fs.writeFileSync(path.join(tmp, '.claude.json'), JSON.stringify({ mcpServers: { mine: { command: 'x' } }, numStartups: 5 }));
  seedDefaults();
  const s = read('.claude/settings.json');
  assert.strictEqual(s.theme, 'light');
  assert.deepStrictEqual(s.hooks.PreToolUse, []);
  assert.ok(s.hooks.Stop);
  const c = read('.claude.json');
  assert.deepStrictEqual(Object.keys(c.mcpServers).sort(), ['grafana', 'mine']);
  assert.strictEqual(c.numStartups, 5);
});

test('metrics: host numbers without a token, nulls for the session part', async () => {
  const { metrics } = require('../scripts/web-metrics.js');
  const m = await metrics('');
  assert.ok(m.mem.total > 0);
  assert.ok(m.cpu >= 0 && m.cpu <= 100);
  assert.strictEqual(m.ctx, null);
  assert.strictEqual(m.git, null);
});
