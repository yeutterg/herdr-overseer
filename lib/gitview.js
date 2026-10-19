'use strict';

// The overview's git view: every repo the space's agents touch, the
// branches they sit on (ahead/behind the default branch, uncommitted files),
// which agent tab drives each branch, and the PRs and issues hanging off
// them, including PRs and issues in repos no agent has checked out ("linked").
//
// Pure: buildGitModel() groups refresh.js's cached details, renderGitView()
// lays the model out as lines of styled segments. bin/overview.js paints them.

const { GLYPH } = require('./tokens');

const ATTENTION = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };

const shortName = (slug) => (slug ? slug.split('/')[1] : null);
const baseName = (dir) => (dir ? dir.replace(/\/\.git\/?$/, '').split('/').pop() : null);

// agents: panes in priority order. details: refresh.js cache by pane id.
function buildGitModel(agents, details) {
  const repos = new Map(); // key -> repo
  const bySlug = new Map(); // "owner/name" -> repo, to file links under local repos

  const repoFor = (key, init) => {
    if (!repos.has(key)) repos.set(key, { key, branches: new Map(), prs: new Map(), issues: new Map(), agents: 0, ...init });
    const repo = repos.get(key);
    if (repo.slug && !bySlug.has(repo.slug)) bySlug.set(repo.slug, repo);
    return repo;
  };

  const loose = []; // agents outside any git checkout
  for (const pane of agents) {
    const d = details[pane.pane_id];
    const git = d?.git;
    if (!git) {
      loose.push(pane);
      continue;
    }
    const repo = repoFor(git.common ?? git.top, {
      name: shortName(git.repo) ?? baseName(git.common ?? git.top),
      slug: git.repo,
      local: true,
      defaultBranch: git.defaultBranch,
    });
    repo.agents += 1;
    const name = git.branch === 'HEAD' ? '(detached)' : git.branch;
    if (!repo.branches.has(name)) {
      repo.branches.set(name, {
        name,
        isDefault: name === git.defaultBranch,
        ahead: git.ahead,
        behind: git.behind,
        dirty: git.dirty,
        agents: [],
        pr: null,
        closes: [],
      });
    }
    const branch = repo.branches.get(name);
    branch.agents.push(pane);
    if (d.branchPr && !branch.pr) branch.pr = d.branchPr;
  }

  // PRs and issues: the branch's own PR (and what it closes) stays on the
  // branch; everything else is listed under its repo with who linked it.
  for (const pane of agents) {
    const d = details[pane.pane_id];
    if (!d?.refs) continue;
    const home = d.git?.repo ?? null;
    const branchPr = d.branchPr?.n;
    for (const kind of ['prs', 'issues']) {
      for (const ref of d.refs[kind]) {
        if (kind === 'prs' && ref.repo === home && ref.n === branchPr) continue;
        const repo = (ref.repo && bySlug.get(ref.repo)) || repoFor(`linked:${ref.repo}`, { name: shortName(ref.repo) ?? ref.repo, slug: ref.repo, local: false });
        const list = kind === 'prs' ? repo.prs : repo.issues;
        if (!list.has(ref.n)) list.set(ref.n, { n: ref.n, agents: [] });
        const entry = list.get(ref.n);
        if (!entry.agents.includes(pane)) entry.agents.push(pane);
      }
    }
  }

  const rank = (p) => ATTENTION[p.agent_status] ?? 4;
  const sorted = [...repos.values()].sort(
    (a, b) => Number(b.local) - Number(a.local) || b.agents - a.agents || a.name.localeCompare(b.name),
  );
  for (const repo of sorted) {
    repo.branchList = [...repo.branches.values()].sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        Math.min(...a.agents.map(rank)) - Math.min(...b.agents.map(rank)) ||
        a.name.localeCompare(b.name),
    );
    // Issues a branch PR closes move onto that branch.
    for (const branch of repo.branchList) {
      for (const pane of branch.agents) {
        const d = details[pane.pane_id];
        for (const ref of d?.refs?.issues ?? []) {
          if (ref.repo !== repo.slug || !branch.pr) continue;
          if (!branch.closes.includes(ref.n)) branch.closes.push(ref.n);
          repo.issues.delete(ref.n);
        }
      }
    }
  }
  return { repos: sorted, loose };
}

// Segment helpers: [text, style] pairs; a line is an array of segments.
const seg = (text, style = 'text') => [text, style];

function prStyle(state) {
  return { merged: 'pr-merged', closed: 'pr-closed', draft: 'pr-draft' }[state] ?? 'pr-open';
}

