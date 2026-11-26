'use strict';
// The launcher's right-hand "Today" panel. Two sources:
//   github — straight from `gh` (GraphQL): PRs waiting for my review, and my own open PRs with
//            CI state, review decision and comment counts. Cheap, refreshed every minute.
//   agent  — calendar, Jira and Slack come through Claude's MCP connectors, which only a Claude
//            session can reach: a short read-only run on a cheap model collects them as JSON and
//            also picks the 3–5 items that need me ("needs"). It runs every WEB_PANEL_MINUTES
//            while someone has looked at the panel recently, and on demand (↻).
// Served by web-sidecar.js at GET /panel and POST /panel/refresh.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const HOME = process.env.HOME || '/home/node';
const WS_ROOT = process.env.WORKSPACE_DIR || '/workspace';
const FILE = process.env.WEB_PANEL_FILE || path.join(HOME, '.claude', 'web-panel.json');
const MODEL = process.env.WEB_PANEL_MODEL || 'claude-haiku-5-5';
const EVERY_MIN = parseFloat(process.env.WEB_PANEL_MINUTES || '15');
const SETTINGS_FILE = process.env.WEB_PANEL_SETTINGS || path.join(HOME, '.claude', 'web-panel-settings.json');
// the agent interval is picked in the panel (0 = only on ↻); WEB_PANEL_MINUTES is the default
function everyMin() {
  try { const v = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).every; if (typeof v === 'number' && v >= 0) return v; } catch (_) {}
  return EVERY_MIN;
}
function setEvery(v) {
  v = Number(v); if (!(v >= 0 && v <= 240)) throw new Error('every: 0..240 minutes');
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ every: v }));
  return { every: v };
}
const ENABLED = process.env.WEB_PANEL !== '0';
const REVIEWS_DIR = process.env.WEB_PANEL_REVIEWS || path.join(WS_ROOT, 'reviews');
const IDLE_STOP_MS = 2 * 3600e3;          // no agent runs when nobody has opened the panel for 2h
const HIDDEN_FILE = process.env.WEB_PANEL_HIDDEN || path.join(HOME, '.claude', 'web-panel-hidden.json');
const HIDDEN_DAYS = 60;

function log(...a) { console.error('[panel]', ...a); }
let getSdk = async () => null;
let wireMod = null;   // web-wire.js: records this agent's model traffic
function init(o) { if (o && o.getSdk) getSdk = o.getSdk; if (o && o.wire) wireMod = o.wire; }

// ---------------------------------------------------------------- GitHub (direct)
// team review requests count only in repos I work in: where I opened or reviewed a PR lately
const ACTIVE_DAYS = 90;
const gql = (since) => `query {
  viewer { login pullRequests(first: 40, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes {
    number title url isDraft updatedAt reviewDecision repository { nameWithOwner }
    comments { totalCount } reviews(last: 1) { nodes { author { login } submittedAt state } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } }
  direct: search(query: "is:pr is:open user-review-requested:@me archived:false -is:draft", type: ISSUE, first: 40) { ...prs }
  team: search(query: "is:pr is:open review-requested:@me archived:false -is:draft", type: ISSUE, first: 100) { ...prs }
  authored: search(query: "is:pr author:@me updated:>=${since}", type: ISSUE, first: 100) { ...repos }
  reviewed: search(query: "is:pr reviewed-by:@me updated:>=${since}", type: ISSUE, first: 100) { ...repos }
}
fragment repos on SearchResultItemConnection { nodes { ... on PullRequest { repository { nameWithOwner } } } }
fragment prs on SearchResultItemConnection { nodes { ... on PullRequest {
  number title url isDraft updatedAt author { login } repository { nameWithOwner } } } }`;
