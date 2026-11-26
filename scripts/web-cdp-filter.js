'use strict';
// One session's view of the box browser over DevTools: Claude's playwright tools in a session connect
// here (web-browser.js serves it at 127.0.0.1:<CB_BROWSER_SESSION_PORT>/s/<session>) instead of to
// Chromium itself, and see only the tabs of that session's own window. The user's other windows
// (other sessions, the shared Slack window) are never listed, attached or closed from here, and a
// new page opens as a tab in the session's window.
//
// It sits between one client connection and one browser connection, both carrying DevTools JSON
// messages (flat sessions). The scope comes from outside:
//   inScope(targetId) -> Promise<bool>  is this page in the session's windows
//   claim(targetId)                     a page this session opened (a popup) joins its windows
//   createTab(url) -> Promise<targetId> a new tab in the session's window (made if it has none)
const NOT_HERE = 'This tab belongs to another claude-box session (or to the shared window).';
const BLOCKED = new Set(['Browser.close', 'Browser.crash', 'Browser.crashGpuProcess', 'Target.disposeBrowserContext']);
const INTERNAL = 1e9;

class Filter {
  constructor({ inScope, claim, createTab, toClient, toBrowser }) {
    Object.assign(this, { inScope, claim: claim || (() => {}), createTab, toClient, toBrowser });
    this.sessions = new Set();        // DevTools sessions of this client (pages in scope and their frames/workers)
    this.known = new Set();           // target ids shown to this client
    this.made = new Set();            // targets this client created
    this.pending = new Map();         // client request id -> method (for answers that need filtering)
    this.attachWait = new Map();      // targetId -> resolve, for createTarget's answer
    this.nextId = INTERNAL;
    this.cq = Promise.resolve(); this.bq = Promise.resolve();
  }
  // messages are handled in order per direction; each may wait on a scope lookup
  fromClient(o) { this.cq = this.cq.then(() => this._client(o)).catch(() => {}); return this.cq; }
  fromBrowser(o) { this.bq = this.bq.then(() => this._browser(o)).catch(() => {}); return this.bq; }

  reply(o, result) { this.toClient(Object.assign({ id: o.id, result }, o.sessionId ? { sessionId: o.sessionId } : {})); }
  fail(o, message) { this.toClient(Object.assign({ id: o.id, error: { code: -32000, message } }, o.sessionId ? { sessionId: o.sessionId } : {})); }
  internal(method, params, sessionId) { this.toBrowser(Object.assign({ id: ++this.nextId, method, params: params || {} }, sessionId ? { sessionId } : {})); }

  async allowed(info) {
    if (!info || info.type !== 'page') return false;
    if (this.known.has(info.targetId) || this.made.has(info.targetId)) return true;
    if (info.openerId && this.known.has(info.openerId)) { this.claim(info.targetId); return true; }
    return !!(await this.inScope(info.targetId));
  }

  async _client(o) {
    if (!o || typeof o !== 'object') return;
    if (o.sessionId) {
      if (!this.sessions.has(o.sessionId)) { this.fail(o, NOT_HERE); return; }
      this.toBrowser(o); return;
    }
    const p = o.params || {};
    if (BLOCKED.has(o.method)) { this.fail(o, 'The box browser is shared by every session; it is not closed from one.'); return; }
    if (o.method === 'Target.createTarget' && !p.browserContextId) {
      let id;
      try { id = await this.createTab(p.url || 'about:blank'); } catch (e) { this.fail(o, e.message); return; }
      this.made.add(id);
      // the browser announces a new page before it answers createTarget; keep that order
      if (!this.known.has(id)) await new Promise((res) => { this.attachWait.set(id, res); setTimeout(res, 5000); });
      this.attachWait.delete(id);
      this.reply(o, { targetId: id });
      return;
    }
    if (p.targetId && o.method !== 'Target.createTarget' && !(await this.allowed({ targetId: p.targetId, type: 'page' }))) { this.fail(o, NOT_HERE); return; }
    if (o.method === 'Target.getTargets' || o.method === 'Target.createTarget') this.pending.set(o.id, o.method);
    this.toBrowser(o);
  }

  async _browser(o) {
    if (!o || typeof o !== 'object') return;
    if (o.id !== undefined) {
      if (o.id > INTERNAL) return;
      const m = this.pending.get(o.id); this.pending.delete(o.id);
      if (m === 'Target.getTargets' && o.result && Array.isArray(o.result.targetInfos)) {
        const keep = [];
        for (const t of o.result.targetInfos) if (await this.allowed(t)) keep.push(t);
        o.result.targetInfos = keep;
      }
      if (m === 'Target.createTarget' && o.result && o.result.targetId) this.made.add(o.result.targetId);
      this.toClient(o); return;
    }
    if (o.sessionId) {
      if (!this.sessions.has(o.sessionId)) return;
      if (o.method === 'Target.attachedToTarget') this.sessions.add(o.params.sessionId);       // its frames and workers
      if (o.method === 'Target.detachedFromTarget') this.sessions.delete(o.params.sessionId);
      this.toClient(o); return;
    }
    const p = o.params || {};
    switch (o.method) {
      case 'Target.attachedToTarget': {
        if (await this.allowed(p.targetInfo)) {
          this.sessions.add(p.sessionId); this.known.add(p.targetInfo.targetId);
          this.toClient(o);
          const w = this.attachWait.get(p.targetInfo.targetId); if (w) w();
        } else {
          // not this session's: let the page run on and let go of it, unseen
          if (p.waitingForDebugger) this.internal('Runtime.runIfWaitingForDebugger', {}, p.sessionId);
          this.internal('Target.detachFromTarget', { sessionId: p.sessionId });
        }
        return;
      }
      case 'Target.detachedFromTarget':
        if (this.sessions.delete(p.sessionId)) this.toClient(o);
        return;
      case 'Target.targetCreated': case 'Target.targetInfoChanged':
        if (await this.allowed(p.targetInfo)) { this.known.add(p.targetInfo.targetId); this.toClient(o); }
        return;
      case 'Target.targetDestroyed': case 'Target.targetCrashed':
        if (this.known.has(p.targetId)) { if (o.method === 'Target.targetDestroyed') this.known.delete(p.targetId); this.toClient(o); }
        return;
      default:
        this.toClient(o);
    }
  }
}

module.exports = { Filter, NOT_HERE };
