'use strict';
// The session's context strip: the pull requests, Slack threads and Jira issues a session deals with.
//   GET /context?id=<token>  {items: [{kind: 'pr'|'slack'|'jira', key, url, ...facts}]}
// Found in three places:
//   - links anywhere in the session's transcript (what was pasted, what Claude read or printed:
//     `gh pr create` prints the PR's link), read once in full and then only what was appended;
//   - for a task folder (.task.json): its Jira issue, and the PRs of its worktrees' branches (gh);
//   - facts: a PR's state, CI, review and comments from gh (cached for a few minutes); a Jira
//     issue's status and a Slack thread's channel and author from the Today panel's snapshot.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const HOME = process.env.HOME || '/home/node';
const PANEL_FILE = process.env.WEB_PANEL_FILE || path.join(HOME, '.claude', 'web-panel.json');
const PR_TTL = 3 * 60000, BRANCH_TTL = 5 * 60000, MAX_ITEMS = 30;

// ---------- links ----------
const RE = {
  pr: /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g,
  slack: /https:\/\/([\w-]+)\.slack\.com\/archives\/([A-Z0-9]{8,})\/p(\d{16})(\?thread_ts=\d+\.\d+(?:&|\\u0026|&amp;)cid=[A-Z0-9]+)?/g,
  jira: /https:\/\/([\w-]+)\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/g,
};
// every link in a text, in order: one item per PR / Slack message / Jira issue, whatever form it had
function extract(text) {
  const out = [];
  const s = String(text || '');
  let m;
  RE.pr.lastIndex = 0;
  while ((m = RE.pr.exec(s))) {
    const repo = m[2].replace(/\.git$/, '');
    out.push({ kind: 'pr', at: m.index, key: `${m[1]}/${repo}#${m[3]}`, owner: m[1], repo, number: +m[3], url: `https://github.com/${m[1]}/${repo}/pull/${m[3]}` });
  }
  RE.slack.lastIndex = 0;
  while ((m = RE.slack.exec(s))) {
    const q = m[4] ? m[4].replace(/\\u0026|&amp;/g, '&') : '';
    const ts = m[3].slice(0, 10) + '.' + m[3].slice(10);
    out.push({ kind: 'slack', at: m.index, key: `${m[1]}/${m[2]}/${m[3]}`, workspace: m[1], channel: m[2], ts: +ts,
      url: `https://${m[1]}.slack.com/archives/${m[2]}/p${m[3]}${q}` });
  }
  RE.jira.lastIndex = 0;
  while ((m = RE.jira.exec(s))) out.push({ kind: 'jira', at: m.index, key: m[2], site: m[1], url: `https://${m[1]}.atlassian.net/browse/${m[2]}` });
  return out.sort((a, b) => a.at - b.at).map((x) => { delete x.at; return x; });
}

// ---------- the transcript, read incrementally ----------
const SCANS = new Map();           // file -> {size, rest, items: Map(key -> item)}
function scanFile(file) {
  let st; try { st = fs.statSync(file); } catch (_) { return []; }
  let c = SCANS.get(file);
  if (!c || st.size < c.size) { c = { size: 0, rest: '', items: new Map() }; SCANS.set(file, c); }
  if (st.size > c.size) {
    const fd = fs.openSync(file, 'r');
    try {
      const CH = 4 << 20;
      for (let pos = c.size; pos < st.size; pos += CH) {
        const len = Math.min(CH, st.size - pos), buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, pos);
        const text = c.rest + buf.toString('utf8');
        const cut = text.lastIndexOf('\n');
        const whole = cut < 0 ? '' : text.slice(0, cut);
        c.rest = cut < 0 ? text : text.slice(cut + 1);
        for (const it of extract(whole)) if (!c.items.has(it.key)) c.items.set(it.key, it);
      }
    } finally { fs.closeSync(fd); }
    c.size = st.size;
  }
  return [...c.items.values()];
}

