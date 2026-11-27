'use strict';
// GitHub sign-in for the box from the UI, the same flow as `gh auth login --web` in a terminal:
// gh prints a one-time code, the user enters it at github.com/login/device, gh finishes by itself.
// Afterwards git uses gh as its credential helper (HTTPS; git@github.com: URLs are rewritten to
// HTTPS in the image's gitconfig), and a commit name/email is filled in from the GitHub account
// when none is set. Served at /git by web-sidecar.js:
//   GET  /git/status           {gh, account, name, email, login:{state, code, url, error}}
//   POST /git/login            start the device flow (state: starting -> code -> done | error)
//   POST /git/login/cancel     stop a sign-in in progress
//   POST /git/logout           sign gh out of github.com
//   POST /git/identity         {name, email}: who the box commits as (git config --global)
//   GET  /git/repos            repos this account can clone (own, collaborator, its orgs'), newest push first
const { spawn, execFile } = require('child_process');

const HOST = 'github.com';
const LOGIN_TTL = 15 * 60000;
let login = { state: 'idle' }, proc = null, timer = null;

function run(cmd, args, opts) {
  return new Promise((res) => {
    execFile(cmd, args, Object.assign({ timeout: 20000, maxBuffer: 1 << 20 }, opts || {}), (err, stdout, stderr) =>
      res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || ''), err: String(stderr || ''), missing: !!(err && err.code === 'ENOENT') }));
  });
}
const gitGet = async (k) => (await run('git', ['config', '--global', '--get', k])).out.trim();

async function status() {
  const s = await run('gh', ['auth', 'status', '--hostname', HOST]);
  // gh writes the report to stderr in older versions, stdout in newer ones
  const m = /Logged in to \S+ (?:account|as) (\S+)/.exec(s.out + '\n' + s.err);
  return {
    gh: !s.missing,
    account: s.code === 0 && m ? m[1].replace(/[()]/g, '') : '',
    name: await gitGet('user.name'),
    email: await gitGet('user.email'),
    login: Object.assign({}, login),
  };
}

// a commit identity from the account (name, or the login; the private noreply address), if unset
async function fillIdentity() {
  const u = await run('gh', ['api', 'user', '--jq', '[.login, (.id|tostring), (.name // "")] | @tsv']);
  if (u.code !== 0) return;
  const [user, id, name] = u.out.trim().split('\t');
  if (!user) return;
  if (!(await gitGet('user.name'))) await run('git', ['config', '--global', 'user.name', name || user]);
  if (!(await gitGet('user.email'))) await run('git', ['config', '--global', 'user.email', `${id}+${user}@users.noreply.github.com`]);
}

// Who the box commits as, set from the UI (wizard / Settings > GitHub). A missing one is filled in
// at start from the env file (GIT_USER_NAME / GIT_USER_EMAIL: the host's identity, see ./claude-box)
// and after a GitHub sign-in from the account; Claude never invents one (claude-defaults/managed-CLAUDE.md).
async function setIdentity(o) {
  const name = String((o && o.name) || '').replace(/\s+/g, ' ').trim(), email = String((o && o.email) || '').trim();
  if (!name || name.length > 100) throw new Error('Name: 1-100 characters.');
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email.length > 200) throw new Error('Email: an address like you@example.com.');
  for (const [k, v] of [['user.name', name], ['user.email', email]]) {
    const r = await run('git', ['config', '--global', k, v]);
    if (r.code !== 0) throw new Error('git config failed: ' + (r.err || r.out).trim().slice(0, 200));
  }
  return { name, email };
}
// the env file's identity (the host's), only where the box has none yet: what is set in the UI wins
async function seedIdentity(env) {
  const set = [];
  for (const [k, key] of [['GIT_USER_NAME', 'user.name'], ['GIT_USER_EMAIL', 'user.email']]) {
    const v = String((env || process.env)[k] || '').trim();
    if (v && !(await gitGet(key))) { await run('git', ['config', '--global', key, v]); set.push(key); }
  }
  return set;
}

