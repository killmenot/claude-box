'use strict';
// Web login for the sidecar: who may open the UI.
//
// Nothing is asked in the terminal. The host script (./claude-box) writes a one-time sign-in key to
// ~/.claude/web-login-key and prints https://localhost:<port>/?key=<key>. Opening that link once
// gives the browser a session cookie. On the first visit the UI then asks for a login and password
// (needed for a phone, another computer or the public tunnel); they are kept here as a scrypt hash.
//
//   ~/.claude/web-auth.json   {user, salt, hash, sessions: {sha256(token): {at, last}}}   mode 600
//   ~/.claude/web-login-key   one line; valid KEY_TTL after it was written, used once
//
// WEB_TERMINAL_PASSWORD / WEB_TERMINAL_USER from .env still work (older installs); a password set
// in the UI takes precedence over them.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_TTL = 15 * 60000;
const SESSION_TTL = 180 * 86400000;      // a browser stays signed in for half a year of no use
const USER_RE = /^[A-Za-z0-9._-]{1,64}$/;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sameStr = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));

function makeStore(opts) {
  opts = opts || {};
  const dir = opts.dir || path.join(process.env.HOME || '/home/node', '.claude');
  const file = path.join(dir, 'web-auth.json');
  const keyFile = path.join(dir, 'web-login-key');
  const envUser = opts.envUser || 'claude', envPassword = opts.envPassword || '';
  const now = opts.now || Date.now;

  function read() { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { return {}; } }
  function write(o) {
    fs.mkdirSync(dir, { recursive: true });
    const t = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(t, JSON.stringify(o, null, 2), { mode: 0o600 });
    fs.renameSync(t, file);
  }
  const hashPw = (pw, salt) => crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32).toString('hex');

  const S = {
    // a login and password exist (set in the UI, or the old .env password)
    configured() { return !!read().hash || !!envPassword; },
    fromEnv() { return !read().hash && !!envPassword; },
    user() { const o = read(); return o.hash ? o.user : envUser; },
    checkPassword(user, pw) {
      const o = read();
      if (o.hash) {
        const got = hashPw(pw, o.salt);
        return sameStr(user, o.user) && crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(o.hash, 'hex'));
      }
      return !!envPassword && sameStr(user + ':' + pw, envUser + ':' + envPassword);
    },
    // -> '' or what is wrong with the new login
    setPassword(user, pw) {
      if (!USER_RE.test(String(user || ''))) return "Login: letters, digits, '.', '_' and '-' only.";
      if (String(pw || '').length < 8) return 'Password: at least 8 characters.';
      if (String(pw).length > 256) return 'Password: too long.';
      const o = read(), salt = crypto.randomBytes(16).toString('hex');
      Object.assign(o, { user, salt, hash: hashPw(pw, salt), setAt: now() });
      write(o);
      return '';
    },
    newSession() {
      const tok = crypto.randomBytes(32).toString('hex'), o = read(), t = now();
      o.sessions = o.sessions || {};
      for (const [k, v] of Object.entries(o.sessions)) if (t - (v.last || v.at || 0) > SESSION_TTL) delete o.sessions[k];
      o.sessions[sha(tok)] = { at: t, last: t };
      write(o);
      return tok;
    },
    checkSession(tok) {
      if (!/^[0-9a-f]{64}$/.test(String(tok || ''))) return false;
      const o = read(), s = o.sessions && o.sessions[sha(tok)];
      if (!s) return false;
      const t = now();
      if (t - (s.last || s.at || 0) > SESSION_TTL) return false;
      if (t - (s.last || 0) > 3600000) { s.last = t; try { write(o); } catch (_) {} }   // touch at most hourly
      return true;
    },
    // sign every browser out except the one holding `keep`
    dropSessions(keep) {
      const o = read(), k = keep ? sha(keep) : '';
      o.sessions = k && o.sessions && o.sessions[k] ? { [k]: o.sessions[k] } : {};
      write(o);
    },
    // the one-time key from the host script; used up on success
    useKey(key) {
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(key || ''))) return false;
      let st, want;
      try { st = fs.statSync(keyFile); want = fs.readFileSync(keyFile, 'utf8').trim(); } catch (_) { return false; }
      if (!want || now() - st.mtimeMs > KEY_TTL) return false;
      if (!sameStr(key, want)) return false;
      try { fs.unlinkSync(keyFile); } catch (_) {}
      return true;
    },
  };
  return S;
}

// cookie name per UI port: browsers share cookies across ports, and two boxes may run side by side
function cookieName(port) { return 'cb_s' + String(port || '').replace(/\D/g, ''); }
function readCookie(req, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)').exec(String((req.headers || {}).cookie || ''));
  return m ? m[1] : '';
}
function sessionCookie(name, tok, secure) {
  return `${name}=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL / 1000)}` + (secure ? '; Secure' : '');
}

module.exports = { makeStore, cookieName, readCookie, sessionCookie, KEY_TTL, USER_RE };
