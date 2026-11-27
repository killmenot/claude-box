'use strict';
// VS Code in the browser (code-server) for the session view's Code tab. Only when the box was
// started with `./claude-box --vscode`: the image then carries code-server and WEB_VSCODE=1.
//
//   /code/...   -> code-server, prefix stripped (it uses relative URLs, so a sub-path just works)
//
// code-server is started on the first request and listens on a unix socket in a private dir, not
// on a port: with network_mode host a loopback port would be reachable by every local user of the
// host, and code-server runs with --auth none (the claude-box login in front of /code is the auth).
// Each session opens its own window with ?folder=<session folder>; one server serves them all.
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const BIN = process.env.CODE_SERVER_BIN || '/usr/bin/code-server';
const DIR = path.join(os.tmpdir(), `claude-box-code-${process.getuid ? process.getuid() : 'u'}`);
const SOCK = path.join(DIR, 'code.sock');
const HOME = process.env.HOME || '/home/node';
// installed once (best effort) on the first start; they live in the home bind mount, so they persist
const EXTENSIONS = ['anthropic.claude-code', 'eamodio.gitlens'];
const EXT_MARK = path.join(HOME, '.local', 'share', 'code-server', '.claude-box-extensions');

const log = (...a) => console.error('code:', ...a);
let proc = null, starting = null;

function enabled() { return process.env.WEB_VSCODE === '1' && fs.existsSync(BIN); }

function alive() {
  return new Promise((resolve) => {
    const s = net.connect(SOCK); s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

function installExtensions() {
  if (fs.existsSync(EXT_MARK)) return;
  let i = 0;
  const next = () => {
    if (i >= EXTENSIONS.length) { try { fs.mkdirSync(path.dirname(EXT_MARK), { recursive: true }); fs.writeFileSync(EXT_MARK, EXTENSIONS.join('\n') + '\n'); } catch (_) {} return; }
    const ext = EXTENSIONS[i++];
    const p = spawn(BIN, ['--install-extension', ext], { stdio: 'ignore' });
    p.on('exit', (c) => { if (c) log('extension not installed:', ext); next(); });
    p.on('error', () => next());
  };
  next();
}

// start code-server once; resolves when its socket answers
function ensure() {
  if (!enabled()) return Promise.reject(new Error('VS Code is off: start claude-box with --vscode'));
  if (starting) return starting;
  starting = (async () => {
    if (await alive()) return;
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(DIR, 0o700);
    try { fs.unlinkSync(SOCK); } catch (_) {}
    proc = spawn(BIN, ['--socket', SOCK, '--auth', 'none', '--disable-telemetry', '--disable-update-check',
      '--disable-workspace-trust', '/workspace'], { stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { PASSWORD: '' }) });
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', (d) => { const t = String(d).trim(); if (/error/i.test(t)) log(t.slice(0, 300)); });
    proc.on('exit', (c) => { log('code-server exited', c); proc = null; starting = null; });
    for (let i = 0; i < 100; i++) {
      if (await alive()) { log('code-server up'); installExtensions(); return; }
      if (!proc) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('code-server did not start');
  })().catch((e) => { starting = null; throw e; });
  return starting;
}

const strip = (url) => url.replace(/^\/code(?=\/|\?|$)/, '') || '/';

// plain HTTP: /code/... -> code-server
function proxy(req, res) {
  if (req.url === '/code' || req.url.startsWith('/code?')) {
    res.writeHead(302, { location: '/code/' + req.url.slice(5) }); res.end(); return;
  }
  ensure().then(() => {
    const up = http.request({ socketPath: SOCK, method: req.method, path: strip(req.url), headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    up.on('error', () => { try { if (!res.headersSent) res.writeHead(502); res.end('VS Code is not reachable'); } catch (_) {} });
    req.pipe(up);
  }, (e) => { try { res.writeHead(503, { 'content-type': 'text/plain' }); res.end(e.message); } catch (_) {} });
}

// WebSocket upgrade: the raw request goes through as is, with the prefix stripped
function upgrade(req, socket, head) {
  ensure().then(() => {
    const up = net.connect(SOCK, () => {
      const lines = [`${req.method} ${strip(req.url)} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      socket.pipe(up); up.pipe(socket);
    });
    up.setNoDelay(true); socket.setNoDelay(true);
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  }, () => socket.destroy());
}

// VS Code follows the launcher's light/dark theme: the color theme is written to code-server's user
// settings, which open windows pick up live. Only that key (and the OS auto-detect, which would
// override it) is touched; a settings file that is not plain JSON (comments) is left alone.
const SETTINGS = path.join(HOME, '.local', 'share', 'code-server', 'User', 'settings.json');
const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern' };
function setTheme(mode) {
  const theme = THEMES[mode];
  if (!theme) throw new Error('theme: dark or light');
  let o = {};
  try { o = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return false; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (o['workbench.colorTheme'] === theme && o['window.autoDetectColorScheme'] === false) return true;
  o['workbench.colorTheme'] = theme; o['window.autoDetectColorScheme'] = false;
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  const tmp = SETTINGS + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + '\n'); fs.renameSync(tmp, SETTINGS);
  return true;
}

function stop() { if (proc) try { proc.kill('SIGTERM'); } catch (_) {} }

module.exports = { enabled, ensure, proxy, upgrade, stop, strip, setTheme };
