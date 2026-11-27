'use strict';
// Model providers for the box: Claude (claude.ai sign-in), GLM via z.ai, Abliteration and a custom
// Anthropic-compatible endpoint. Several can be connected at once; every chat session runs with the
// env of the provider its model belongs to, so one chat can use Claude and the next GLM.
//
//   ~/.claude/web-providers.json   {providers: {glm: {key}, abliteration: {key}, custom: {key, base, model}},
//                                   default: "claude/claude-opus-5-5"}            mode 600
//   ~/.claude/web-provider.env     the default provider as shell exports, for console (tmux) sessions,
//                                  read by claude-default (scripts/claude-default.sh)
//
// A model is named "<provider>/<model id>", e.g. "glm/GLM-5.3-Flash".
// Older installs kept one provider in ~/.claude/settings.json env (that applied to every claude
// process, so no per-session choice); it is moved here once. A provider set in .env
// (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN) is shown as connected too.
const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || '/home/node';
const DIR = process.env.WEB_MODELS_DIR || path.join(HOME, '.claude');
const FILE = path.join(DIR, 'web-providers.json');
const ENV_FILE = path.join(DIR, 'web-provider.env');
const SETTINGS = path.join(DIR, 'settings.json');

const PROVIDERS = {
  claude: { label: 'Claude', models: [
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5' }] },
  glm: { label: 'GLM via z.ai', base: 'https://api.z.ai/api/anthropic', models: [{ id: 'GLM-5.3-Flash', label: 'GLM-5.3-Flash' }] },
  abliteration: { label: 'Abliteration', base: 'https://api.abliteration.ai', models: [{ id: 'abliterated-model', label: 'Abliteration' }] },
  custom: { label: 'Custom endpoint', models: [] },
};
const DEFAULT_REF = 'claude/claude-opus-5-5';
const PROVIDER_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'];

function readJ(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } }
function writeJ(f, o, mode) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(t, JSON.stringify(o, null, 2), mode ? { mode } : undefined);
  fs.renameSync(t, f);
}
function detect(base) {
  if (!base) return '';
  if (/z\.ai/.test(base)) return 'glm';
  if (/abliteration/.test(base)) return 'abliteration';
  return 'custom';
}
const store = () => { const o = readJ(FILE, {}) || {}; o.providers = o.providers || {}; return o; };
function save(o) { writeJ(FILE, o, 0o600); writeConsoleEnv(o); }

// one-time move of the single provider kept in settings.json env (older installs)
function migrate() {
  const s = readJ(SETTINGS, null);
  const env = s && s.env;
  if (!env || !env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_AUTH_TOKEN) return;
  const p = detect(env.ANTHROPIC_BASE_URL), o = store();
  if (!o.providers[p]) {
    o.providers[p] = { key: env.ANTHROPIC_AUTH_TOKEN };
    if (p === 'custom') Object.assign(o.providers[p], { base: env.ANTHROPIC_BASE_URL, model: env.ANTHROPIC_DEFAULT_SONNET_MODEL || '' });
  }
  if (!o.default) o.default = p + '/' + (p === 'custom' ? (env.ANTHROPIC_DEFAULT_SONNET_MODEL || '') : PROVIDERS[p].models[0].id);
  PROVIDER_ENV.forEach((k) => delete env[k]);
  save(o); writeJ(SETTINGS, s);
}

// a provider from .env (process env), if any
function fromEnv() {
  const b = process.env.ANTHROPIC_BASE_URL, k = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!b || !k) return null;
  return { id: detect(b), key: k, base: b, model: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || '' };
}
function conf(id) {
  const o = store(), c = o.providers[id], e = fromEnv();
  if (c && c.key) return Object.assign({ from: 'box' }, c);
  if (e && e.id === id) return { key: e.key, base: e.base, model: e.model, from: 'env' };
  return null;
}
function modelsOf(id) {
  if (id !== 'custom') return PROVIDERS[id].models;
  const c = conf('custom');
  return c && c.model ? [{ id: c.model, label: c.model }] : [];
}
function connected(id, claudeAuth) { return id === 'claude' ? claudeAuth !== false : !!conf(id); }

