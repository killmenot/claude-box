'use strict';
// Host metrics + the current Claude session's context for the launcher / terminal footer bar.
//   metrics()      -> {load, cpu, mem, swap, disk, ctx:null, git:null, spend:null}
//   metrics(token) -> + session context, git branch and token spend from its transcript
// /proc on Linux is NOT namespaced -> these are HOST values (inside the container too).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const registry = require('./web-registry.js');

const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { maxBuffer: 1 << 20 }, (e, out) => res(e ? null : String(out))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };

function cpuSample() {
  const line = readText('/proc/stat').split('\n').find((l) => l.startsWith('cpu ')) || '';
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  return { total: v.reduce((a, b) => a + (b || 0), 0), idle: (v[3] || 0) + (v[4] || 0) };   // idle + iowait
}
function meminfo() {
  const m = {};
  for (const l of readText('/proc/meminfo').split('\n')) { const r = /^(\w+):\s+(\d+)/.exec(l); if (r) m[r[1]] = Number(r[2]) * 1024; }
  return m;
}
const usageTotal = (u, withOutput) => (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) +
  (u.cache_read_input_tokens || 0) + (withOutput ? (u.output_tokens || 0) : 0);

function findTranscript(cid) {
  const root = path.join(process.env.HOME || '/home/node', '.claude', 'projects');
  try {
    for (const d of fs.readdirSync(root)) { const f = path.join(root, d, cid + '.jsonl'); if (fs.existsSync(f)) return f; }
  } catch (_) {}
  return null;
}

// current context-window fill: the last line that carries usage (read only the file's tail)
function contextOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, 256 << 10);
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"usage"')) continue;
      let o; try { o = JSON.parse(lines[i]); } catch (_) { continue; }
      const u = (o.message && o.message.usage) || o.usage;
      if (!u || typeof u !== 'object') continue;
      const max = Number(process.env.CLAUDE_CONTEXT_MAX) || null;
      return { used: usageTotal(u, false), max, model: (o.message && o.message.model) || o.model || null };
    }
  } catch (_) {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
  return null;
}

// session spend: billed tokens across the WHOLE transcript. Re-reading it on every footer poll
// churned megabytes of garbage on an actively growing session (GC stalls = UI hiccups), so the
// scan is incremental: each file keeps its consumed size, only new lines are parsed. The map is
// capped — LRU by insertion, one entry per polled session, at most a few hundred bytes each.
const SPEND = new Map();
const SPEND_MAX = 32;
function spendOf(file) {
  let st; try { st = fs.statSync(file); } catch (_) { return null; }
  let c = SPEND.get(file);
  if (!c || st.size < (c.size || 0)) { c = { size: 0, sum: 0, at: 0 }; SPEND.set(file, c); }
  SPEND.delete(file); SPEND.set(file, c);                                    // refresh LRU order
  while (SPEND.size > SPEND_MAX) SPEND.delete(SPEND.keys().next().value);
  if (st.size > c.size || !c.at || Date.now() - c.at > 60000) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - c.size); fs.readSync(fd, buf, 0, buf.length, c.size);
      const text = buf.toString('utf8');
      const cut = text.lastIndexOf('\n');                                     // only complete lines
      if (cut >= 0) {
        for (const l of text.slice(0, cut).split('\n')) {
          if (!l.includes('"usage"')) continue;
          try { const o = JSON.parse(l); if (o.message && o.message.usage) c.sum += usageTotal(o.message.usage, true); } catch (_) {}
        }
        c.size += cut + 1;
      }
    } finally { fs.closeSync(fd); }
  }
  c.at = Date.now();
  return c.sum;
}

async function gitOf(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  // safe.directory='*': the workspace volume is owned by another uid
  const b = (await run('git', ['-C', cwd, '-c', 'safe.directory=*', 'rev-parse', '--abbrev-ref', 'HEAD']) || '').trim();
  if (!b) return null;
  const st = await run('git', ['-C', cwd, '-c', 'safe.directory=*', 'status', '--porcelain']);
  return { branch: b, dirty: !!(st && st.trim()) };
}

async function metrics(token) {
  const c1 = cpuSample(); await sleep(200); const c2 = cpuSample();
  const dt = c2.total - c1.total, di = c2.idle - c1.idle;
  const mem = meminfo();
  const dpath = process.env.METRICS_DISK_PATH || '/workspace';
  let disk = { free: 0, total: 0, path: dpath };
  try { const s = fs.statfsSync(dpath); disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize, path: dpath }; } catch (_) {}
  const out = {
    load: Number(readText('/proc/loadavg').split(' ')[0]) || 0,
    cpu: dt > 0 ? Math.round(100 * (dt - di) / dt) : 0,
    mem: { used: (mem.MemTotal || 0) - (mem.MemAvailable || 0), total: mem.MemTotal || 0 },
    swap: { used: (mem.SwapTotal || 0) - (mem.SwapFree || 0), total: mem.SwapTotal || 0 },
    disk, ctx: null, git: null, spend: null,
  };
  const rec = token ? registry.get(token) : null;
  if (rec) {
    out.git = await gitOf(rec.cwd);
    const f = rec.claudeSessionId && findTranscript(rec.claudeSessionId);
    if (f) { out.ctx = contextOf(f); out.spend = spendOf(f); }
  }
  return out;
}

module.exports = { metrics };
