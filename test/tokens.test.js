'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isGenericLabel, tabLabel, workspaceTokens, paneTokens, windowTitle } = require('../lib/tokens');
const { issueFromBranch, scanRefs, parseRepo, isTrunk } = require('../lib/github');

test('generic tab labels fall back to the agent title', () => {
  assert.equal(isGenericLabel('1'), true);
  assert.equal(isGenericLabel('claude'), true);
  assert.equal(isGenericLabel('claude ui'), false);
  const panes = [{ tab_id: 'w1:t1', agent: 'claude', terminal_title_stripped: 'Fix login race' }];
  assert.equal(tabLabel({ tab_id: 'w1:t1', label: 'claude' }, panes), 'Fix login race');
  assert.equal(tabLabel({ tab_id: 'w1:t1', label: 'api' }, panes), 'api');
});

test('workspace tokens nest tabs with status glyphs and clear unused slots', () => {
  const ws = { workspace_id: 'w1' };
  const tabs = [
    { tab_id: 'w1:t2', workspace_id: 'w1', number: 2, label: 'web', agent_status: 'blocked' },
    { tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: 'api', agent_status: 'working' },
    { tab_id: 'w2:t1', workspace_id: 'w2', number: 1, label: 'other', agent_status: 'idle' },
  ];
  const t = workspaceTokens(ws, tabs, []);
  assert.equal(t.tab1, '├ ◐ api');
  assert.equal(t.tab2, '└ ● web');
  assert.equal(t.tab3, null);
  assert.equal(Object.keys(t).length, 14);
});

test('pane tokens merge branch PR, closing issues, branch issue and seen URLs', () => {
  const git = { repo: 'me/app', branch: 'fix/138-login' };
  const t = paneTokens({
    git,
    pr: { number: 142, state: 'merged', closes: [138] },
    branchIssue: 138,
    seen: [
      { repo: 'me/app', kind: 'pr', n: 142 },
      { repo: 'me/app', kind: 'issue', n: 150 },
      { repo: 'me/lib', kind: 'pr', n: 7 },
    ],
  });
  assert.deepEqual(t, {
    branch: '⎇ fix/138-login',
    pr: 'PR #142 lib#7',
    pr_state: 'merged',
    issues: 'Issues #138 #150',
  });
  assert.deepEqual(paneTokens({ git: null, pr: null }), { branch: null, pr: null, pr_state: null, issues: null });
});

test('branch issue numbers must be whole segments', () => {
  assert.equal(issueFromBranch('fix/138-login'), 138);
  assert.equal(issueFromBranch('issue-42'), 42);
  assert.equal(issueFromBranch('feat/gh-7_x'), 7);
  assert.equal(issueFromBranch('v2-fix'), null);
  assert.equal(issueFromBranch('feat/2fa'), null);
  assert.equal(issueFromBranch('main'), null);
});

test('scanRefs finds PR and issue URLs, last mention wins order', () => {
  const refs = scanRefs('see https://github.com/me/app/pull/3 and https://github.com/me/app/issues/9 then https://github.com/me/app/pull/3');
  assert.deepEqual(refs, [
    { repo: 'me/app', kind: 'issue', n: 9 },
    { repo: 'me/app', kind: 'pr', n: 3 },
  ]);
});

test('repo parsing and trunk detection', () => {
  assert.equal(parseRepo('git@github.com:me/app.git\n'), 'me/app');
  assert.equal(parseRepo('https://github.com/me/app\n'), 'me/app');
  assert.equal(parseRepo('https://gitlab.com/me/app.git'), null);
  assert.equal(isTrunk({ branch: 'develop', defaultBranch: 'develop' }), true);
  assert.equal(isTrunk({ branch: 'feat/x', defaultBranch: 'main' }), false);
});

test('window title format', () => {
  assert.equal(windowTitle('{session} › {workspace}', { session: 'restful', workspace: 'site' }), 'restful › site');
  assert.equal(windowTitle('Herdr: {session} > {agent}', { session: 'restful', agent: 'Fix login race' }), 'Herdr: restful > Fix login race');
});

