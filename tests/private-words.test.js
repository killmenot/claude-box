'use strict';
// Nothing private goes into this public repo: company names, issue keys, Slack ids, work addresses.
// The words themselves are not in the repo either: one regular expression per line (# starts a
// comment) in the file CB_PRIVATE_WORDS names, else .private-words at the repo root (gitignored), else
// ~/.config/claude-box/private-words (shared by every checkout). Without such a file the test skips. It checks every tracked file, the commit messages and the author and
// committer addresses of the commits not on origin/main yet (all commits when there is no origin).
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LIST = [process.env.CB_PRIVATE_WORDS, path.join(ROOT, '.private-words'),
  path.join(require('os').homedir(), '.config', 'claude-box', 'private-words')].find((f) => f && fs.existsSync(f));
const words = (() => {
  try {
    return fs.readFileSync(LIST, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      .map((l) => new RegExp(l, 'i'));
  } catch (_) { return null; }
})();
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 256 << 20 });
const inRepo = (() => { try { git('rev-parse', '--git-dir'); return true; } catch (_) { return false; } })();
const skip = !words ? 'no .private-words list here' : !inRepo ? 'not a git checkout' : false;

test('tracked files hold no private words', { skip }, () => {
  const hits = [];
  for (const f of git('ls-files', '-z').split('\0').filter(Boolean)) {
    let s; try { s = fs.readFileSync(path.join(ROOT, f)); } catch (_) { continue; }
    if (s.includes(0)) continue;                                   // binary
    s.toString('utf8').split('\n').forEach((line, i) => {
      for (const w of words) if (w.test(line)) hits.push(`${f}:${i + 1} matches /${w.source}/`);
    });
  }
  assert.deepStrictEqual(hits, [], 'private words in tracked files:\n' + hits.join('\n'));
});

test('new commits carry no private words in messages or addresses', { skip }, () => {
  let range = 'HEAD';
  try { git('rev-parse', '--verify', '-q', 'origin/main'); range = 'origin/main..HEAD'; } catch (_) {}
  const log = git('log', '--format=%h%x00%an <%ae>%x00%cn <%ce>%x00%B%x1e', range);
  const hits = [];
  for (const rec of log.split('\x1e')) {
    const [h, ...rest] = rec.trim().split('\0');
    if (!h) continue;
    for (const w of words) if (w.test(rest.join('\n'))) hits.push(`${h} matches /${w.source}/`);
  }
  assert.deepStrictEqual(hits, [], 'private words in commits:\n' + hits.join('\n'));
});
