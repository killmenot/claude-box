'use strict';
// Plugin marketplaces and plugins of the box, from its env file (off unless set):
//   PLUGIN_MARKETPLACES  sources, space- or comma-separated: owner/repo (GitHub), a git URL, or a
//                        path inside the box. A private GitHub repo clones with the box's gh sign-in.
//   PLUGINS              plugin@marketplace ids to install and keep enabled.
//   WEB_PLUGINS_SYNC_MIN minutes between syncs while the box runs (default 60, 0 = only at start).
// An empty value (VAR=, VAR="") counts as not set.
// A sync is what `/plugin marketplace update <name>` does by hand, for every listed marketplace:
// add it if missing, pull it, install the listed plugins that are missing, update the others.
// Everything goes through the `claude plugin` CLI (user scope, ~/.claude), so the result is the same
// as doing it in a console. New sessions get the fresh plugins; a session that is already open
// picks them up with /reload-plugins. Marketplace-declared install commands are never accepted
// here (no -y): such a plugin is left for a person to install from a console.
const { execFile } = require('child_process');

const log = (...a) => console.log('claude-box plugins:', ...a);
const warn = (...a) => console.error('claude-box plugins:', ...a);

const SOURCE = /^(?:[\w.-]+\/[\w.-]+|https:\/\/[^\s"'`]+|git@[^\s"'`]+|ssh:\/\/[^\s"'`]+|\/[^\s"'`]+)$/;
const PLUGIN = /^[\w.-]+@[\w.-]+$/;

// the value without surrounding quotes; empty (or only quotes / blanks) -> ''
function val(v) { return String(v == null ? '' : v).trim().replace(/^(['"])(.*)\1$/, '$2').trim(); }
function split(v) { return val(v).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean); }
// -> {marketplaces: [source], plugins: [id], bad: [entry]} (a bad entry is reported, not run)
function config(env) {
  const e = env || process.env, bad = [];
  const marketplaces = split(e.PLUGIN_MARKETPLACES).filter((s) => (SOURCE.test(s) ? true : (bad.push(s), false)));
  const plugins = split(e.PLUGINS).filter((s) => (PLUGIN.test(s) ? true : (bad.push(s), false)));
  return { marketplaces, plugins, bad };
}

// `claude plugin ... --json`: the last line is the machine-readable result
function claude(args, timeout) {
  return new Promise((res) => execFile(process.env.CB_CLAUDE_BIN || 'claude', ['plugin', ...args, '--json'],
    { timeout: timeout || 180000, maxBuffer: 4 << 20 }, (err, out, errOut) => {
      const lines = String(out || '').trim().split('\n');
      let r = null; try { r = JSON.parse(lines[lines.length - 1]); } catch (_) {}
      const ok = !err && (!r || r.outcome === undefined || r.outcome === 'ok');
      res({ ok, r: r || {}, msg: (r && r.message) || String(errOut || out || (err && err.message) || '').trim() });
    }));
}

let running = null, last = null;
async function sync(env) {
  if (running) return running;
  running = (async () => {
    const c = config(env), done = { at: Date.now(), marketplaces: [], plugins: [], errors: [] };
    for (const b of c.bad) done.errors.push(`not a marketplace source or plugin@marketplace id: ${b}`);
    for (const src of c.marketplaces) {
      const add = await claude(['marketplace', 'add', src]);
      const name = add.r.marketplace;
      if (!add.ok || !name) { done.errors.push(`marketplace ${src}: ${add.msg.split('\n').pop()}`); continue; }
      const up = await claude(['marketplace', 'update', name]);
      if (!up.ok) done.errors.push(`marketplace ${name}: ${up.msg.split('\n').pop()}`);
      done.marketplaces.push(name);
    }
    for (const id of c.plugins) {
      const inst = await claude(['install', id]);
      if (!inst.ok) { done.errors.push(`${id}: ${inst.msg.split('\n').pop()}`); continue; }
      if (/already installed/i.test(inst.msg)) {
        const up = await claude(['update', id]);
        if (!up.ok) done.errors.push(`${id}: ${up.msg.split('\n').pop()}`);
      }
      done.plugins.push(id);
    }
    if (done.marketplaces.length || done.plugins.length) log('synced', [...done.marketplaces, ...done.plugins].join(', '));
    for (const e of done.errors) warn(e);
    last = done;
    return done;
  })();
  try { return await running; } finally { running = null; }
}

// minutes between syncs: unset or empty -> 60; 0 (or not a number) -> only at start
function interval(env) { const r = val((env || process.env).WEB_PLUGINS_SYNC_MIN); return r === '' ? 60 : parseFloat(r); }

let timer = null;
// at start (in the background: the web UI does not wait for git) and every WEB_PLUGINS_SYNC_MIN
function start(env) {
  const e = env || process.env, c = config(e);
  if (!c.marketplaces.length && !c.plugins.length && !c.bad.length) return false;
  sync(e).catch((err) => warn(err.message));
  const min = interval(e);
  if (min > 0 && !timer) { timer = setInterval(() => sync(e).catch((err) => warn(err.message)), min * 60000); timer.unref(); }
  return true;
}

module.exports = { config, interval, sync, start, status: () => last };