test('agents nest under spaces, both ordered by priority', () => {
  const { agentGroupTokens } = require('../lib/tokens');
  const snap = {
    workspaces: [
      { workspace_id: 'w1', number: 1, label: 'api' },
      { workspace_id: 'w2', number: 2, label: 'web' },
    ],
    tabs: [
      { tab_id: 'w1:t1', number: 1 },
      { tab_id: 'w1:t2', number: 2 },
      { tab_id: 'w2:t1', number: 1 },
      { tab_id: 'w2:t2', number: 2 },
    ],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'claude', agent_status: 'idle' },
      { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t2', agent: 'codex', agent_status: 'working' },
      { pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 'w2:t1', agent: 'claude', agent_status: 'idle' },
      { pane_id: 'w2:p2', workspace_id: 'w2', tab_id: 'w2:t2', agent: 'claude', agent_status: 'blocked' },
      { pane_id: 'w1:p3', workspace_id: 'w1', tab_id: 'w1:t1' },
    ],
    agents: [
      { pane_id: 'w1:p1', state_change_seq: 5 },
      { pane_id: 'w1:p2', state_change_seq: 9 },
      { pane_id: 'w2:p1', state_change_seq: 20 },
      { pane_id: 'w2:p2', state_change_seq: 3 },
    ],
  };
  const g = agentGroupTokens(snap);
  const order = [...g.keys()].sort((a, b) => (g.get(a).gsort < g.get(b).gsort ? -1 : 1));
  // web holds the blocked agent, so it leads; inside each space, most urgent first.
  assert.deepEqual(order, ['w2:p2', 'w2:p1', 'w1:p2', 'w1:p1']);
  assert.equal(g.get('w2:p2').group, 'web');
  assert.equal(g.get('w2:p2').gap, null); // no spacer above the first group
  assert.equal(g.get('w2:p1').group, null); // no blank line between agents of a space
  assert.equal(g.get('w2:p1').head, '\u200b  ○ claude'); // indents itself instead
  assert.equal(g.get('w2:p2').head, '● claude'); // under the header, Herdr indents it
  assert.equal(g.get('w1:p2').group, 'api');
  assert.equal(g.get('w1:p2').gap, '\u200b');
  assert.equal(g.has('w1:p3'), false);

  const flat = agentGroupTokens(snap, { nest: false });
  assert.deepEqual(flat.get('w1:p1'), { gsort: null, gap: null, group: null, head: '○ claude', space: 'api' });
});

test('wrap breaks on words, splits long words, ellipsises overflow', () => {
  const { wrap } = require('../lib/live');
  assert.deepEqual(wrap('Investigate inconsistent lamp health reports', 16, 4), ['Investigate', 'inconsistent', 'lamp health', 'reports']);
  assert.deepEqual(wrap('abcdefghij', 4, 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrap('one two three four five', 5, 2), ['one', 'two…']);
  assert.deepEqual(wrap('', 10, 4), []);
});

test('only the selected agent gets wrapped activity and details', () => {
  const { liveTokens } = require('../lib/live');
  const pane = { terminal_title_stripped: 'Investigate inconsistent lamp health' };
  const details = { branch: '⎇ main', pr: 'PR #4', pr_state: null, issues: null };
  const off = liveTokens(pane, { selected: false, details, width: 16, detailsMode: 'selected' });
  assert.deepEqual(off, { desc1: 'Investigate inconsistent lamp health', desc2: null, desc3: null, desc4: null, branch: null, pr: null, pr_state: null, issues: null });
  const on = liveTokens(pane, { selected: true, details, width: 16, detailsMode: 'selected' });
  assert.equal(on.desc1, 'Investigate');
  assert.equal(on.desc3, 'lamp health');
  assert.equal(on.branch, '⎇ main');
  assert.equal(liveTokens(pane, { selected: false, details, width: 16, detailsMode: 'always' }).pr, 'PR #4');
});
