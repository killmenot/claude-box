'use strict';
// web-git.js: who the box commits as. The env file's (host's) identity fills only what is unset;
// the UI's choice is validated and written to the global git config.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-git-'));
process.env.HOME = tmp;
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.GIT_CONFIG_GLOBAL;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = require('../scripts/web-git.js');
const get = (k) => { try { return execFileSync('git', ['config', '--global', '--get', k], { encoding: 'utf8' }).trim(); } catch (_) { return ''; } };

test('the env file seeds only what is unset', async () => {
  assert.deepStrictEqual(await git.seedIdentity({ GIT_USER_NAME: 'Host Name', GIT_USER_EMAIL: 'host@example.com' }), ['user.name', 'user.email']);
  assert.strictEqual(get('user.name'), 'Host Name');
  execFileSync('git', ['config', '--global', 'user.name', 'Picked In UI']);
  assert.deepStrictEqual(await git.seedIdentity({ GIT_USER_NAME: 'Host Name', GIT_USER_EMAIL: 'other@example.com' }), []);
  assert.strictEqual(get('user.name'), 'Picked In UI');
  assert.strictEqual(get('user.email'), 'host@example.com');
});

test('the UI sets name and email; bad input is refused', async () => {
  assert.deepStrictEqual(await git.setIdentity({ name: '  Ivan   S ', email: 'ivan@example.com' }), { name: 'Ivan S', email: 'ivan@example.com' });
  assert.strictEqual(get('user.name'), 'Ivan S');
  await assert.rejects(git.setIdentity({ name: '', email: 'a@b.c' }), /Name/);
  await assert.rejects(git.setIdentity({ name: 'X', email: 'not an email' }), /Email/);
  assert.strictEqual(get('user.email'), 'ivan@example.com');
});
