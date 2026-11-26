#!/usr/bin/env node
'use strict';
// The box's own MCP server (stdio, no dependencies), registered as "claude-box" in
// claude-defaults/mcp.json. Tools:
//   show_artifact {path, title}  show an HTML page Claude wrote in the web UI's artifact panel.
//     The file is copied to a snapshot (so an earlier version stays viewable after the file is
//     rewritten); the launcher sees the call in the chat stream and opens the panel.
// Snapshots: ~/.claude/web-artifacts/<16 hex of the path's sha1>/<epoch ms>-<6 hex>.<ext>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.HOME || '/home/node';
const SNAP_DIR = process.env.CB_ARTIFACT_DIR || path.join(HOME, '.claude', 'web-artifacts');
const ROOTS = (process.env.CB_ARTIFACT_ROOTS || '/workspace:' + HOME).split(':').filter(Boolean);
const EXTS = new Set(['.html', '.htm', '.svg', '.md']);
const MAX = 8 << 20;

const TOOLS = [{
  name: 'show_artifact',
  description: 'Show an HTML page you wrote (a design, mockup, prototype, chart, diagram or report) to the user ' +
    'in the artifact panel next to the chat. Write ONE self-contained file first (inline CSS and JS, images as ' +
    'data: URIs; scripts from public CDNs are fine), usually in .artifacts/ of the session folder. Call again after ' +
    'each change: every call is a new version the user can switch between. .svg and .md files work too.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path of the file (or relative to the session folder).' },
      title: { type: 'string', description: 'A short name for what it shows, e.g. "Pricing page".' },
    },
    required: ['path'],
  },
}];

function under(p, roots) { return roots.some((r) => p === r || p.startsWith(r.replace(/\/+$/, '') + '/')); }

function showArtifact(args, cwd) {
  const raw = String((args && args.path) || '').trim();
  if (!raw) throw new Error('path is required');
  const abs = path.resolve(cwd || process.cwd(), raw);
  let real; try { real = fs.realpathSync(abs); } catch (_) { throw new Error('file not found: ' + abs); }
  if (!under(real, ROOTS)) throw new Error('the file must be under ' + ROOTS.join(' or '));
  const ext = path.extname(real).toLowerCase();
  if (!EXTS.has(ext)) throw new Error('show_artifact shows .html, .svg or .md files');
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('not a file: ' + real);
  if (st.size > MAX) throw new Error('the file is over 8 MB');
  const dir = path.join(SNAP_DIR, crypto.createHash('sha1').update(real).digest('hex').slice(0, 16));
  fs.mkdirSync(dir, { recursive: true });
  const snap = path.join(dir, Date.now() + '-' + crypto.randomBytes(3).toString('hex') + ext);
  fs.writeFileSync(snap, fs.readFileSync(real), { flag: 'wx' });   // never over an earlier version
  const title = String((args && args.title) || path.basename(real)).replace(/\s+/g, ' ').trim().slice(0, 120);
  return { title, path: real, snapshot: snap };
}

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function fail(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

function handle(msg) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    reply(id, { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'claude-box', version: '1.0.0' } });
  } else if (method === 'tools/list') reply(id, { tools: TOOLS });
  else if (method === 'tools/call') {
    const name = params && params.name;
    if (name !== 'show_artifact') { fail(id, -32602, 'unknown tool: ' + name); return; }
    try {
      const r = showArtifact(params.arguments, process.cwd());
      // the launcher reads the JSON line; the sentence is for the model
      reply(id, { content: [{ type: 'text', text: 'Shown in the artifact panel: ' + r.title + '\n' + JSON.stringify(r) }] });
    } catch (e) {
      reply(id, { content: [{ type: 'text', text: 'Not shown: ' + e.message }], isError: true });
    }
  } else if (method === 'ping') reply(id, {});
  else if (id !== undefined && id !== null) fail(id, -32601, 'method not found: ' + method);
  // notifications (no id) need no answer
}

if (require.main === module) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (_) { continue; }
      try { handle(m); } catch (e) { if (m && m.id != null) fail(m.id, -32603, e.message); }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

module.exports = { showArtifact, handle, TOOLS, SNAP_DIR };
