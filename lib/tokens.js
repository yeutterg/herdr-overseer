'use strict';

// Pure functions from Herdr's snapshot (plus GitHub lookups) to the custom
// sidebar tokens this plugin reports. Kept free of I/O so they are testable.

const MAX_TABS = 14; // Space layouts allow 16 rows: one header, one spare.

// One status icon, used in both panels. Colours live in lib/layout.js.
const GLYPH = {
  blocked: '●', // needs you: red
  working: '◐',
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
  // Herdr lists tabs in their on-screen order. `number` is a fixed id that
  // survives reordering, so it must not be used for order.
  const mine = tabs.filter((t) => t.workspace_id === workspace.workspace_id);
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
// The PRs and issues an agent is linked to, as { prs, issues } lists of
// { repo, n }; repo is "owner/name" (null when the checkout is not on GitHub).
function collectRefs({ git, pr, seen = [], branchIssue = null }) {
  const home = git?.repo ?? null;
  const prs = [];
  const issues = [];
  const add = (list, ref) => {
    const r = { repo: ref.repo ?? home, n: ref.n };
    if (!list.some((x) => x.n === r.n && x.repo === r.repo)) list.push(r);
  };

  if (pr?.number) add(prs, { repo: home, n: pr.number });
  for (const n of pr?.closes ?? []) add(issues, { repo: home, n });
  if (branchIssue && !prs.some((r) => r.n === branchIssue)) add(issues, { repo: home, n: branchIssue });
  for (const ref of seen) add(ref.kind === 'pr' ? prs : issues, ref);
  return { prs, issues };
}

function paneTokens({ git, pr, seen = [], branchIssue = null }) {
  const home = git?.repo ?? null;
  const { prs, issues } = collectRefs({ git, pr, seen, branchIssue });

  return {
    branch: git?.branch && git.branch !== 'HEAD' ? `⎇ ${git.branch}` : null,
    pr: prs.length ? `PR ${prs.map((r) => shortRef(r, home)).join(' ')}` : null,
    pr_state: pr?.number && pr.state !== 'open' ? pr.state : null,
    issues: issues.length ? `${issues.length > 1 ? 'Issues' : 'Issue'} ${issues.map((r) => shortRef(r, home)).join(' ')}` : null,
  };
}

// The Agents panel nests agents under their space, as Herdr Radar did. Herdr
// has no grouping of its own, so the plugin (1) gives every agent a sort key
// that keeps each space's agents together, and (2) starts the first agent of
// each space with a space-name header. Herdr indents every line of an entry
// after its first, so the header stays flush left and the first agent sits
// under it; the others have no header and would start flush left, so their
// status line carries its own two-column indent. Herdr trims leading
// whitespace, but not after a zero-width space. The blank line between spaces
// trails the previous space's last agent, so a header is always a first line.
//
// Order is Herdr's own "priority" sort (src/app/agent_view.rs,
// tab_attention_priority) at both levels: blocked, then done (unseen), working,
// idle, unknown, the most recent state change first. A space ranks by its
// most urgent agent.
const ATTENTION = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };
const GAP = '\u200b'; // zero-width space: a row that renders empty
const INDENT = '\u200b  ';

// "◐ recovery mode": status icon and tab name. Tabs with generic names
// ("1", "claude") fall back to the agent's name; the live activity is on the
// next line anyway.
function headLine(pane, tab) {
  const glyph = GLYPH[pane.agent_status] ?? GLYPH.unknown;
  const label = tab && !isGenericLabel(tab.label) ? tab.label : pane.agent;
  return `${glyph} ${label}`;
}

// With nest = false the panel is left to Herdr's own order, so each agent
// carries its space name instead of a header.
function agentGroupTokens(snap, { nest = true } = {}) {
  const wsLabel = new Map(snap.workspaces.map((w) => [w.workspace_id, w.label]));
  // Positions, not `number`s: those are fixed ids that survive reordering.
  const wsNumber = new Map(snap.workspaces.map((w, i) => [w.workspace_id, i]));
  const tabNumber = new Map(snap.tabs.map((t, i) => [t.tab_id, i]));
  const tabById = new Map(snap.tabs.map((t) => [t.tab_id, t]));
  const seq = new Map((snap.agents ?? []).map((a) => [a.pane_id, a.state_change_seq ?? 0]));
  const pad = (n, w = 3) => String(n).padStart(w, '0');
  // Lower sorts first: attention, then newest state change, then tab order.
  const rank = (p) =>
    [ATTENTION[p.agent_status] ?? 4, pad(9_999_999_999 - (seq.get(p.pane_id) ?? 0), 10), pad(tabNumber.get(p.tab_id) ?? 999)].join('-');

  const panes = snap.panes.filter((p) => p.agent);
  const out = new Map();
  if (!nest) {
    for (const p of panes) {
      out.set(p.pane_id, {
        gsort: null,
        tail: null,
        group: null,
        head: headLine(p, tabById.get(p.tab_id)),
        space: wsLabel.get(p.workspace_id) ?? null,
      });
    }
    return out;
  }

  const groupRank = new Map();
  for (const p of panes) {
    const r = rank(p);
    if (!groupRank.has(p.workspace_id) || r < groupRank.get(p.workspace_id)) groupRank.set(p.workspace_id, r);
  }
  const agents = panes
    .map((p) => ({ pane: p, key: [groupRank.get(p.workspace_id), pad(wsNumber.get(p.workspace_id) ?? 999), rank(p)].join('|') }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  agents.forEach(({ pane, key }, i) => {
    const first = i === 0 || agents[i - 1].pane.workspace_id !== pane.workspace_id;
    const last = i < agents.length - 1 && agents[i + 1].pane.workspace_id !== pane.workspace_id;
    out.set(pane.pane_id, {
      gsort: key,
      tail: last ? GAP : null,
      group: first ? wsLabel.get(pane.workspace_id) ?? pane.workspace_id : null,
      head: `${first ? '' : INDENT}${headLine(pane, tabById.get(pane.tab_id))}`,
      space: null,
    });
  });
  return out;
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

module.exports = { GLYPH, MAX_TABS, agentGroupTokens, collectRefs, isGenericLabel, tabLabel, workspaceTokens, paneTokens, shortRef, windowTitle, truncate };