// the default model: picked in Settings, else the provider from .env, else Claude
function defaultRef() {
  const d = store().default; if (d) return d;
  const e = fromEnv(); if (!e) return DEFAULT_REF;
  return e.id + '/' + (e.id === 'custom' ? e.model : PROVIDERS[e.id].models[0].id);
}
// the model a chat should run: the ref if its provider is connected, else the default
function resolve(ref) {
  const pick = (r) => {
    const m = /^([a-z]+)\/(.+)$/.exec(String(r || ''));
    if (!m || !PROVIDERS[m[1]] || !connected(m[1])) return null;
    if (!modelsOf(m[1]).some((x) => x.id === m[2])) return null;
    return { ref: m[1] + '/' + m[2], provider: m[1], model: m[2] };
  };
  return pick(ref) || pick(defaultRef()) || pick(DEFAULT_REF);
}
// the env a claude process runs with for that model
function envFor(sel, base) {
  const e = Object.assign({}, base);
  PROVIDER_ENV.forEach((k) => delete e[k]);
  if (!sel || sel.provider === 'claude') return e;
  const c = conf(sel.provider) || {};
  e.ANTHROPIC_BASE_URL = sel.provider === 'custom' ? c.base : (c.from === 'env' && c.base) || PROVIDERS[sel.provider].base;
  e.ANTHROPIC_AUTH_TOKEN = c.key;
  ['OPUS', 'SONNET', 'HAIKU'].forEach((t) => { e[`ANTHROPIC_DEFAULT_${t}_MODEL`] = sel.model; });
  delete e.CLAUDE_CODE_OAUTH_TOKEN;            // the provider's key, not the Claude subscription
  return e;
}

// console sessions: the default provider as exports (nothing written until a default is picked)
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
function writeConsoleEnv(o) {
  if (!o.default) return;
  const sel = resolve(o.default);
  const lines = ['# written by claude-box (Settings > Models): the default model for console sessions'];
  lines.push('unset ' + PROVIDER_ENV.join(' '));
  if (sel && sel.provider !== 'claude') {
    const e = envFor(sel, {});
    PROVIDER_ENV.forEach((k) => { if (e[k]) lines.push(`export ${k}=${shq(e[k])}`); });
    lines.push('unset CLAUDE_CODE_OAUTH_TOKEN');
  } else if (sel) lines.push(`export ANTHROPIC_MODEL=${shq(sel.model)}`);
  try { fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', { mode: 0o600 }); } catch (_) {}
}

// what Settings and the chat model picker show; keys never leave the box, only their last 4
function list(claudeAuth) {
  const def = resolve(defaultRef());
  return {
    default: def ? def.ref : DEFAULT_REF,
    providers: Object.keys(PROVIDERS).map((id) => {
      const c = id === 'claude' ? null : conf(id);
      return {
        id, label: PROVIDERS[id].label, connected: connected(id, claudeAuth),
        from: c ? c.from : '', keyHint: c && c.key ? String(c.key).slice(-4) : '',
        base: id === 'custom' && c ? c.base : '', models: modelsOf(id),
      };
    }),
  };
}

function setKey(id, key, opts) {
  if (!PROVIDERS[id] || id === 'claude') throw new Error('unknown provider');
  key = String(key || '').trim();
  if (!key || /\s/.test(key) || key.length > 4096) throw new Error('Paste the API key.');
  const o = store(), p = { key };
  if (id === 'custom') {
    const base = String((opts && opts.base) || '').trim(), model = String((opts && opts.model) || '').trim();
    if (!/^https:\/\/[^\s]+$/.test(base)) throw new Error('Base URL: an https:// address.');
    if (!model || /\s/.test(model)) throw new Error('Model name required.');
    Object.assign(p, { base, model });
  }
  o.providers[id] = p;
  save(o);
}
function removeKey(id) {
  const o = store();
  delete o.providers[id];
  if (o.default && o.default.indexOf(id + '/') === 0) o.default = DEFAULT_REF;
  save(o);
}
function setDefault(ref) {
  const sel = resolve(ref);
  if (!sel || sel.ref !== ref) throw new Error('That model is not available.');
  const o = store(); o.default = ref; save(o);
}

try { migrate(); } catch (e) { console.error('models: migrate', e.message); }

module.exports = { PROVIDERS, DEFAULT_REF, list, resolve, envFor, setKey, removeKey, setDefault, detect, migrate };