let gh = { at: 0, data: null, error: null, busy: null };
function ghRun() {
  if (gh.busy) return gh.busy;
  gh.busy = new Promise((resolve) => {
    const since = new Date(Date.now() - ACTIVE_DAYS * 86400000).toISOString().slice(0, 10);
    execFile('gh', ['api', 'graphql', '-f', 'query=' + gql(since)], { maxBuffer: 8 << 20, timeout: 30000 }, (e, out, err) => {
      gh.busy = null; gh.at = Date.now();
      if (e) { gh.error = String(err || e.message).trim().slice(0, 300); resolve(); return; }
      try {
        const d = JSON.parse(out).data, me = d.viewer.login;
        const reviewState = reviewerState();
        const pr = (p) => ({ repo: p.repository.nameWithOwner, number: p.number, title: p.title, url: p.url,
          updated: p.updatedAt, author: p.author && p.author.login, bot: reviewState(p.repository.nameWithOwner, p.number) });
        // a repo is mine with an open PR of mine, or at least 2 PRs I opened or reviewed lately
        const hits = {};
        for (const p of d.authored.nodes.concat(d.reviewed.nodes)) if (p && p.repository) hits[p.repository.nameWithOwner] = (hits[p.repository.nameWithOwner] || 0) + 1;
        const active = new Set(Object.keys(hits).filter((r) => hits[r] >= 2)
          .concat(d.viewer.pullRequests.nodes.map((p) => p.repository.nameWithOwner)));
        gh.data = {
          login: me, activeRepos: [...active].sort(),
          // review requested from me personally; "team" = only through a team I am in
          review: d.direct.nodes.filter((p) => p && p.number).map(pr),
          team: d.team.nodes.filter((p) => p && p.number && active.has(p.repository.nameWithOwner)
            && !d.direct.nodes.some((x) => x && x.url === p.url)).map(pr),
          mine: d.viewer.pullRequests.nodes.map((p) => {
            const roll = p.commits.nodes[0] && p.commits.nodes[0].commit.statusCheckRollup;
            const last = p.reviews.nodes[0];
            return { repo: p.repository.nameWithOwner, number: p.number, title: p.title, url: p.url, draft: p.isDraft,
              updated: p.updatedAt, ci: roll ? roll.state : null, decision: p.reviewDecision, comments: p.comments.totalCount,
              lastReview: last && last.author && last.author.login !== me ? { by: last.author.login, state: last.state, at: last.submittedAt } : null };
          }),
        };
        gh.error = null;
      } catch (x) { gh.error = 'unexpected gh output: ' + x.message; }
      resolve();
    });
  });
  return gh.busy;
}
// status of our own PR reviewer, if it covers that repo: the pr-watch skill run in the reviews folder
// (reviews/.pr-watch/state.json, keyed "owner/repo#n"), or the older single-repo reviewer
// (reviews/config.json + reviews/state.json, keyed by number)
function reviewerState() {
  let cfg = null, st = null, watch = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(REVIEWS_DIR, 'config.json'), 'utf8')); } catch (_) {}
  try { st = JSON.parse(fs.readFileSync(path.join(REVIEWS_DIR, 'state.json'), 'utf8')); } catch (_) {}
  try { watch = JSON.parse(fs.readFileSync(path.join(REVIEWS_DIR, '.pr-watch', 'state.json'), 'utf8')); } catch (_) {}
  return (repo, n) => {
    const w = watch && (watch.prs || {})[repo + '#' + n];
    if (w && w.status !== 'baseline') {
      return { status: w.approved ? 'approved' : w.status, findings: Array.isArray(w.findings) ? w.findings.length : 0,
        action: w.last_post && w.last_post.action, url: w.last_post && w.last_post.url };
    }
    if (!cfg || !st || cfg.repo !== repo) return null;
    const s = (st.prs || {})[String(n)]; if (!s) return null;
    return { status: s.status, findings: Array.isArray(s.findings) ? s.findings.length : 0,
      action: s.last_post && s.last_post.action, url: s.last_post && s.last_post.url };
  };
}

