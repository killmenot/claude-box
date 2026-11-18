'use strict';
// Search through session history for the launcher.
//   search(query, scope) -> [{sessionId, timestamp, type, snippet, token, name}], newest first
// scope 'prompts' (default) looks at the user's own messages, 'all' adds Claude's replies.
// The query is a LITERAL, case-insensitive (unicode-aware) string. Only sessions present in the
// registry are returned: the launcher needs a token to open a result.
//
// Performance: ripgrep emits only the MATCHING LINES (not whole files), a cheap substring check
// drops lines of the wrong event type, and only what is left gets JSON-parsed. Without rg the
// files are scanned here line by line (slower, same result).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const registry = require('./web-registry.js');

const LIMIT = () => { const n = parseInt(process.env.CLAUDE_WEB_SEARCH_LIMIT || '100', 10); return n > 0 ? n : 100; };
const projectsDir = () => process.env.CLAUDE_PROJECTS_DIR || path.join(process.env.HOME || '/home/node', '.claude', 'projects');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// -> Promise<[{file, line}]> of lines that contain the query (case-insensitive), or null if rg is missing
function rgLines(q, dir) {
  return new Promise((res) => {
    execFile('rg', ['--null', '-i', '-F', '--no-heading', '--with-filename', '--glob', '*.jsonl', '--', q, dir],
      { maxBuffer: 256 << 20, timeout: 20000 }, (e, out) => {
        if (e && e.code === 'ENOENT') return res(null);
        const rows = [];
        for (const l of String(out || '').split('\n')) {
          const z = l.indexOf('\0');
          if (z > 0) rows.push({ file: l.slice(0, z), line: l.slice(z + 1) });
        }
        res(rows);
      });
  });
}
function scanLines(re, dir) {
  const rows = [];
  let subs = [];
  try { subs = fs.readdirSync(dir); } catch (_) { return rows; }
  for (const d of subs) {
    let files = [];
    try { files = fs.readdirSync(path.join(dir, d)).filter((f) => f.endsWith('.jsonl')); } catch (_) { continue; }
    for (const f of files) {
      const file = path.join(dir, d, f);
      let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
      for (const line of text.split('\n')) if (re.test(line)) rows.push({ file, line });
    }
  }
  return rows;
}

function textOf(o) {
  const c = o.message && o.message.content;
  const parts = typeof c === 'string' ? [c]
    : Array.isArray(c) ? c.filter((p) => p && p.type === 'text').map((p) => p.text || '') : [];
  return parts.join(' ').replace(/[\r\n\t]+/g, ' ');
}

async function search(query, scope) {
  const q = String(query || '');
  scope = scope === 'all' ? 'all' : 'prompts';
  const dir = projectsDir();
  if (!q || !fs.existsSync(dir)) return [];
  const re = new RegExp(escapeRe(q), 'iu');
  const byCid = new Map(registry.list().map((r) => [r.claudeSessionId, r]));
  const types = scope === 'all' ? ['"type":"user"', '"type":"assistant"'] : ['"type":"user"'];
  const lines = (await rgLines(q, dir)) || scanLines(re, dir);
  const hits = [];
  for (const { file, line } of lines) {
    if (!types.some((t) => line.includes(t))) continue;                  // cheap prefilter, no parsing
    const sessionId = path.basename(file, '.jsonl');
    const rec = byCid.get(sessionId);
    if (!rec) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    if (o.type !== 'user' && !(scope === 'all' && o.type === 'assistant')) continue;
    const flat = textOf(o);
    const m = re.exec(flat);
    if (!m) continue;                                                    // matched only in tool output / metadata
    // snippet: a window of ±100 codepoints around the first match
    const cps = Array.from(flat), at = Array.from(flat.slice(0, m.index)).length, len = Array.from(m[0]).length;
    const st = Math.max(0, at - 100), en = at + len + 100;
    hits.push({
      sessionId, timestamp: o.timestamp || '', type: o.type,
      snippet: (st > 0 ? '…' : '') + cps.slice(st, en).join('') + (en < cps.length ? '…' : ''),
      token: rec.token, name: rec.name,
    });
  }
  hits.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return hits.slice(0, LIMIT());
}

module.exports = { search };
