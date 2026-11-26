'use strict';
// web-models.js: several providers at once, per-session model refs, the env each one runs with,
// the move out of settings.json and the console env file. Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-models-'));
process.env.WEB_MODELS_DIR = dir;
['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'].forEach((k) => delete process.env[k]);
// an older install: one provider in settings.json env, next to other settings that must stay
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', env: {
  ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'zai-secret-1234',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'GLM-5.3-Flash', KEEP: '1' } }));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const m = require('../scripts/web-models.js');

test('the settings.json provider moves into the store; other settings stay', () => {
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.strictEqual(s.theme, 'dark');
  assert.deepStrictEqual(s.env, { KEEP: '1' });
  const l = m.list(true);
  assert.strictEqual(l.default, 'glm/GLM-5.3-Flash');
  const glm = l.providers.find((p) => p.id === 'glm');
  assert.strictEqual(glm.connected, true);
  assert.strictEqual(glm.keyHint, '1234');
  assert.ok(!JSON.stringify(l).includes('zai-secret'), 'the key itself is never listed');
  assert.strictEqual((fs.statSync(path.join(dir, 'web-providers.json')).mode & 0o777), 0o600);
});

test('each model runs with its own provider env', () => {
  const base = { PATH: '/bin', ANTHROPIC_BASE_URL: 'https://old', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' };
  const c = m.envFor(m.resolve('claude/claude-sonnet-5-5'), base);
  assert.strictEqual(c.ANTHROPIC_BASE_URL, undefined);
  assert.strictEqual(c.CLAUDE_CODE_OAUTH_TOKEN, 'oauth');
  const g = m.envFor(m.resolve('glm/GLM-5.3-Flash'), base);
  assert.strictEqual(g.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.strictEqual(g.ANTHROPIC_AUTH_TOKEN, 'zai-secret-1234');
  assert.strictEqual(g.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'GLM-5.3-Flash');
  assert.strictEqual(g.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.strictEqual(g.PATH, '/bin');
});

test('a model whose provider is not connected falls back to the default', () => {
  assert.strictEqual(m.resolve('abliteration/abliterated-model').ref, 'glm/GLM-5.3-Flash');
  assert.strictEqual(m.resolve('nonsense').ref, 'glm/GLM-5.3-Flash');
  assert.throws(() => m.setDefault('abliteration/abliterated-model'), /not available/);
  m.setKey('abliteration', 'abl-key-9999');
  assert.strictEqual(m.resolve('abliteration/abliterated-model').ref, 'abliteration/abliterated-model');
  assert.throws(() => m.setKey('abliteration', ''), /API key/);
  assert.throws(() => m.setKey('custom', 'k', { base: 'http://plain', model: 'x' }), /https/);
});

test('the default is written for console sessions; removing a provider resets it', () => {
  m.setDefault('glm/GLM-5.3-Flash');
  const env = fs.readFileSync(path.join(dir, 'web-provider.env'), 'utf8');
  assert.match(env, /export ANTHROPIC_BASE_URL='https:\/\/api\.z\.ai\/api\/anthropic'/);
  assert.match(env, /unset CLAUDE_CODE_OAUTH_TOKEN/);
  m.removeKey('glm');
  assert.strictEqual(m.list(true).default, 'claude/claude-opus-5-5');
  const env2 = fs.readFileSync(path.join(dir, 'web-provider.env'), 'utf8');
  assert.ok(!/ANTHROPIC_BASE_URL=/.test(env2));
  assert.match(env2, /export ANTHROPIC_MODEL='claude-opus-5-5'/);
});
