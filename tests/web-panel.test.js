'use strict';
// scripts/web-panel.js: which MCP tools the read-only "Today" run may call. It reads untrusted
// mail and chat, so anything that is not clearly a read is refused.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const { isReadTool } = require('../scripts/web-panel.js');

test('reads of the connected sources are allowed', () => {
  for (const n of ['mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_thread',
    'mcp__claude_ai_Google_Calendar__list_events', 'mcp__claude_ai_Slack__slack_search_public',
    'mcp__claude_ai_Slack__slack_read_channel', 'mcp__atlassian__searchJiraIssuesUsingJql',
    'mcp__atlassian__getJiraIssue', 'mcp__atlassian__fetch', 'mcp__atlassian__atlassianUserInfo']) {
    assert.strictEqual(isReadTool(n), true, n);
  }
});

test('writes, built-ins and odd names are refused', () => {
  for (const n of ['mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Slack__slack_send_message',
    'mcp__atlassian__createJiraIssue', 'mcp__atlassian__addCommentToJiraIssue', 'mcp__atlassian__editJiraIssue',
    'mcp__s__get_and_send', 'mcp__s__fetchAndPost', 'mcp__s__getThenDelete',
    'mcp__evil__x__getThing',          // "__" inside the server part: the tool is really "x__getThing"
    'mcp__s__get_thing__delete', 'mcp__s__sendGet', 'Bash', 'Read', 'WebFetch', '', null]) {
    assert.strictEqual(isReadTool(n), false, String(n));
  }
});
