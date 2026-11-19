'use strict';
// Voice alerts stay quiet during a calendar meeting: web-panel.js inMeeting() on a fake snapshot.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-meet-'));
const FILE = path.join(dir, 'web-panel.json');
process.env.WEB_PANEL_FILE = FILE;
const panel = require('../scripts/web-panel.js');
const at = (min) => new Date(Date.parse('2026-11-19T10:00:00Z') + min * 60000).toISOString();
const now = Date.parse('2026-11-19T10:00:00Z');
const snap = (calendar) => fs.writeFileSync(FILE, JSON.stringify({ calendar }));

test('a meeting in progress mutes, others do not', () => {
  snap([{ title: 'Standup', start: at(-10), end: at(20) }]);
  assert.deepStrictEqual(panel.inMeeting(now), { title: 'Standup', end: at(20) });
  snap([{ title: 'Later', start: at(30), end: at(60) }, { title: 'Done', start: at(-60), end: at(-5) }]);
  assert.strictEqual(panel.inMeeting(now), null);
  snap([{ title: 'Soon', start: at(0.5), end: at(30) }]);                 // starts within a minute
  assert.ok(panel.inMeeting(now));
  snap([{ title: 'OOO', start: at(-600), end: at(600), allDay: true }, { title: 'No', start: at(-5), end: at(25), declined: true }]);
  assert.strictEqual(panel.inMeeting(now), null);
  snap([{ title: 'No end', start: at(-20) }]);                             // taken as 30 minutes
  assert.ok(panel.inMeeting(now));
  fs.unlinkSync(FILE);
  assert.strictEqual(panel.inMeeting(now), null);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