// ---------------------------------------------------------------- agent snapshot (MCP)
const SCHEMA = {
  type: 'object', required: ['calendar', 'jira', 'slack', 'gmail', 'needs'],
  properties: {
    calendar: { type: 'array', items: { type: 'object', required: ['title', 'start'], properties: {
      title: { type: 'string' }, start: { type: 'string', description: 'ISO 8601 with offset' }, end: { type: 'string' },
      allDay: { type: 'boolean' }, url: { type: 'string', description: 'video call link if any, else the event link' },
      declined: { type: 'boolean' } } } },
    jira: { type: 'array', items: { type: 'object', required: ['key', 'title'], properties: {
      key: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' }, priority: { type: 'string' },
      url: { type: 'string' }, updated: { type: 'string' } } } },
    slack: { type: 'array', items: { type: 'object', required: ['text'], properties: {
      kind: { type: 'string', enum: ['mention', 'thread', 'dm'] }, channel: { type: 'string' }, from: { type: 'string' },
      text: { type: 'string', description: 'one line, at most 200 characters' }, url: { type: 'string' }, at: { type: 'string' } } } },
    gmail: { type: 'array', items: { type: 'object', required: ['subject'], properties: {
      from: { type: 'string' }, subject: { type: 'string' }, snippet: { type: 'string', description: 'at most 120 characters' },
      url: { type: 'string', description: 'https://mail.google.com/mail/u/0/#inbox/<thread id>' }, at: { type: 'string' } } } },
    needs: { type: 'array', maxItems: 5, items: { type: 'object', required: ['title', 'source'], properties: {
      source: { type: 'string', enum: ['calendar', 'jira', 'slack', 'gmail', 'github'] }, title: { type: 'string' },
      why: { type: 'string', description: 'what exactly I have to do, a few words' }, url: { type: 'string' },
      ref: { type: 'string', description: 'Jira key / PR repo#number / Slack channel' } } } },
  },
};
function agentPrompt(ghData) {
  const now = new Date();
  const gh = ghData ? JSON.stringify({ review_requested_from_me: ghData.review.map((p) => ({ ref: p.repo + '#' + p.number, title: p.title, url: p.url, author: p.author })),
    my_prs: ghData.mine.map((p) => ({ ref: p.repo + '#' + p.number, title: p.title, url: p.url, ci: p.ci, decision: p.decision, lastReview: p.lastReview })) }) : 'unavailable';
  return `Collect my work dashboard for today. Now is ${now.toISOString()}. Use ONLY read/search tools; never send, create or change anything.

1. calendar: my Google Calendar events from now (including the ones already in progress) until the end of my working day today (if the day is almost over, include tomorrow morning). Skip events I declined and "Out of office"/working-location blocks. Times as ISO 8601 with offset. url: the video call link if there is one.
2. jira: Jira issues assigned to me that are in work: not done and not in the backlog (JQL: assignee = currentUser() AND statusCategory != Done AND status not in (Backlog)), most recently updated first, at most 15. url: the browse link.
3. slack: what needs my attention in Slack from the last 24 hours: messages that mention me, new replies in threads I took part in, direct messages to me. At most 10, newest first, each with its permalink; text is a one-line summary.
4. gmail: unread emails from the last 48 hours in my inbox that a person wrote to me and that may need a reply or action. Leave out newsletters, notifications and automated mail (GitHub, Jira, Slack, calendar, CI, marketing). At most 8, newest first. url: https://mail.google.com/mail/u/0/#inbox/<thread id>.
5. needs: the 3–5 items across ALL sources (including the GitHub data below) where I personally have to act soon: a question to me, a review requested from me, my PR with failing CI or changes requested, a meeting starting within the next hour, a blocking Jira issue. Most urgent first. Leave out anything that only informs.

GitHub (already collected, use it only for "needs"): ${gh}

If a source is not available, return an empty list for it. Answer with the structured output only.`;
}
// An MCP tool the read-only run may call: mcp__<server>__<tool>, where <server> has no "__" in it
// and <tool> starts with a read verb and has no write verb anywhere in its name.
const READ_TOOL = /^mcp__(?:[^_]|_(?!_))+__(?:slack_)?(?:list|search|get|read|fetch|query|lookup|atlassianUserInfo)(?:[A-Za-z0-9-]|_(?!_))*$/i;
const WRITE_WORD = /send|create|update|delete|remove|post|put|patch|add|set|write|edit|move|share|upload|reply|draft|comment|transition|archive|mark|react|invite|schedule|cancel|join|leave|pin|publish|approve|merge|assign|label|close|open|submit|forward|trash|modify/i;
function isReadTool(name) {
  const n = String(name || '');
  if (!READ_TOOL.test(n)) return false;
  return !WRITE_WORD.test(n.slice(n.lastIndexOf('__') + 2).replace(/^(?:slack_)?(?:list|search|get|read|fetch|query|lookup)/i, ''));
}
let agent = { running: null, lastRun: 0, lastView: 0, error: null };
const SOURCES = ['calendar', 'jira', 'slack', 'gmail'];
const KEEP_MS = 3 * 3600 * 1000; // how long a silent source may show its last good items
function sourceOf(tool) {
  const n = String(tool || '');
  if (!n.startsWith('mcp__')) return null;
  return /calendar/i.test(n) ? 'calendar' : /atlassian|jira/i.test(n) ? 'jira' : /slack/i.test(n) ? 'slack' : /gmail/i.test(n) ? 'gmail' : null;
}
// Polls the run's MCP servers until the ones the panel reads are no longer "pending" (max CONNECT_MS).
// Returns a short "name status" summary for the log.
const CONNECT_MS = 45000;
async function waitConnectors(q) {
  const t0 = Date.now(); let last = [];
  while (Date.now() - t0 < CONNECT_MS) {
    try { last = (await q.mcpServerStatus()).filter((x) => sourceOf('mcp__' + x.name + '__')); } catch (_) { return null; }
    // the claude.ai connectors are added to the list some seconds after start: wait for them too
    if (last.some((x) => /^claude\.ai /.test(x.name)) && !last.some((x) => x.status === 'pending')) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const list = last.map((x) => ({ name: x.name, status: x.status, error: x.error || undefined }));
  return { list, text: list.map((x) => x.name.replace(/^claude\.ai /, '') + ' ' + x.status).join(', ') + ' (' + Math.round((Date.now() - t0) / 1000) + 's)' };
}

// ---------------------------------------------------------------- run log
// Every agent run is recorded (what it waited for, each tool call and its answer, the result) in
// RUNS_DIR, newest RUNS_KEEP kept, so the panel can show what its agent did. The current run is live.
const RUNS_DIR = process.env.WEB_PANEL_RUNS || path.join(HOME, '.claude', 'web-panel-runs');
const RUNS_KEEP = 20;
function clip(t, n) { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n) + '\n… (' + t.length + ' chars)' : t; }
function resultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && x.type === 'text' ? x.text : x && x.type ? '[' + x.type + ']' : '')).join('\n');
  try { return JSON.stringify(c); } catch (_) { return ''; }
}
function newRun(reason, t0) {
  return { id: new Date(t0).toISOString().replace(/[:.]/g, '-'), reason, model: MODEL, started: new Date(t0).toISOString(),
    status: 'running', events: [], connectors: null };
}
function runEvent(run, e) { if (run && run.events.length < 400) run.events.push(Object.assign({ t: Date.now() }, e)); }
function finishRun(run, o) {
  run.status = o.error ? 'failed' : 'ok'; run.error = o.error || null; run.cost = o.cost; run.answered = o.answered;
  run.sources = o.sources || null; run.ended = new Date().toISOString(); run.took = Math.round((Date.parse(run.ended) - Date.parse(run.started)) / 1000);
  run.output = o.output ? clip(JSON.stringify(o.output, null, 2), 20000) : null;
  try {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    fs.writeFileSync(path.join(RUNS_DIR, run.id + '.json'), JSON.stringify(run));
    const all = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).sort();
    for (const f of all.slice(0, Math.max(0, all.length - RUNS_KEEP))) fs.rmSync(path.join(RUNS_DIR, f), { force: true });
  } catch (e) { log('run log', e.message); }
  if (agent.current === run) agent.current = null;
}
function runSummary(r) {
  const tools = r.events.filter((e) => e.kind === 'tool').length, last = [...r.events].reverse().find((e) => e.kind === 'tool');
  return { id: r.id, reason: r.reason, started: r.started, ended: r.ended || null, took: r.took, status: r.status, error: r.error || null,
    cost: r.cost, answered: r.answered || [], tools, step: r.status === 'running' && last ? last.name : null,
    waiting: r.status === 'running' && !r.events.some((e) => e.kind === 'prompt') };
}
function readRun(id) {
  if (agent.current && agent.current.id === id) return agent.current;
  if (!/^[\w-]+$/.test(String(id || ''))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, id + '.json'), 'utf8')); } catch (_) { return null; }
}
function runs() {
  let list = [];
  try { list = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, RUNS_KEEP)
    .map((f) => readRun(f.slice(0, -5))).filter(Boolean).map(runSummary); } catch (_) {}
  if (agent.current) list.unshift(runSummary(agent.current));
  return { runs: list, running: !!agent.current };
}
function run(id) { return readRun(id); }
function panelEnv() {
  const e = Object.assign({}, process.env, { CLAUDE_WEB_CHAT: '1' });
  delete e.WEB_TERMINAL_PASSWORD; delete e.NGROK_AUTHTOKEN;
  return e;
}
function readSnapshot() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return null; } }
function agentRun(reason) {
  if (agent.running) return agent.running;
  agent.running = (async () => {
    const sdk = await getSdk();
    if (!sdk) { agent.error = 'Agent SDK not loaded'; return; }
    const t0 = Date.now(); agent.lastRun = t0; let out = null, cost = null, err = null, sources = null;
    const calls = {}, answered = {}; // tool_use id -> source; sources with a non-error tool result
    const run = agent.current = newRun(reason, t0);
    let wireRec = null;
    try {
      if (!gh.data && !gh.busy) await ghRun(); else if (gh.busy) await gh.busy;
      // The prompt waits until the claude.ai connectors are up: they connect in the background,
      // and a run that starts before them has no calendar / Slack / Gmail tools at all.
      let release; const gate = new Promise((r) => { release = r; });
      const prompt = agentPrompt(gh.data);
      async function* input() { await gate; yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null }; }
      const rec = wireMod ? await wireMod.begin('today', 'Today panel: ' + reason, panelEnv()) : { id: null, env: panelEnv(), finish() {} };
      run.wire = rec.id; wireRec = rec;
      const q = sdk.query({ prompt: input(), options: {
        cwd: HOME, model: MODEL, persistSession: false, maxTurns: 30, permissionMode: 'default',
        // CLAUDE_WEB_CHAT keeps the tmux hook (notify.sh, loaded with the user's settings) out of this
        // run: otherwise every run registers as a session of whatever tmux tab was active last.
        env: rec.env,
        // Settings files stay on: without them the SDK does not load the claude.ai connectors
        // (calendar, Jira, Slack, Gmail), which are what this run is for. An "allow" rule in the
        // user's settings could let a tool skip canUseTool, so the same read-only check also runs
        // as a PreToolUse hook: a hook "deny" wins over any allow rule. The hook judges MCP tools
        // only: the SDK's own structured-output tool must pass, built-ins are cut by disallowedTools.
        hooks: { PreToolUse: [{ hooks: [async (h) => {
          const n = String((h && h.tool_name) || '');
          return !n.startsWith('mcp__') || isReadTool(n) ? { continue: true } : {
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'This run is read-only.' },
          };
        }] }] },
        disallowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'NotebookEdit', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'Workflow',
          'CronCreate', 'CronDelete', 'RemoteTrigger', 'PushNotification', 'SendMessage', 'ScheduleWakeup', 'Skill'],
        // no local tools at all (it reads untrusted mail/chat, and $HOME holds the credentials);
        // MCP calls are the only thing that reaches the outside: anything that is not a read is refused
        canUseTool: async (name, input) => isReadTool(name) ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'This run is read-only.' },
        outputFormat: { type: 'json_schema', schema: SCHEMA },
        stderr: () => {},
      } });
      const timer = setTimeout(() => { try { q.close(); } catch (_) {} }, 5 * 60000);
      runEvent(run, { kind: 'wait', text: 'waiting for the connectors…' });
      waitConnectors(q).then((st) => {
        if (!st) return;
        log('connectors', st.text); run.connectors = st.list; runEvent(run, { kind: 'wait', text: 'connectors: ' + st.text });
        // the connectors that came up are what this account has (init often lists them before they exist)
        const up = st.list.filter((x) => x.status === 'connected').map((x) => 'mcp__' + x.name + '__');
        if (up.length) { sources = sources || {}; for (const k of SOURCES) sources[k] = sources[k] || up.some((n) => sourceOf(n) === k); }
      }).finally(() => { runEvent(run, { kind: 'prompt', text: prompt }); release(); });
      try {
        for await (const m of q) if (m.type === 'assistant' || m.type === 'user') {
          // remember which sources really answered: a run where a connector was not ready yet
          // comes back "ok" with that block empty, which must not wipe the last good data
          for (const c of (m.message && Array.isArray(m.message.content) && m.message.content) || []) {
            if (c.type === 'tool_use' && sourceOf(c.name)) calls[c.id] = sourceOf(c.name);
            else if (c.type === 'tool_result' && calls[c.tool_use_id] && !c.is_error) answered[calls[c.tool_use_id]] = true;
            if (c.type === 'tool_use') runEvent(run, { kind: 'tool', id: c.id, name: c.name, input: clip(JSON.stringify(c.input || {}), 4000) });
            else if (c.type === 'tool_result') runEvent(run, { kind: 'result', id: c.tool_use_id, error: !!c.is_error, text: clip(resultText(c.content), 6000) });
            else if (c.type === 'text' && m.type === 'assistant' && c.text && c.text.trim()) runEvent(run, { kind: 'text', text: clip(c.text, 4000) });
          }
        } else if (m.type === 'system' && m.subtype === 'init') {
          // which connectors this account has: a block is shown only when its connector exists.
          // claude.ai connectors are often still "pending" at init (their tools not listed yet),
          // so a server counts unless it failed or needs a login; its tools count too.
          const names = (m.tools || []).filter((n) => n.startsWith('mcp__'))
            .concat((m.mcp_servers || []).filter((s) => !/fail|auth|disabled/i.test(String(s.status || ''))).map((s) => String(s.name || '')));
          const seen = { calendar: names.some((n) => /calendar/i.test(n)), jira: names.some((n) => /atlassian|jira/i.test(n)),
            slack: names.some((n) => /slack/i.test(n)), gmail: names.some((n) => /gmail/i.test(n)) };
          sources = sources || {}; for (const k of SOURCES) sources[k] = sources[k] || seen[k];
        } else if (m.type === 'result') {
          cost = m.total_cost_usd;
          // the run is over: do not wait on the CLI to exit by itself
          setTimeout(() => { try { q.close(); } catch (_) {} }, 3000);
          if (m.structured_output) out = m.structured_output;
          else if (m.subtype !== 'success') err = m.subtype;
          else { try { out = JSON.parse(String(m.result).replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch (_) { err = 'no structured output: ' + String(m.result || '').replace(/\s+/g, ' ').slice(0, 160); } }
        }
      } finally { clearTimeout(timer); }
    } catch (e) { err = String(e.message || e); }
    if (out) {
      const snap = Object.assign({ at: new Date().toISOString(), took: Math.round((Date.now() - t0) / 1000), cost, model: MODEL }, out,
        sources ? { sources } : {});
      // the model sometimes writes a key as a markdown link: keep the bare key, the link goes to url
      if (Array.isArray(snap.jira)) snap.jira = snap.jira.map((i) => { const c = cleanIssue(i); return Object.assign({}, i, { key: c.key, url: c.url }); });
      // backlog issues are not today's work, even if the model let some through
      if (Array.isArray(snap.jira)) {
        const backlog = new Set(snap.jira.filter((i) => /backlog/i.test(String(i.status || ''))).map((i) => i.key));
        snap.jira = snap.jira.filter((i) => !backlog.has(i.key));
        if (backlog.size && Array.isArray(snap.needs)) snap.needs = snap.needs.filter((i) => !(i.source === 'jira' && backlog.has(i.ref)));
      }
      // a source whose tools never answered this run keeps the previous run's items for a while
      const prev = readSnapshot();
      for (const k of SOURCES) {
        if (answered[k] || (snap[k] || []).length || !prev || !(prev[k] || []).length) continue;
        const since = (prev.kept && prev.kept[k]) || prev.at;
        if (Date.now() - Date.parse(since) > KEEP_MS) continue;
        snap[k] = prev[k]; (snap.kept = snap.kept || {})[k] = since;
        if (prev.sources && prev.sources[k] && snap.sources) snap.sources[k] = true;
        log('agent run kept previous', k, 'items: no answer from its tools');
      }
      // a block that came back with items is connected, whatever init said
      if (snap.sources) for (const k of SOURCES) if ((snap[k] || []).length) snap.sources[k] = true;
      try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(snap)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { err = e.message; }
    }
    if (wireRec) wireRec.finish({ cost, answer: out, error: err });
    finishRun(run, { error: err, cost, answered: Object.keys(answered), output: out, sources });
    agent.error = err; log('agent run', reason, err ? 'failed: ' + err : 'ok', 'answered: ' + (Object.keys(answered).join(',') || 'none'), Math.round((Date.now() - t0) / 1000) + 's', cost != null ? '$' + cost.toFixed(4) : '');
  })().finally(() => { agent.running = null; });
  return agent.running;
}