// Returns { lines, agentLines } where agentLines maps line index -> pane id
// (the lines you can select and jump from).
// meta: "owner/name#n" -> { state, title } from refresh.js (may be missing).
function renderGitView(model, { labelFor, selected, meta = {} }) {
  const lines = [];
  const agentLines = new Map();
  const push = (...segs) => lines.push(segs);
  const agentLine = (prefix, pane) => {
    const sel = pane.pane_id === selected;
    agentLines.set(lines.length, pane.pane_id);
    push(
      seg(sel ? '▸' : ' ', 'bold'),
      seg(prefix, 'tree'),
      seg(`${GLYPH[pane.agent_status] ?? GLYPH.unknown} `, `status-${pane.agent_status}`),
      seg(labelFor(pane), sel ? 'bold' : `status-${pane.agent_status}`),
    );
  };
  const who = (agents) => agents.map((p) => labelFor(p)).join(', ');

  if (!model.repos.length && !model.loose.length) {
    push(seg('  No agents in this space yet.', 'muted'));
    return { lines, agentLines };
  }

  for (const repo of model.repos) {
    const title = [seg(' '), seg(repo.local ? '■ ' : '□ ', repo.local ? 'repo' : 'muted'), seg(repo.name, 'repo')];
    if (repo.slug && repo.slug.split('/')[1] !== repo.name) title.push(seg(`  ${repo.slug}`, 'muted'));
    else if (repo.slug) title.push(seg(`  ${repo.slug.split('/')[0]}`, 'muted'));
    if (!repo.local) title.push(seg('  linked, not checked out here', 'muted'));
    push(...title);

    const extras = [...repo.prs.values()].length + [...repo.issues.values()].length;
    repo.branchList?.forEach((branch, bi) => {
      const lastBranch = bi === repo.branchList.length - 1 && !extras;
      const stem = lastBranch ? '   ' : ' │ ';
      const line = [seg(' '), seg(lastBranch ? ' └─' : ' ├─', 'tree'), seg(branch.isDefault ? '● ' : '⎇ ', branch.isDefault ? 'default' : 'branch'), seg(branch.name, branch.isDefault ? 'default' : 'branch')];
      if (branch.isDefault) line.push(seg('  default', 'muted'));
      if (branch.ahead) line.push(seg(`  ↑${branch.ahead}`, 'ahead'));
      if (branch.behind) line.push(seg(`  ↓${branch.behind}`, 'behind'));
      if (branch.dirty) line.push(seg(`  ✚${branch.dirty}`, 'dirty'));
      push(...line);
      for (const pane of branch.agents) agentLine(`${stem}   `, pane);
      if (branch.pr) {
        const pr = [seg(' '), seg(`${stem}   `, 'tree'), seg(`PR #${branch.pr.n}`, prStyle(branch.pr.state)), seg(`  ${branch.pr.state}`, prStyle(branch.pr.state))];
        if (branch.closes.length) pr.push(seg('  closes ', 'muted'), seg(branch.closes.map((n) => `#${n}`).join(' '), 'issue'));
        const title = meta[`${repo.slug}#${branch.pr.n}`]?.title;
        if (title) pr.push(seg(`  ${title}`, 'muted'));
        push(...pr);
      }
    });

    const refs = [
      ...[...repo.prs.values()].map((r) => ({ ...r, kind: 'PR' })),
      ...[...repo.issues.values()].map((r) => ({ ...r, kind: 'Issue' })),
    ];
    // Open work first, then merged/closed.
    const done = (ref) => ['merged', 'closed'].includes(meta[`${repo.slug}#${ref.n}`]?.state);
    refs.sort((a, b) => Number(done(a)) - Number(done(b)));
    refs.forEach((ref, i) => {
      const last = i === refs.length - 1;
      const m = meta[`${repo.slug}#${ref.n}`];
      const style = ref.kind === 'PR' ? prStyle(m?.state) : m?.state === 'closed' ? 'muted' : 'issue';
      const line = [seg(' '), seg(repo.local ? (last ? ' └─' : ' ├─') : '   ', 'tree'), seg(`${ref.kind} #${ref.n}`, style)];
      if (m?.state && m.state !== 'open') line.push(seg(` ${m.state}`, style));
      line.push(seg('  ← ', 'muted'), seg(who(ref.agents), 'muted'));
      if (m?.title) line.push(seg(`  ${m.title}`, 'text'));
      push(...line);
    });
    push();
  }

  if (model.loose.length) {
    push(seg(' '), seg('○ ', 'muted'), seg('not in a git repo', 'muted'));
    for (const pane of model.loose) agentLine('     ', pane);
  }
  return { lines, agentLines };
}

module.exports = { buildGitModel, renderGitView };