// ---------- a task folder: its issue and its branches' PRs ----------
function run(cmd, args, opts) {
  return new Promise((res) => execFile(cmd, args, Object.assign({ timeout: 20000, maxBuffer: 4 << 20 }, opts || {}),
    (e, out) => res(e ? null : String(out || ''))));
}
function taskMeta(cwd) {
  for (let d = cwd; d && d !== '/' && d.length > 1; d = path.dirname(d)) {
    try { return Object.assign({ dir: d }, JSON.parse(fs.readFileSync(path.join(d, '.task.json'), 'utf8'))); } catch (_) {}
  }
  return null;
}
const BRANCH_PRS = new Map();      // task dir -> {at, items, busy}
function branchPRs(dir) {
  let c = BRANCH_PRS.get(dir);
  if (!c) { c = { at: 0, items: [], busy: null }; BRANCH_PRS.set(dir, c); }
  if (!c.busy && Date.now() - c.at > BRANCH_TTL) {
    c.busy = (async () => {
      const found = [];
      let subs = []; try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (_) {}
      for (const e of subs) {
        const repoDir = path.join(dir, e.name);
        if (!fs.existsSync(path.join(repoDir, '.git'))) continue;
        const branch = (await run('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD']) || '').trim();
        const remote = (await run('git', ['-C', repoDir, 'remote', 'get-url', 'origin']) || '').trim();
        const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(remote);
        if (!branch || branch === 'HEAD' || !m) continue;
        const out = await run('gh', ['pr', 'list', '--repo', `${m[1]}/${m[2]}`, '--head', branch, '--state', 'all', '--json', 'url', '--limit', '5']);
        let list = []; try { list = JSON.parse(out || '[]'); } catch (_) {}
        for (const p of list) for (const it of extract(p.url)) found.push(Object.assign(it, { own: true }));
      }
      c.items = found; c.at = Date.now();
    })().catch(() => {}).finally(() => { c.busy = null; });
  }
  return c.items;
}

// ---------- facts ----------
const PR_FACTS = new Map();        // url -> {at, facts, busy}
function ciOf(rollup) {
  const r = Array.isArray(rollup) ? rollup : [];
  if (!r.length) return '';
  const st = r.map((x) => String(x.conclusion || x.state || x.status || '').toUpperCase());
  if (st.some((s) => /FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED/.test(s))) return 'fail';
  if (st.some((s) => /PENDING|QUEUED|IN_PROGRESS|EXPECTED|WAITING/.test(s) || s === '')) return 'pend';
  return 'ok';
}
function prFacts(o) {
  const state = o.state === 'MERGED' ? 'merged' : o.state === 'CLOSED' ? 'closed' : o.isDraft ? 'draft' : 'open';
  const review = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', REVIEW_REQUIRED: 'review' }[o.reviewDecision] || '';
  return { title: String(o.title || '').slice(0, 200), author: (o.author && o.author.login) || '', state, ci: ciOf(o.statusCheckRollup), review, comments: (o.comments || []).length + (o.reviews || []).filter((r) => r && r.body).length,
    labels: (o.labels || []).map((l) => l && l.name).filter(Boolean).slice(0, 3) };
}
function prInfo(url) {
  let c = PR_FACTS.get(url);
  if (!c) { c = { at: 0, facts: null, busy: null }; PR_FACTS.set(url, c); }
  if (!c.busy && Date.now() - c.at > PR_TTL) {
    c.busy = run('gh', ['pr', 'view', url, '--json', 'title,author,state,isDraft,reviewDecision,comments,reviews,labels,statusCheckRollup'])
      .then((out) => { if (out) { try { c.facts = prFacts(JSON.parse(out)); } catch (_) {} } c.at = Date.now(); })
      .finally(() => { c.busy = null; });
  }
  return c.facts;
}
function panel() { try { return (JSON.parse(fs.readFileSync(PANEL_FILE, 'utf8')) || {}).agent || {}; } catch (_) { return {}; } }

// ---------- the strip ----------
function forSession(transcript, cwd) {
  const items = new Map();
  const add = (it) => { if (!items.has(it.key)) items.set(it.key, it); else if (it.own) items.get(it.key).own = true; };
  const meta = cwd ? taskMeta(cwd) : null;
  if (meta) {
    for (const it of extract(meta.url || '')) add(Object.assign(it, { own: true }));
    if (meta.key && !items.has(meta.key) && /^[A-Z][A-Z0-9]+-\d+$/.test(meta.key)) add({ kind: 'jira', key: meta.key, url: meta.url || '', own: true });
    for (const it of branchPRs(meta.dir)) add(it);
  }
  if (transcript) for (const it of scanFile(transcript)) add(Object.assign({}, it));
  const p = panel();
  const out = [...items.values()].slice(0, MAX_ITEMS).map((it) => {
    if (it.kind === 'pr') return Object.assign(it, prInfo(it.url) || {});
    if (it.kind === 'jira') {
      const j = (p.jira || []).find((x) => x && x.key === it.key);
      return Object.assign(it, j ? { status: j.status || '', title: j.title || '', url: it.url || j.url || '' } : {});
    }
    const s = (p.slack || []).find((x) => x && x.url && x.url.includes(it.channel) && x.url.includes(String(it.key.split('/')[2])));
    const sc = s || (p.slack || []).find((x) => x && x.url && x.url.includes('/' + it.channel + '/'));
    return Object.assign(it, sc ? { channelName: sc.channel || '', from: s ? s.from || '' : '' } : {});
  });
  // the session's own first (its branches' PRs, its task's issue), then in the order they came up
  return out.sort((a, b) => (b.own ? 1 : 0) - (a.own ? 1 : 0));
}

module.exports = { extract, scanFile, forSession, ciOf, prFacts };
