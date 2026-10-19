'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { buildGitModel, renderGitView } = require('../lib/gitview');
const { scanPaths, parseWorktrees } = require('../lib/repotree');

const branch = (over) => ({ ahead: 1, behind: 0, at: null, worktree: null, dirty: null, parent: null, aheadOfParent: null, remoteOnly: false, ...over });

// The orchestrator runs every agent; the work happens in fw's worktrees.
const trees = [
  {
    key: '/w/orch/.git',
    top: '/w/orch',
    slug: 'me/orch',
    name: 'orch',
    defaultBranch: 'main',
    base: 'origin/main',
    tip: { sha: 'abc1234', at: null },
    local: null,
    worktrees: [{ path: '/w/orch', branch: 'main' }],
    branches: [],
  },
  {
    key: '/w/fw/.git',
    top: '/w/fw',
    slug: 'me/fw',
    name: 'fw',
    defaultBranch: 'main',
    base: 'origin/main',
    tip: { sha: 'def5678', at: null },
    local: { ahead: 0, behind: 3 },
    worktrees: [
      { path: '/w/fw', branch: 'main' },
      { path: '/wt/ota', branch: 'feat/ota' },
      { path: '/wt/ota-2', branch: 'feat/ota-2' },
    ],
    branches: [
      branch({ name: 'feat/ota', ref: 'feat/ota', ahead: 4, behind: 10, worktree: '/wt/ota', dirty: 2 }),
      branch({ name: 'feat/ota-2', ref: 'feat/ota-2', ahead: 6, behind: 10, worktree: '/wt/ota-2', parent: 'feat/ota', aheadOfParent: 2 }),
      branch({ name: 'fix/old', ref: 'fix/old', ahead: 1, behind: 1 }),
    ],
  },
];

const agents = [
  { pane_id: 'p1', agent_status: 'blocked', agent: 'claude' },
  { pane_id: 'p2', agent_status: 'working', agent: 'codex' },
  { pane_id: 'p3', agent_status: 'idle', agent: 'claude' },
  { pane_id: 'p4', agent_status: 'idle', agent: 'claude' },
];
const details = {
  // Runs in the orchestrator but names a fw worktree: it belongs to fw.
  p1: { git: { top: '/w/orch' }, touched: ['/w/orch', '/wt/ota'], refs: { prs: [], issues: [] } },
  // Only links a PR; its branch is in fw, so it shows there.
  p2: { git: { top: '/w/orch' }, touched: ['/w/orch'], refs: { prs: [{ repo: 'me/fw', n: 9 }, { repo: 'me/web', n: 3 }], issues: [{ repo: 'me/fw', n: 12 }] } },
  // Names nothing else: stays in the repo it runs in.
  p3: { git: { top: '/w/orch' }, touched: [], refs: { prs: [], issues: [] } },
  p4: {},
};
const meta = {
  'me/fw#9': { state: 'draft', title: 'Stacked OTA', head: 'feat/ota-2' },
  'me/web#3': { state: 'merged', title: 'Web bit', head: 'x' },
};
const labels = { p1: 'ota', p2: 'api', p3: 'plan', p4: 'notes' };
const labelFor = (p) => labels[p.pane_id];

test('agents go under the repos they work in, not the one they run in', () => {
  const model = buildGitModel(agents, details, trees, meta);
  assert.deepEqual(model.repos.map((r) => r.name), ['fw', 'orch']); // fw has the blocked agent
  const fw = model.repos[0];
  assert.deepEqual(fw.onBranch.get('feat/ota').map((p) => p.pane_id), ['p1']);
  assert.deepEqual(fw.onBranch.get('feat/ota-2').map((p) => p.pane_id), ['p2']); // via its PR
  assert.deepEqual([...fw.prsOn.get('feat/ota-2').keys()], [9]);
  assert.deepEqual([...fw.issues.keys()], [12]);
  assert.deepEqual(model.repos[1].onBranch.get('main').map((p) => p.pane_id), ['p3']);
  assert.deepEqual(model.linked.map((r) => r.slug), ['me/web']);
  assert.deepEqual(model.loose.map((p) => p.pane_id), ['p4']);
});

test('renders a nested tree: branches, stacked branches, then their agents, PRs and worktrees', () => {
  const model = buildGitModel(agents, details, trees, meta);
  const { lines, agentLines } = renderGitView(model, { labelFor, selected: 'p2', meta });
  const text = lines.map((segs) => segs.map(([t]) => t).join(''));
  const fw = text.indexOf(' ■ fw  me  /w/fw');
  assert.deepEqual(text.slice(fw, fw + 13), [
    ' ■ fw  me  /w/fw',
    '   ├─ ● main  default branch  · local copy 3 behind',
    '   ├─ ⎇ feat/ota  4 ahead  10 behind main',
    '   │  │  ● ota',
    '   │  │  /wt/ota  2 uncommitted',
    '   │  └─ ⎇ feat/ota-2  2 ahead of feat/ota  10 behind main',
    '▸  │        ◐ api',
    '   │        PR #9 draft  Stacked OTA',
    '   │        /wt/ota-2',
    '   ├─ ⎇ fix/old  1 ahead  1 behind main',
    '   └─ Issue #12  ← api',
    '',
    ' ■ orch  me  /w/orch',
  ]);
  assert.ok(text.some((l) => l.includes('□ web') && l.includes('no local clone')));
  assert.ok(text.some((l) => l.includes('PR #3 merged  Web bit  ← api')));
  assert.deepEqual([...new Set(agentLines.values())], ['p1', 'p2', 'p3', 'p4']);
});

test('scanPaths finds absolute and ~ paths, most mentioned first', () => {
  const home = os.homedir();
  const paths = scanPaths(`cd ~/WIP/a && ls /Users/x/WIP/b/src/c.rs\n~/WIP/a again /home/y/z`);
  assert.deepEqual(paths, [`${home}/WIP/a`, '/Users/x/WIP/b/src/c.rs', '/home/y/z']);
});

test('parseWorktrees reads porcelain output', () => {
  const out = 'worktree /w/a\nHEAD 1\nbranch refs/heads/main\n\nworktree /w/b\nHEAD 2\ndetached\n';
  assert.deepEqual(parseWorktrees(out), [
    { path: '/w/a', branch: 'main' },
    { path: '/w/b', branch: null },
  ]);
});