// ---------------------------------------------------------------- hidden items
// key -> {sig, title, at}. The launcher hides an item while its signature (the values that
// matter for it: draft / CI / review state of a PR, status of a Jira issue, time of a meeting…)
// is the same as when it was hidden; any change brings it back.
function readHidden() {
  let h = {}; try { h = JSON.parse(fs.readFileSync(HIDDEN_FILE, 'utf8')) || {}; } catch (_) {}
  const old = Date.now() - HIDDEN_DAYS * 864e5;
  for (const k of Object.keys(h)) if (!h[k] || h[k].at < old) delete h[k];
  return h;
}
function writeHidden(h) { fs.writeFileSync(HIDDEN_FILE + '.tmp', JSON.stringify(h)); fs.renameSync(HIDDEN_FILE + '.tmp', HIDDEN_FILE); }
function hide(o) {
  const h = readHidden(), key = String((o && o.key) || '').slice(0, 500);
  if (!key) throw new Error('key is required');
  if (o.unhide) delete h[key];
  else h[key] = { sig: String(o.sig || '').slice(0, 500), title: String(o.title || '').slice(0, 200), at: Date.now() };
  writeHidden(h);
  return { hidden: h };
}
function unhideAll() { writeHidden({}); return { hidden: {} }; }

// ---------------------------------------------------------------- API
async function get() {
  agent.lastView = Date.now();
  if (Date.now() - gh.at > 60000) await ghRun();
  const snap = readSnapshot();
  const ev = everyMin(), due = !snap || (ev > 0 && Date.now() - Date.parse(snap.at) > ev * 60000);
  if (ENABLED && due && !agent.running && Date.now() - agent.lastRun > 60000) agentRun(snap ? 'stale' : 'first');
  return { enabled: ENABLED, github: gh.data, githubError: gh.error, githubAt: gh.at ? new Date(gh.at).toISOString() : null,
    agent: snap, agentRunning: !!agent.running, agentError: agent.error, agentNow: agent.current ? runSummary(agent.current) : null, every: everyMin(), hidden: readHidden() };
}
async function refresh(what) {
  agent.lastView = Date.now();
  if (what !== 'agent') await ghRun();
  if (what !== 'github' && ENABLED) agentRun('manual');
  return get();
}
// background refresh while the panel is being looked at (checked every 30 s)
setInterval(() => {
  if (!ENABLED || Date.now() - agent.lastView > IDLE_STOP_MS) return;
  const snap = readSnapshot(), ev = everyMin();
  if (ev > 0 && (!snap || Date.now() - Date.parse(snap.at) > ev * 60000)) agentRun('timer');
}, 30000).unref();

