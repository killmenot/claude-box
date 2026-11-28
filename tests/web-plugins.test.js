'use strict';
// web-plugins.js: the box's plugin marketplaces and plugins from its env file, kept fresh through
// the `claude plugin` CLI (a stub here records the calls and answers like the real one).
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-plugins-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const calls = path.join(tmp, 'calls.log');
const stub = path.join(tmp, 'claude');
fs.writeFileSync(stub, `#!/bin/sh
echo "$*" >> "${calls}"
case "$*" in
  "plugin marketplace add acme/skills --json") printf '%s\\n' '{"outcome":"ok","marketplace":"acme-skills","message":"Successfully added marketplace: acme-skills"}' ;;
  "plugin marketplace add acme/missing --json") printf '%s\\n' '{"outcome":"error","message":"Cloning repository…\\nFailed to clone: repository not found"}'; exit 1 ;;
  "plugin install fresh@acme-skills --json") printf '%s\\n' '{"outcome":"ok","message":"Successfully installed plugin: fresh@acme-skills (scope: user)"}' ;;
  "plugin install old@acme-skills --json") printf '%s\\n' '{"outcome":"ok","message":"Plugin \\"old@acme-skills\\" is already installed (scope: user)"}' ;;
  *) printf '%s\\n' '{"outcome":"ok","message":"ok"}' ;;
esac
`, { mode: 0o755 });
process.env.CB_CLAUDE_BIN = stub;
const p = require('../scripts/web-plugins.js');

test('config: sources and plugin ids from the env file; anything else is reported, not run', () => {
  const c = p.config({ PLUGIN_MARKETPLACES: 'acme/skills, https://git.example.com/m.git  --evil', PLUGINS: 'a@acme-skills,bad id' });
  assert.deepStrictEqual(c.marketplaces, ['acme/skills', 'https://git.example.com/m.git']);
  assert.deepStrictEqual(c.plugins, ['a@acme-skills']);
  assert.deepStrictEqual(c.bad, ['--evil', 'bad', 'id']);
  assert.deepStrictEqual(p.config({}), { marketplaces: [], plugins: [], bad: [] });
  for (const v of ['', ' ', '""', "''"]) assert.deepStrictEqual(p.config({ PLUGIN_MARKETPLACES: v, PLUGINS: v }), { marketplaces: [], plugins: [], bad: [] }, JSON.stringify(v));
  assert.deepStrictEqual(p.config({ PLUGINS: '"a@m b@m"' }).plugins, ['a@m', 'b@m'], 'quotes around the list are not part of it');
});

test('interval: unset or empty is the default hour, 0 is only at start', () => {
  assert.strictEqual(p.interval({}), 60);
  assert.strictEqual(p.interval({ WEB_PLUGINS_SYNC_MIN: '' }), 60);
  assert.strictEqual(p.interval({ WEB_PLUGINS_SYNC_MIN: '""' }), 60);
  assert.strictEqual(p.interval({ WEB_PLUGINS_SYNC_MIN: '15' }), 15);
  assert.strictEqual(p.interval({ WEB_PLUGINS_SYNC_MIN: '0' }), 0);
});

test('start: nothing set, nothing runs', () => {
  assert.strictEqual(p.start({}), false);
  assert.strictEqual(p.start({ PLUGIN_MARKETPLACES: '', PLUGINS: '""', WEB_PLUGINS_SYNC_MIN: '' }), false, 'empty = not set');
  assert.ok(!fs.existsSync(calls));
});

test('sync: add + update each marketplace, install the missing plugins, update the installed ones', async () => {
  const r = await p.sync({ PLUGIN_MARKETPLACES: 'acme/skills acme/missing', PLUGINS: 'fresh@acme-skills old@acme-skills' });
  assert.deepStrictEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), [
    'plugin marketplace add acme/skills --json',
    'plugin marketplace update acme-skills --json',
    'plugin marketplace add acme/missing --json',
    'plugin install fresh@acme-skills --json',
    'plugin install old@acme-skills --json',
    'plugin update old@acme-skills --json',
  ]);
  assert.deepStrictEqual(r.marketplaces, ['acme-skills']);
  assert.deepStrictEqual(r.plugins, ['fresh@acme-skills', 'old@acme-skills']);
  assert.deepStrictEqual(r.errors, ['marketplace acme/missing: Failed to clone: repository not found']);
  assert.strictEqual(p.status(), r);
});
