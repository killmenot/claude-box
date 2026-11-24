'use strict';
// web-auth.js + makeAuth with a store: the one-time key from ./claude-box, session cookies, the
// login set in the UI, and the old .env password.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeStore, cookieName, sessionCookie } = require('../scripts/web-auth.js');
const { makeAuth } = require('../scripts/web-guard.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
const req = (url, h) => ({ url, method: 'GET', headers: h || {}, socket: { remoteAddress: '127.0.0.1' } });
const basic = (u, p) => ({ authorization: 'Basic ' + Buffer.from(u + ':' + p).toString('base64') });

test('no login yet: nothing gets in but the one-time key, which works once', () => {
  const dir = tmpDir(), store = makeStore({ dir }), auth = makeAuth({ store, cookie: 'cb_s1' });
  assert.strictEqual(store.configured(), false);
  assert.deepStrictEqual(auth(req('/')), { ok: false, status: 401, setup: true });
  assert.strictEqual(auth(req('/', basic('claude', 'anything'))).ok, false);
  fs.writeFileSync(path.join(dir, 'web-login-key'), 'Abcdefghijklmnop1234\n');
  assert.strictEqual(auth(req('/?key=wrongwrongwrongwrong')).badKey, true);
  assert.deepStrictEqual(auth(req('/?key=Abcdefghijklmnop1234')), { ok: true, login: true });
  assert.strictEqual(auth(req('/?key=Abcdefghijklmnop1234')).ok, false, 'the key is used up');
  assert.strictEqual(fs.existsSync(path.join(dir, 'web-login-key')), false);
});

test('an old key does not work', () => {
  let t = Date.now();
  const dir = tmpDir(), store = makeStore({ dir, now: () => t });
  fs.writeFileSync(path.join(dir, 'web-login-key'), 'Abcdefghijklmnop1234');
  t += 16 * 60000;
  assert.strictEqual(store.useKey('Abcdefghijklmnop1234'), false);
});

test('a session cookie signs the browser in; the login set in the UI then works with Basic auth', () => {
  const dir = tmpDir(), store = makeStore({ dir }), auth = makeAuth({ store, cookie: 'cb_s1' });
  const tok = store.newSession();
  assert.strictEqual(auth(req('/sessions', { cookie: 'x=1; cb_s1=' + tok })).ok, true);
  assert.strictEqual(auth(req('/sessions', { cookie: 'cb_s2=' + tok })).ok, false, 'another box\'s cookie name');
  assert.match(store.setPassword('bad login', 'secret123'), /Login/);
  assert.match(store.setPassword('alice', 'short'), /at least 8/);
  assert.strictEqual(store.setPassword('alice', 'secret123'), '');
  assert.strictEqual(store.configured(), true);
  assert.strictEqual(auth(req('/', basic('alice', 'secret123'))).ok, true);
  assert.strictEqual(auth(req('/', basic('alice', 'wrong-one'))).ok, false);
  assert.strictEqual(auth(req('/')).setup, undefined, 'now the browser is asked for the password');
  const raw = fs.readFileSync(path.join(dir, 'web-auth.json'), 'utf8');
  assert.ok(!raw.includes('secret123') && !raw.includes(tok), 'only hashes are stored');
  assert.strictEqual((fs.statSync(path.join(dir, 'web-auth.json')).mode & 0o777), 0o600);
  const keep = store.newSession();
  store.dropSessions(keep);
  assert.strictEqual(store.checkSession(tok), false);
  assert.strictEqual(store.checkSession(keep), true);
});

test('the .env password still works until one is set in the UI', () => {
  const dir = tmpDir(), store = makeStore({ dir, envUser: 'claude', envPassword: 'fromenv1' });
  const auth = makeAuth({ store });
  assert.strictEqual(store.fromEnv(), true);
  assert.strictEqual(auth(req('/', basic('claude', 'fromenv1'))).ok, true);
  store.setPassword('bob', 'newpass99');
  assert.strictEqual(auth(req('/', basic('claude', 'fromenv1'))).ok, false);
  assert.strictEqual(auth(req('/', basic('bob', 'newpass99'))).ok, true);
});

test('cookie names differ per port; the Secure flag only over https', () => {
  assert.strictEqual(cookieName(8443), 'cb_s8443');
  assert.match(sessionCookie('cb_s1', 'ab', true), /HttpOnly; SameSite=Strict;.*; Secure$/);
  assert.ok(!/Secure/.test(sessionCookie('cb_s1', 'ab', false)));
});
