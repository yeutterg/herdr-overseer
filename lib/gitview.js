'use strict';

// The overview's git view: one tree per repo the space's agents work in.
//
// A plain nested tree: the repo, its default branch, and each branch under
// it with how far ahead/behind the default branch it is; under each branch
// the agent tabs working on it, its PR and its worktree. A branch stacked on
// another nests under that one. Repos come from refresh.js (trees-<session>.json): where
// agents run, the checkouts named in their output, and local clones of repos
// whose PRs they link, so an orchestrator agent shows up under the repos it
// actually edits.
//
// Pure: buildGitModel() places agents and PRs on branches, renderGitView()
// lays the model out as lines of styled segments. bin/overview.js paints them.

const os = require('node:os');

const { GLYPH } = require('./tokens');

const HOME = os.homedir();
const ATTENTION = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };

const shortName = (slug) => (slug ? slug.split('/')[1] : null);
const tilde = (p) => (p && p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p);
const rank = (p) => ATTENTION[p.agent_status] ?? 4;
const DONE = ['merged', 'closed'];

// agents: panes in priority order. details: refresh.js cache by pane id.
// trees: repoTree() results. meta: "owner/name#n" -> { state, title, head }.
function buildGitModel(agents, details, trees = [], meta = {}) {
  const repos = trees.map((tree) => ({
    tree,
    name: tree.name,
    slug: tree.slug,
    agents: new Set(),
    onBranch: new Map(), // branch name (default branch included) -> panes
    prsOn: new Map(), // branch name -> [{ n, state, title, agents }]
    prs: new Map(), // n -> { n, agents }, PRs with no branch here
    issues: new Map(),
  }));
  const bySlug = new Map(repos.filter((r) => r.slug).map((r) => [r.slug, r]));
  const byPath = new Map(); // checkout path -> { repo, branch }
  for (const repo of repos) {
    const shown = new Set(repo.tree.branches.map((b) => b.name));
    for (const w of repo.tree.worktrees) {
      byPath.set(w.path, { repo, branch: w.branch && shown.has(w.branch) ? w.branch : repo.tree.defaultBranch });
    }
  }
  const place = (repo, branch, pane) => {
    if (!repo.onBranch.has(branch)) repo.onBranch.set(branch, []);
    const list = repo.onBranch.get(branch);
    if (!list.includes(pane)) list.push(pane);
    repo.agents.add(pane);
  };

  const loose = [];
  const linked = new Map(); // slug -> { name, slug, prs, issues } for repos with no clone
  for (const pane of agents) {
    const d = details[pane.pane_id] ?? {};
    for (const kind of ['prs', 'issues']) {
      for (const ref of d.refs?.[kind] ?? []) {
        const m = meta[`${ref.repo}#${ref.n}`];
        const repo = bySlug.get(ref.repo);
        if (!repo) {
          if (!ref.repo) continue;
          if (!linked.has(ref.repo)) linked.set(ref.repo, { name: shortName(ref.repo), slug: ref.repo, prs: new Map(), issues: new Map() });
          addRef(linked.get(ref.repo)[kind], ref.n, pane);
          continue;
        }
        const branch = kind === 'prs' && m?.head && repo.tree.branches.some((b) => b.name === m.head) ? m.head : null;
        if (!branch) {
          addRef(repo[kind], ref.n, pane);
          continue;
        }
        if (!repo.prsOn.has(branch)) repo.prsOn.set(branch, new Map());
        addRef(repo.prsOn.get(branch), ref.n, pane);
        // Whoever links a PR is working on its branch.
        if (!repo.agents.has(pane)) place(repo, branch, pane);
      }
    }
    // Where it works: the checkouts it names, else (with no PR there either)
    // the one it runs in. Its own directory alone is weak evidence: agents
    // print it constantly.
    const cwd = d.git?.top ?? null;
    const named = (d.touched ?? []).filter((t) => t !== cwd && byPath.has(t));
    const placed = repos.some((r) => r.agents.has(pane));
    const places = named.length ? named : !placed && cwd && byPath.has(cwd) ? [cwd] : [];
    for (const top of places) {
      const { repo, branch } = byPath.get(top);
      place(repo, branch, pane);
    }
    if (!repos.some((r) => r.agents.has(pane))) loose.push(pane);
  }

  // Trees cover the whole session; keep the repos this space's agents use,
  // the one with the most urgent agent first.
  const used = repos.filter((r) => r.agents.size + r.prs.size + r.issues.size + r.prsOn.size);
  const urgency = (r) => Math.min(9, ...[...r.agents].map(rank));
  used.sort((a, b) => urgency(a) - urgency(b) || b.agents.size - a.agents.size || a.name.localeCompare(b.name));
  return { repos: used, linked: [...linked.values()], loose };
}

