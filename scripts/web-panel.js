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
function init(o) { if (o && o.getSdk) getSdk = o.getSdk; }

// ---------------------------------------------------------------- GitHub (direct)
const GQL = `query {
  viewer { login pullRequests(first: 40, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes {
    number title url isDraft updatedAt reviewDecision repository { nameWithOwner }
    comments { totalCount } reviews(last: 1) { nodes { author { login } submittedAt state } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } }
  direct: search(query: "is:pr is:open user-review-requested:@me archived:false -is:draft", type: ISSUE, first: 40) { ...prs }
  team: search(query: "is:pr is:open review-requested:@me archived:false -is:draft", type: ISSUE, first: 50) { ...prs }
}
fragment prs on SearchResultItemConnection { nodes { ... on PullRequest {
  number title url isDraft updatedAt author { login } repository { nameWithOwner } } } }`;
let gh = { at: 0, data: null, error: null, busy: null };
function ghRun() {
  if (gh.busy) return gh.busy;
  gh.busy = new Promise((resolve) => {
    execFile('gh', ['api', 'graphql', '-f', 'query=' + GQL], { maxBuffer: 8 << 20, timeout: 30000 }, (e, out, err) => {
      gh.busy = null; gh.at = Date.now();
      if (e) { gh.error = String(err || e.message).trim().slice(0, 300); resolve(); return; }
      try {
        const d = JSON.parse(out).data, me = d.viewer.login;
        const reviewState = reviewerState();
        const pr = (p) => ({ repo: p.repository.nameWithOwner, number: p.number, title: p.title, url: p.url,
          updated: p.updatedAt, author: p.author && p.author.login, bot: reviewState(p.repository.nameWithOwner, p.number) });
        gh.data = {
          login: me,
          // review requested from me personally; "team" = only through a team I am in
          review: d.direct.nodes.filter((p) => p && p.number).map(pr),
          team: d.team.nodes.filter((p) => p && p.number && !d.direct.nodes.some((x) => x && x.url === p.url)).map(pr),
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
// status of our own PR reviewer (reviews/state.json), if it runs for that repo
function reviewerState() {
  let cfg = null, st = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(REVIEWS_DIR, 'config.json'), 'utf8')); } catch (_) {}
  try { st = JSON.parse(fs.readFileSync(path.join(REVIEWS_DIR, 'state.json'), 'utf8')); } catch (_) {}
  return (repo, n) => {
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

1. calendar: my Google Calendar events from now until the end of my working day today (if the day is almost over, include tomorrow morning). Skip events I declined and "Out of office"/working-location blocks. Times as ISO 8601 with offset. url: the video call link if there is one.
2. jira: Jira issues assigned to me that are not done (statusCategory != Done), most recently updated first, at most 15. url: the browse link.
3. slack: what needs my attention in Slack from the last 24 hours: messages that mention me, new replies in threads I took part in, direct messages to me. At most 10, newest first, each with its permalink; text is a one-line summary.
4. gmail: unread emails from the last 48 hours in my inbox that a person wrote to me and that may need a reply or action. Leave out newsletters, notifications and automated mail (GitHub, Jira, Slack, calendar, CI, marketing). At most 8, newest first. url: https://mail.google.com/mail/u/0/#inbox/<thread id>.
5. needs: the 3–5 items across ALL sources (including the GitHub data below) where I personally have to act soon: a question to me, a review requested from me, my PR with failing CI or changes requested, a meeting starting within the next hour, a blocking Jira issue. Most urgent first. Leave out anything that only informs.

GitHub (already collected, use it only for "needs"): ${gh}

If a source is not available, return an empty list for it. Answer with the structured output only.`;
}
const READ_TOOL = /^mcp__.+__(?:slack_)?(?:list|search|get|read|fetch|query|lookup|atlassianUserInfo)/i;
let agent = { running: null, lastRun: 0, lastView: 0, error: null };
function readSnapshot() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return null; } }
function agentRun(reason) {
  if (agent.running) return agent.running;
  agent.running = (async () => {
    const sdk = await getSdk();
    if (!sdk) { agent.error = 'Agent SDK not loaded'; return; }
    const t0 = Date.now(); agent.lastRun = t0; let out = null, cost = null, err = null, sources = null;
    try {
      if (!gh.data && !gh.busy) await ghRun(); else if (gh.busy) await gh.busy;
      const q = sdk.query({ prompt: agentPrompt(gh.data), options: {
        cwd: HOME, model: MODEL, persistSession: false, maxTurns: 30, permissionMode: 'default',
        disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'Workflow',
          'CronCreate', 'CronDelete', 'RemoteTrigger', 'PushNotification', 'SendMessage', 'ScheduleWakeup', 'Skill'],
        // MCP calls are the only thing that reaches the outside: anything that is not a read is refused
        canUseTool: async (name, input) => READ_TOOL.test(name) ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'This run is read-only.' },
        outputFormat: { type: 'json_schema', schema: SCHEMA },
        stderr: () => {},
      } });
      const timer = setTimeout(() => { try { q.close(); } catch (_) {} }, 5 * 60000);
      try {
        for await (const m of q) if (m.type === 'system' && m.subtype === 'init') {
          // which connectors this account has: a block is shown only when its tools exist
          const t = (m.tools || []).filter((n) => n.startsWith('mcp__'));
          sources = { calendar: t.some((n) => /calendar/i.test(n)), jira: t.some((n) => /atlassian|jira/i.test(n)),
            slack: t.some((n) => /slack/i.test(n)), gmail: t.some((n) => /gmail/i.test(n)) };
        } else if (m.type === 'result') {
          cost = m.total_cost_usd;
          if (m.structured_output) out = m.structured_output;
          else if (m.subtype !== 'success') err = m.subtype;
          else { try { out = JSON.parse(String(m.result).replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch (_) { err = 'no structured output'; } }
        }
      } finally { clearTimeout(timer); }
    } catch (e) { err = String(e.message || e); }
    if (out) {
      const snap = Object.assign({ at: new Date().toISOString(), took: Math.round((Date.now() - t0) / 1000), cost, model: MODEL }, out,
        sources ? { sources } : {});
      try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(snap)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { err = e.message; }
    }
    agent.error = err; log('agent run', reason, err ? 'failed: ' + err : 'ok', Math.round((Date.now() - t0) / 1000) + 's', cost != null ? '$' + cost.toFixed(4) : '');
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
    agent: snap, agentRunning: !!agent.running, agentError: agent.error, every: everyMin(), hidden: readHidden() };
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

module.exports = { init, get, refresh, hide, unhideAll, setEvery, READ_TOOL };
