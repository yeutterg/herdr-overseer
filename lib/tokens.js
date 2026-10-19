'use strict';

// Pure functions from Herdr's snapshot (plus GitHub lookups) to the custom
// sidebar tokens this plugin reports. Kept free of I/O so they are testable.

const MAX_TABS = 14; // Space layouts allow 16 rows: one header, one spare.

const GLYPH = {
  working: '●',
  blocked: '▲', // waiting on you
  done: '✔',
  idle: '○',
  unknown: '·',
};

const AGENT_NAMES = new Set(['claude', 'codex', 'gemini', 'pi', 'opencode', 'amp', 'droid', 'cursor', 'copilot', 'qwen', 'kimi']);

// Herdr names tabs "1", "2", … or after the agent that opened them, which
// says nothing about the work. Those fall back to the agent's terminal title.
function isGenericLabel(label) {
  const l = (label ?? '').trim().toLowerCase();
  return l === '' || /^\d+$/.test(l) || AGENT_NAMES.has(l);
}

function truncate(text, max) {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

function tabLabel(tab, panes, max = 32) {
  if (!isGenericLabel(tab.label)) return truncate(tab.label, max);
  const mine = panes.filter((p) => p.tab_id === tab.tab_id && p.terminal_title_stripped);
  const titled = mine.find((p) => p.agent) ?? mine[0];
  return truncate(titled ? titled.terminal_title_stripped : tab.label, max);
}

// { tab1: '├ ● api', …, tab14: null } — every slot present so stale ones clear.
function workspaceTokens(workspace, tabs, panes) {
  const mine = tabs.filter((t) => t.workspace_id === workspace.workspace_id).sort((a, b) => a.number - b.number);
  const tokens = {};
  for (let i = 0; i < MAX_TABS; i++) {
    const tab = mine[i];
    if (!tab) {
      tokens[`tab${i + 1}`] = null;
      continue;
    }
    const branch = i === Math.min(mine.length, MAX_TABS) - 1 ? '└' : '├';
    const glyph = GLYPH[tab.agent_status] ?? GLYPH.unknown;
    tokens[`tab${i + 1}`] = `${branch} ${glyph} ${tabLabel(tab, panes)}`;
  }
  return tokens;
}

// "#142" for this repo, "other-repo#142" for another one.
function shortRef(ref, homeRepo) {
  return ref.repo && ref.repo !== homeRepo ? `${ref.repo.split('/')[1]}#${ref.n}` : `#${ref.n}`;
}

// git: gitInfo() or null; pr: prForBranch() result or null; seen: scanRefs()
// accumulated for this pane; branchIssue: issueFromBranch().
function paneTokens({ git, pr, seen = [], branchIssue = null }) {
  const home = git?.repo ?? null;
  const prs = [];
  const issues = [];
  const add = (list, ref) => {
    if (!list.some((r) => r.n === ref.n && (r.repo ?? home) === (ref.repo ?? home))) list.push(ref);
  };

  if (pr?.number) add(prs, { repo: home, n: pr.number });
  for (const n of pr?.closes ?? []) add(issues, { repo: home, n });
  if (branchIssue && !prs.some((r) => r.n === branchIssue)) add(issues, { repo: home, n: branchIssue });
  for (const ref of seen) add(ref.kind === 'pr' ? prs : issues, ref);

  return {
    branch: git?.branch && git.branch !== 'HEAD' ? `⎇ ${git.branch}` : null,
    pr: prs.length ? `PR ${prs.map((r) => shortRef(r, home)).join(' ')}` : null,
    pr_state: pr?.number && pr.state !== 'open' ? pr.state : null,
    issues: issues.length ? `${issues.length > 1 ? 'Issues' : 'Issue'} ${issues.map((r) => shortRef(r, home)).join(' ')}` : null,
  };
}

function windowTitle(format, { session, workspace, tab, agent, hostname }) {
  return format
    .replace(/\{session\}/g, session ?? '')
    .replace(/\{workspace\}/g, workspace ?? '')
    .replace(/\{tab\}/g, tab ?? '')
    .replace(/\{agent\}/g, agent ?? '')
    .replace(/\{hostname\}/g, hostname ?? '')
    .trim();
}

module.exports = { GLYPH, MAX_TABS, isGenericLabel, tabLabel, workspaceTokens, paneTokens, shortRef, windowTitle, truncate };
