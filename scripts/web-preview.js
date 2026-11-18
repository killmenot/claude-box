'use strict';
// Screenshot of a session's tmux pane for the launcher preview: {ansi, live, ts}.
// Live session -> tmux capture-pane -ep (and the FULL frame is cached to disk, so it survives a
// restart). Dead -> the last cached frame (live:false, ts = cache mtime). No cache -> ansi:"".
// full=false -> last 12 lines (thumbnail); full=true -> the whole visible screen.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const registry = require('./web-registry.js');

// Optional isolated tmux socket (CLAUDE_TMUX_L=name): tests never touch the user's live sessions.
const tmuxArgs = (a) => (process.env.CLAUDE_TMUX_L ? ['-L', process.env.CLAUDE_TMUX_L] : []).concat(a);
const tmux = (a) => new Promise((res) => execFile('tmux', tmuxArgs(a), { maxBuffer: 4 << 20 }, (e, out) => res(e ? null : String(out))));

async function preview(token, full) {
  const empty = { ansi: '', live: false, ts: 0 };
  if (!token) return empty;
  const dir = path.join(process.env.HOME || '/home/node', '.claude', 'web-previews');
  const cache = path.join(dir, path.basename(token) + '.ansi');
  const rec = registry.get(token);
  let cap = null, live = false, ts = 0;
  if (rec && rec.tmuxSession && (await tmux(['has-session', '-t', '=' + rec.tmuxSession])) !== null) {
    cap = await tmux(['capture-pane', '-ep', '-t', '=' + rec.tmuxSession + ':']);
    if (cap !== null) {
      cap = cap.replace(/\n+$/, '');
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(cache, cap); } catch (_) {}
      live = true; ts = Math.floor(Date.now() / 1000);
    }
  }
  if (cap === null) {
    try { cap = fs.readFileSync(cache, 'utf8'); ts = Math.floor(fs.statSync(cache).mtimeMs / 1000); }
    catch (_) { return empty; }
  }
  if (!full && cap) cap = cap.split('\n').slice(-12).join('\n');
  return { ansi: cap, live, ts };
}

module.exports = { preview };