function stop() {
  clearTimeout(timer); timer = null;
  if (proc) { try { proc.kill('SIGTERM'); } catch (_) {} proc = null; }
}

function start() {
  if (proc) return Object.assign({}, login);
  login = { state: 'starting', at: Date.now() };
  let out = '';
  // GH_BROWSER=true: gh would try to open a browser inside the container; the UI shows the link instead
  const env = Object.assign({}, process.env, { GH_BROWSER: 'true', BROWSER: 'true', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' });
  let p;
  try {
    p = spawn('gh', ['auth', 'login', '--hostname', HOST, '--git-protocol', 'https', '--web', '--skip-ssh-key'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) { login = { state: 'error', error: 'gh could not start: ' + e.message }; return Object.assign({}, login); }
  proc = p;
  const onData = (d) => {
    out += String(d);
    const c = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(out);
    if (c && login.state === 'starting') {
      const u = /(https:\/\/github\.com\/login\/device)/.exec(out);
      login = { state: 'code', code: c[1], url: u ? u[1] : 'https://github.com/login/device', at: login.at };
      try { p.stdin.write('\n'); } catch (_) {}            // "Press Enter to open github.com in your browser"
    }
  };
  p.stdout.on('data', onData); p.stderr.on('data', onData);
  p.on('error', (e) => { if (proc === p) { proc = null; login = { state: 'error', error: e.code === 'ENOENT' ? 'gh is not installed in the box.' : e.message }; } });
  p.on('close', async (code) => {
    if (proc !== p) return;                                // cancelled
    proc = null; clearTimeout(timer);
    if (code === 0) {
      await run('gh', ['auth', 'setup-git', '--hostname', HOST]);
      await fillIdentity();
      login = { state: 'done' };
    } else {
      const last = out.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
      login = { state: 'error', error: last.slice(0, 300) || 'gh exited with code ' + code };
    }
  });
  timer = setTimeout(() => { if (proc === p) { stop(); login = { state: 'error', error: 'The code expired. Try again.' }; } }, LOGIN_TTL);
  return Object.assign({}, login);
}

function cancel() { stop(); login = { state: 'idle' }; return Object.assign({}, login); }

async function logout() {
  cancel();
  const s = await status();
  const args = ['auth', 'logout', '--hostname', HOST];
  if (s.account) args.push('--user', s.account);
  const r = await run('gh', args);
  return { ok: r.code === 0, error: r.code === 0 ? '' : (r.err || r.out).trim().slice(0, 300) };
}

// Repos for the clone picker. One paginated API call covers own repos, the ones shared with the
// account and those of its organizations; cached for a few minutes (a big org has hundreds).
const REPOS_TTL = 10 * 60000;
let reposCache = { at: 0, list: null, busy: null };
async function repos(force) {
  if (!force && reposCache.list && Date.now() - reposCache.at < REPOS_TTL) return { repos: reposCache.list, at: reposCache.at };
  if (!reposCache.busy) {
    reposCache.busy = run('gh', ['api', '--paginate',
      'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
      '--jq', '.[] | [.full_name, (.private|tostring), (.pushed_at // ""), ((.description // "") | gsub("[\\t\\n]"; " ")), .clone_url] | @tsv'],
      { timeout: 60000, maxBuffer: 16 << 20 }).then((r) => {
      if (r.code !== 0) throw new Error((r.err || r.out).trim().split('\n').pop() || 'gh api failed');
      const list = r.out.split('\n').filter(Boolean).map((l) => {
        const [name, priv, pushed, desc, url] = l.split('\t');
        return { name, private: priv === 'true', pushed, desc: (desc || '').slice(0, 200), url };
      });
      list.sort((a, b) => String(b.pushed).localeCompare(String(a.pushed)));
      reposCache = { at: Date.now(), list, busy: null };
      return list;
    }).finally(() => { reposCache.busy = null; });
  }
  return { repos: await reposCache.busy, at: Date.now() };
}

module.exports = { status, start, cancel, logout, repos, fillIdentity, setIdentity, seedIdentity };
