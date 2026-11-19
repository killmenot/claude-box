#!/usr/bin/env node
'use strict';
// cb-session — start and poll claude-box chat sessions from a shell (for agents that hand work
// out to separate sessions, e.g. one code review per pull request). The sessions are ordinary
// chat sessions: they show up in the sidebar and can be opened and continued like any other.
//
//   cb-session new --cwd DIR --prompt TEXT [--title T] [--mode auto|default|acceptEdits|plan] [--category NAME]
//   cb-session status TOKEN      -> JSON: state (running|requires_action|idle|stopped…), last answer, cost
//
// Talks to the local sidecar (http://127.0.0.1:$WEB_TERMINAL_PORT) with the per-start API token
// that web-serve.js writes to ~/.claude/.cb-api-token (the web password is not in the sessions'
// environment). Outside the box, WEB_TERMINAL_PASSWORD from the env still works.
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = parseInt(process.env.WEB_TERMINAL_PORT || '7681', 10);
let apiToken = '';
try { apiToken = fs.readFileSync(path.join(process.env.HOME || '/home/node', '.claude', '.cb-api-token'), 'utf8').trim(); } catch (_) {}
const auth = !apiToken && process.env.WEB_TERMINAL_PASSWORD
  ? 'Basic ' + Buffer.from((process.env.WEB_TERMINAL_USER || 'claude') + ':' + process.env.WEB_TERMINAL_PASSWORD).toString('base64')
  : null;

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json' };
    if (apiToken) headers['x-cb-api-token'] = apiToken;
    else if (auth) headers.authorization = auth;
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
      let out = ''; res.on('data', (d) => { out += d; });
      res.on('end', () => {
        let o; try { o = JSON.parse(out); } catch (_) { reject(new Error(`HTTP ${res.statusCode}: ${out.slice(0, 200)}`)); return; }
        if (!o.ok) reject(new Error(o.error || `HTTP ${res.statusCode}`)); else resolve(o);
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

function usage() {
  console.error('usage: cb-session new --cwd DIR --prompt TEXT [--title T] [--mode M] [--category NAME]\n       cb-session status TOKEN');
  process.exit(2);
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'new') {
    const o = {};
    for (let i = 0; i < rest.length; i += 2) {
      const k = rest[i], v = rest[i + 1];
      if (!/^--(cwd|prompt|title|mode|category)$/.test(k) || v === undefined) usage();
      o[k.slice(2)] = v;
    }
    if (!o.cwd || !o.prompt) usage();
    if (o.prompt === '-') o.prompt = require('fs').readFileSync(0, 'utf8');
    o.cwd = require('path').resolve(o.cwd);
    const r = await call('POST', '/chat/api/new', o);
    delete r.ok; console.log(JSON.stringify(r));
  } else if (cmd === 'status' && rest[0]) {
    const r = await call('GET', '/chat/api/status?token=' + encodeURIComponent(rest[0]));
    delete r.ok; console.log(JSON.stringify(r, null, 1));
  } else usage();
})().catch((e) => { console.error('cb-session: ' + e.message); process.exit(1); });