function addRef(map, n, pane) {
  if (!map.has(n)) map.set(n, { n, agents: [] });
  const entry = map.get(n);
  if (!entry.agents.includes(pane)) entry.agents.push(pane);
}

// Segment helpers: [text, style] pairs; a line is an array of segments.
const seg = (text, style = 'text') => [text, style];

function prStyle(state) {
  return { merged: 'pr-merged', closed: 'pr-closed', draft: 'pr-draft' }[state] ?? 'pr-open';
}

function age(at, now) {
  if (!at) return null;
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

// Branch nodes: roots and, under each, the branches stacked on it. Branches
// with agents or PRs (or such branches stacked on them) come first, then the
// most recently committed.
function branchForest(repo) {
  const branches = repo.tree.branches;
  const names = new Set(branches.map((b) => b.name));
  const kids = new Map();
  const roots = [];
  for (const b of branches) {
    if (b.parent && names.has(b.parent)) {
      if (!kids.has(b.parent)) kids.set(b.parent, []);
      kids.get(b.parent).push(b);
    } else roots.push(b);
  }
  const active = (b) => repo.onBranch.has(b.name) || repo.prsOn.has(b.name) || (kids.get(b.name) ?? []).some(active);
  const node = (b) => ({ branch: b, active: active(b), kids: sort((kids.get(b.name) ?? []).map(node)) });
  const sort = (list) => list.sort((a, b) => Number(b.active) - Number(a.active) || (b.branch.at ?? 0) - (a.branch.at ?? 0));
  return sort(roots.map(node));
}

const plural = (n, word) => `${n} ${word}`;

// Returns { lines, agentLines } where agentLines maps line index -> pane id
// (the lines you can select and jump from).
function renderGitView(model, { labelFor, selected, meta = {}, now = Date.now() }) {
  const lines = [];
  const agentLines = new Map();
  const push = (...segs) => lines.push(segs);
  // Every line starts with a one-column selection marker.
  const line = (prefix, ...segs) => push(seg(' '), seg(prefix, 'tree'), ...segs);
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
  const refSegs = (slug, kind, ref) => {
    const m = meta[`${slug}#${ref.n}`];
    const style = kind === 'PR' ? prStyle(m?.state) : m?.state === 'closed' ? 'muted' : 'issue';
    const out = [seg(`${kind} #${ref.n}`, style)];
    if (m?.state) out.push(seg(` ${m.state}`, style));
    if (m?.title) out.push(seg(`  ${m.title}`, 'text'));
    if (ref.agents?.length) out.push(seg(`  ← ${who(ref.agents)}`, 'muted'));
    return out;
  };
  const done = (slug) => (ref) => DONE.includes(meta[`${slug}#${ref.n}`]?.state);
  const openFirst = (slug, list) => list.sort((a, b) => Number(done(slug)(a)) - Number(done(slug)(b)));

  if (!model.repos.length && !model.linked.length && !model.loose.length) {
    line('  No agents in this space yet.');
    return { lines, agentLines };
  }

  for (const repo of model.repos) {
    const { tree } = repo;
    const title = [seg('■ ', 'repo'), seg(repo.name, 'repo')];
    if (repo.slug) title.push(seg(`  ${repo.slug.split('/')[0]}`, 'muted'));
    title.push(seg(`  ${tilde(tree.top)}`, 'muted'));
    line('', ...title);

    const forest = branchForest(repo);
    const refs = openFirst(repo.slug, [
      ...[...repo.prs.values()].map((r) => ({ ...r, kind: 'PR' })),
      ...[...repo.issues.values()].map((r) => ({ ...r, kind: 'Issue' })),
    ]);
    // The repo's children: the default branch, each branch, then PRs and
    // issues that are not on a branch here.
    const children = [{ type: 'default' }, ...forest.map((n) => ({ type: 'branch', node: n })), ...refs.map((r) => ({ type: 'ref', ref: r }))];

    const drawBranch = (node, prefix, last) => {
      const b = node.branch;
      const style = node.active ? 'branch' : 'muted';
      const head = [seg('⎇ ', style), seg(b.name, repo.onBranch.has(b.name) ? 'bold' : style)];
      const stats = [];
      if (b.parent) stats.push(seg(`  ${plural(b.aheadOfParent, 'ahead of')} ${b.parent}`, node.active ? 'ahead' : 'muted'));
      else if (b.ahead) stats.push(seg(`  ${plural(b.ahead, 'ahead')}`, node.active ? 'ahead' : 'muted'));
      if (b.behind) stats.push(seg(`  ${plural(b.behind, 'behind')} ${tree.defaultBranch}`, node.active ? 'behind' : 'muted'));
      if (!b.ahead && !b.behind) stats.push(seg(`  same as ${tree.defaultBranch}`, 'muted'));
      const a = age(b.at, now);
      if (a) stats.push(seg(`  · ${a} ago`, 'muted'));
      if (b.remoteOnly) stats.push(seg('  · on GitHub only', 'muted'));
      line(`${prefix}${last ? '└─ ' : '├─ '}`, ...head, ...stats);

      const inner = `${prefix}${last ? '   ' : '│  '}`;
      const detail = `${inner}${node.kids.length ? '│  ' : '   '}`;
      if (node.active) {
        for (const pane of repo.onBranch.get(b.name) ?? []) agentLine(detail, pane);
        const prs = openFirst(repo.slug, [...(repo.prsOn.get(b.name)?.values() ?? [])]);
        const here = repo.onBranch.get(b.name) ?? [];
        for (const pr of prs) line(detail, ...refSegs(repo.slug, 'PR', { ...pr, agents: pr.agents.filter((p) => !here.includes(p)) }));
        if (b.worktree) {
          const where = b.worktree === tree.top ? 'main checkout' : tilde(b.worktree);
          line(detail, seg(where, 'muted'), ...(b.dirty ? [seg(`  ${plural(b.dirty, 'uncommitted')}`, 'dirty')] : []));
        }
      }
      node.kids.forEach((k, i) => drawBranch(k, inner, i === node.kids.length - 1));
    };

    children.forEach((c, i) => {
      const last = i === children.length - 1;
      const prefix = `  ${last ? '└─ ' : '├─ '}`;
      const inner = `  ${last ? '   ' : '│  '}`;
      if (c.type === 'default') {
        const segs = [seg('● ', 'default'), seg(tree.defaultBranch, 'default'), seg('  default branch', 'muted')];
        const tipAge = age(tree.tip?.at, now);
        if (tipAge) segs.push(seg(`  · ${tipAge} ago`, 'muted'));
        if (tree.local?.behind || tree.local?.ahead) {
          const drift = [tree.local.behind && plural(tree.local.behind, 'behind'), tree.local.ahead && plural(tree.local.ahead, 'ahead')].filter(Boolean).join(', ');
          segs.push(seg(`  · local copy ${drift}`, 'behind'));
        }
        line(prefix, ...segs);
        for (const pane of repo.onBranch.get(tree.defaultBranch) ?? []) agentLine(`${inner}   `, pane);
      } else if (c.type === 'branch') {
        drawBranch(c.node, '  ', last);
      } else {
        line(prefix, ...refSegs(repo.slug, c.ref.kind, c.ref));
      }
    });
    push();
  }

  for (const repo of model.linked) {
    line('', seg('□ ', 'muted'), seg(repo.name, 'repo'), seg(`  ${repo.slug.split('/')[0]}`, 'muted'), seg('  no local clone', 'muted'));
    const refs = openFirst(repo.slug, [...[...repo.prs.values()].map((r) => ({ ...r, kind: 'PR' })), ...[...repo.issues.values()].map((r) => ({ ...r, kind: 'Issue' }))]);
    refs.forEach((r, i) => line(`  ${i === refs.length - 1 ? '└─ ' : '├─ '}`, ...refSegs(repo.slug, r.kind, r)));
    push();
  }

  if (model.loose.length) {
    line('', seg('○ ', 'muted'), seg('not in a git repo', 'muted'));
    for (const pane of model.loose) agentLine('   ', pane);
  }
  return { lines, agentLines };
}

module.exports = { buildGitModel, renderGitView };