// The calendar event going on right now (from the last snapshot), or null. Voice alerts stay
// quiet during it: spoken phrases would go straight into the call's microphone.
// All-day and declined events don't count; an event without an end is taken as 30 minutes.
function inMeeting(now = Date.now()) {
  const snap = readSnapshot();
  for (const e of (snap && snap.calendar) || []) {
    if (!e || e.allDay || e.declined) continue;
    const start = Date.parse(e.start); if (!start) continue;
    const end = Date.parse(e.end) || start + 30 * 60000;
    if (start - 60000 <= now && now < end) return { title: e.title || '', end: new Date(end).toISOString() };
  }
  return null;
}

// ---------------------------------------------------------------- Jira search (New task dialog)
// The dialog lists my issues from the last snapshot right away; this finds any other issue by
// words or key: a short read-only run on the cheap model through the Jira connector. Same guard
// rails as the panel run (MCP reads only, no local tools). Cached per query for a few minutes.
const JIRA_SCHEMA = {
  type: 'object', required: ['connected', 'issues'],
  properties: {
    connected: { type: 'boolean', description: 'false when no Jira / Atlassian tools were available' },
    issues: { type: 'array', items: { type: 'object', required: ['key', 'title'], properties: {
      key: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' }, assignee: { type: 'string' }, url: { type: 'string' }, updated: { type: 'string' } } } },
  },
};
const JIRA_TTL = 5 * 60000, jiraCache = new Map();
// "[ABC-12](https://…/browse/ABC-12)" (how the model often writes a key) -> key + url
function cleanIssue(i) {
  const raw = String((i && i.key) || ''), m = /([A-Z][A-Z0-9_]+-\d+)/.exec(raw), u = /\((https?:\/\/[^)\s]+)\)/.exec(raw);
  return { key: m ? m[1] : raw.slice(0, 40), title: String((i && i.title) || '').trim(), status: String((i && i.status) || ''),
    assignee: String((i && i.assignee) || ''), url: String((i && i.url) || (u ? u[1] : '')), updated: String((i && i.updated) || '') };
}
// one read-only run through the Jira connector -> {connected, issues}
async function jiraRun(label, prompt, max) {
  const sdk = await getSdk();
  if (!sdk) throw new Error('Agent SDK not loaded');
  // the claude.ai connectors come up some seconds after start: the prompt waits for them
  let release; const gate = new Promise((r) => { release = r; });
  async function* input() { await gate; yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null }; }
  const rec = wireMod ? await wireMod.begin('today', label, panelEnv()) : { id: null, env: panelEnv(), finish() {} };
  const q = sdk.query({ prompt: input(), options: {
    cwd: HOME, model: MODEL, persistSession: false, maxTurns: 8, permissionMode: 'default', env: rec.env,
    hooks: { PreToolUse: [{ hooks: [async (h) => {
      const n = String((h && h.tool_name) || '');
      return !n.startsWith('mcp__') || isReadTool(n) ? { continue: true } : {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'This run is read-only.' },
      };
    }] }] },
    disallowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'NotebookEdit', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'Workflow',
      'CronCreate', 'CronDelete', 'RemoteTrigger', 'PushNotification', 'SendMessage', 'ScheduleWakeup', 'Skill'],
    canUseTool: async (name, inp) => isReadTool(name) && sourceOf(name) === 'jira' ? { behavior: 'allow', updatedInput: inp }
      : { behavior: 'deny', message: 'Only Jira reads are allowed here.' },
    outputFormat: { type: 'json_schema', schema: JIRA_SCHEMA },
    stderr: () => {},
  } });
  const timer = setTimeout(() => { try { q.close(); } catch (_) {} }, 3 * 60000);
  waitConnectors(q).finally(release);
  let out = null, err = null, cost = null;
  try {
    for await (const m of q) if (m.type === 'result') {
      cost = m.total_cost_usd;
      setTimeout(() => { try { q.close(); } catch (_) {} }, 2000);
      if (m.structured_output) out = m.structured_output; else err = m.subtype || 'no answer';
    }
  } catch (e) { err = String(e.message || e); } finally { clearTimeout(timer); }
  rec.finish({ cost, answer: out, error: err });
  log(label, err ? 'failed: ' + err : (out.issues || []).length + ' issues', cost != null ? '$' + cost.toFixed(4) : '');
  if (!out) throw new Error(err);
  out.issues = (out.issues || []).slice(0, max).map(cleanIssue).filter((i) => i.key);
  return out;
}
async function jiraSearch(text) {
  text = String(text || '').trim().slice(0, 200);
  if (!text) return { connected: true, issues: [] };
  const hit = jiraCache.get(text.toLowerCase());
  if (hit && Date.now() - hit.at < JIRA_TTL) return hit.out;
  const out = await jiraRun('Jira search: ' + text, 'Find Jira issues for this search: ' + JSON.stringify(text) + '.\n' +
    'If it is an issue key (like ABC-123), fetch that issue. If it is the start of a key (like ABC-12), search key-like issues ' +
    'in that project. Otherwise search with JQL text ~ the words, order by updated DESC; prefer issues that are not Done. ' +
    'Return at most 15. key = the bare key (ABC-123), url = the browse link. ' +
    'If there are no Jira / Atlassian tools at all, return connected=false and no issues. Do not do anything else.', 15);
  jiraCache.set(text.toLowerCase(), { at: Date.now(), out });
  if (jiraCache.size > 100) jiraCache.delete(jiraCache.keys().next().value);
  return out;
}
// Issues of the projects I work in, recently touched: the dialog filters these as I type, so most
// lookups need no run at all. Refreshed in the background when older than RECENT_TTL.
const RECENT_TTL = 15 * 60000;
let recent = { at: 0, out: null, busy: null };
function jiraRecent() {
  const fresh = recent.out && Date.now() - recent.at < RECENT_TTL;
  if (!fresh && !recent.busy) {
    recent.busy = jiraRun('Jira: recent issues', 'List Jira issues for a quick picker: the projects of the issues assigned to me ' +
      '(find them first with assignee = currentUser()), then JQL: project in (those projects) AND updated >= -60d ' +
      'ORDER BY updated DESC. Return up to 100: key = the bare key (ABC-123), title, status, assignee, url = the browse link. ' +
      'If there are no Jira / Atlassian tools at all, return connected=false and no issues. Do not do anything else.', 100)
      .then((out) => { recent = { at: Date.now(), out, busy: null }; }, (e) => { log('jira recent failed', e.message); })
      .finally(() => { recent.busy = null; });
  }
  return { at: recent.at || null, refreshing: !!recent.busy, connected: recent.out ? recent.out.connected : null,
    issues: recent.out ? recent.out.issues : [] };
}

module.exports = { init, get, refresh, hide, unhideAll, setEvery, inMeeting, runs, run, READ_TOOL, isReadTool, jiraSearch, jiraRecent, cleanIssue };
