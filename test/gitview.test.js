'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildGitModel, renderGitView } = require('../lib/gitview');

const git = (over) => ({
  top: '/w/app',
  common: '/w/app/.git',
  branch: 'main',
  repo: 'me/app',
  defaultBranch: 'main',
  ahead: 0,
  behind: 0,
  dirty: 0,
  ...over,
});

const agents = [
  { pane_id: 'p1', agent_status: 'blocked', agent: 'claude' },
  { pane_id: 'p2', agent_status: 'working', agent: 'codex' },
  { pane_id: 'p3', agent_status: 'idle', agent: 'claude' },
  { pane_id: 'p4', agent_status: 'idle', agent: 'claude' },
];
const details = {
  // A worktree of the same repo on a feature branch with its own PR.
  p1: {
    git: git({ top: '/w/app-wt', branch: 'fix/12-login', ahead: 2, behind: 1, dirty: 3 }),
    branchPr: { n: 40, state: 'open' },
    refs: { prs: [{ repo: 'me/app', n: 40 }], issues: [{ repo: 'me/app', n: 12 }] },
  },
  p2: { git: git(), refs: { prs: [{ repo: 'me/lib', n: 7 }], issues: [{ repo: 'me/app', n: 99 }] } },
  p3: { git: git({ top: '/w/other', common: '/w/other/.git', repo: null, branch: 'dev', defaultBranch: null }), refs: { prs: [], issues: [] } },
  p4: {},
};
const labels = { p1: 'login fix', p2: 'api', p3: 'scratch', p4: 'notes' };
const labelFor = (p) => labels[p.pane_id];

test('groups worktrees under one repo, links other repos, keeps loose agents', () => {
  const model = buildGitModel(agents, details);
  assert.deepEqual(
    model.repos.map((r) => [r.name, r.local]),
    [
      ['app', true],
      ['other', true],
      ['lib', false],
    ],
  );
  const app = model.repos[0];
  assert.deepEqual(app.branchList.map((b) => b.name), ['main', 'fix/12-login']); // default first
  const fix = app.branches.get('fix/12-login');
  assert.deepEqual([fix.ahead, fix.behind, fix.dirty, fix.pr.n], [2, 1, 3, 40]);
  assert.deepEqual(fix.closes, [12]); // moved onto the branch with the PR
  assert.deepEqual([...app.issues.keys()], [99]); // the unrelated issue stays on the repo
  assert.deepEqual(model.loose.map((p) => p.pane_id), ['p4']);
});

test('renders a selectable line per agent, with PR titles and states', () => {
  const model = buildGitModel(agents, details);
  const meta = { 'me/app#40': { state: 'draft', title: 'Fix login race' }, 'me/lib#7': { state: 'merged', title: 'Bump' } };
  const { lines, agentLines } = renderGitView(model, { labelFor, selected: 'p2', meta });
  const text = lines.map((segs) => segs.map(([t]) => t).join(''));
  assert.ok(text.some((l) => l.includes('⎇ fix/12-login') && l.includes('↑2') && l.includes('↓1') && l.includes('✚3')));
  assert.ok(text.some((l) => l.includes('PR #40') && l.includes('closes #12') && l.includes('Fix login race')));
  assert.ok(text.some((l) => l.includes('PR #7 merged') && l.includes('← api') && l.includes('Bump')));
  assert.ok(text.some((l) => l.includes('linked, not checked out here')));
  assert.deepEqual([...new Set(agentLines.values())], ['p2', 'p1', 'p3', 'p4']); // git-view order
  const selectedLine = [...agentLines].find(([, id]) => id === 'p2')[0];
  assert.ok(text[selectedLine].startsWith('▸'));
});
