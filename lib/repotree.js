'use strict';

// The repos an agent actually works in, and the shape of each one's branches,
// for the overview's git view.
//
// An agent's own directory often says little: an orchestrator agent sits in
// one repo and edits others through worktrees elsewhere. So the directories
// it prints (paths in its output) count as the repos it touches, and PRs it
// links are found in a local clone of their repo when there is one.
//
// repoTree() describes one repo: its default branch, and every branch worth
// showing (those agents are on, PR branches, worktrees with recent commits),
// each with how far it is ahead of and behind the default branch, and the
// branch it is stacked on, if any.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run, parseRepo } = require('./github');

const HOME = os.homedir();
const RECENT_MS = 3 * 24 * 3600_000; // worktrees without agents show if this fresh
const MAX_BRANCHES = 14;
const MAX_PATHS = 40;

const PATH_RE = /(?:~|\/(?:Users|home)\/[\w.-]+)(?:\/[\w.@+-]+)+/g;

// Absolute paths in an agent's output, most mentioned first.
function scanPaths(text) {
  const counts = new Map();
  for (const [m] of (text ?? '').matchAll(PATH_RE)) {
    const p = m.startsWith('~') ? HOME + m.slice(1) : m;
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PATHS)
    .map(([p]) => p);
}

// The nearest existing directory at or above p, below $HOME.
function existingDir(p) {
  let dir = p.replace(/\/+$/, '');
  while (dir.startsWith(`${HOME}/`)) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {}
    dir = path.dirname(dir);
  }
  return null;
}

// Checkout root containing dir, or null. cache: dir -> top.
async function checkoutTop(dir, cache) {
  if (cache.has(dir)) return cache.get(dir);
  const out = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], dir, 3000);
  const top = out ? out.trim() : null;
  // A dotfiles repo at $HOME would claim every path; it is not "work".
  const result = top && top !== HOME ? top : null;
  cache.set(dir, result);
  return result;
}

// The checkouts an agent's output points into.
async function touchedTops(text, cache) {
  const dirs = new Set(scanPaths(text).map(existingDir).filter(Boolean));
  const tops = await Promise.all([...dirs].map((d) => checkoutTop(d, cache)));
  return [...new Set(tops.filter(Boolean))];
}

// "owner/name" -> main checkout, for clones sitting next to known repos
// (siblings of their directories). Reads .git/config; no git calls.
function findClones(roots) {
  const clones = new Map();
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      let config;
      try {
        config = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
      } catch {
        continue;
      }
      const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config);
      const slug = m && parseRepo(m[1]);
      if (slug && !clones.has(slug)) clones.set(slug, dir);
    }
  }
  return clones;
}

function parseWorktrees(out) {
  const list = [];
  let cur = null;
  for (const line of (out ?? '').split('\n')) {
    if (line.startsWith('worktree ')) list.push((cur = { path: line.slice(9), branch: null }));
    else if (cur && line.startsWith('branch refs/heads/')) cur.branch = line.slice(18);
  }
  return list;
}

// One repo's branches, relative to its default branch.
//   top     any checkout of the repo
//   wanted  branch names that must be shown (agents' branches, PR branches)
//   touched checkout tops agents work in (their dirty counts are wanted)
//   defaultFor  slug -> the default branch GitHub reports (a local
//               origin/HEAD goes stale when the default is changed)
async function repoTree(top, { wanted = new Set(), touched = new Set(), defaultFor = async () => null } = {}) {
  const git = (...args) => run('git', ['-C', top, ...args], top, 4000);
  const [common, remote, headRef, wtOut, refsOut] = await Promise.all([
    git('rev-parse', '--git-common-dir'),
    git('remote', 'get-url', 'origin'),
    git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD'),
    git('worktree', 'list', '--porcelain'),
    git('for-each-ref', '--format=%(refname)%09%(committerdate:unix)%09%(objectname:short)', 'refs/heads', 'refs/remotes/origin'),
  ]);
  if (common == null) return null;
  const key = path.resolve(top, common.trim());

  const refs = new Map(); // "main" / "origin/main" -> { at, sha }
  for (const line of (refsOut ?? '').split('\n').filter(Boolean)) {
    const [ref, at, sha] = line.split('\t');
    const name = ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
    refs.set(name, { at: Number(at) * 1000, sha });
  }
  const slug = parseRepo(remote);
  const reported = slug ? await defaultFor(slug) : null;
  let def = reported && refs.has(`origin/${reported}`) ? reported : headRef ? headRef.trim().replace(/^origin\//, '') : null;
  if (!def) def = ['main', 'master'].find((b) => refs.has(b)) ?? null;
  if (!def) return null;
  const base = refs.has(`origin/${def}`) ? `origin/${def}` : def;

  const worktrees = parseWorktrees(wtOut);
  const main = worktrees[0]?.path ?? top;
  const wtByBranch = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch, w.path]));
  const now = Date.now();

  // Branches to show: wanted ones, branches checked out where agents work,
  // and other worktrees with recent commits.
  const names = new Set();
  for (const name of wanted) if (refs.has(name) || refs.has(`origin/${name}`)) names.add(name);
  for (const w of worktrees) {
    if (!w.branch || w.branch === def) continue;
    const fresh = now - (refs.get(w.branch)?.at ?? 0) < RECENT_MS;
    if (touched.has(w.path) || fresh) names.add(w.branch);
  }
  names.delete(def);
  const refFor = (name) => (refs.has(name) ? name : `origin/${name}`);

  const branches = (
    await Promise.all(
      [...names].map(async (name) => {
        const ref = refFor(name);
        const counts = await git('rev-list', '--left-right', '--count', `${base}...${ref}`);
        if (!counts) return null;
        const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
        const worktree = wtByBranch.get(name) ?? null;
        let dirty = null;
        if (worktree && touched.has(worktree)) {
          const status = await run('git', ['-C', worktree, 'status', '--porcelain'], worktree, 4000);
          if (status != null) dirty = status.split('\n').filter(Boolean).length;
        }
        return { name, ref, remoteOnly: !refs.has(name), ahead, behind, at: refs.get(ref)?.at ?? null, worktree, dirty, parent: null, aheadOfParent: null };
      }),
    )
  ).filter(Boolean);

  // Wanted and agent branches first, then the freshest, within the cap.
  const keep = (b) => wanted.has(b.name) || (b.worktree && touched.has(b.worktree));
  branches.sort((a, b) => Number(keep(b)) - Number(keep(a)) || (b.at ?? 0) - (a.at ?? 0));
  branches.splice(MAX_BRANCHES);

  // Stacked branches: the parent is the branch with the most commits of its
  // own whose tip this branch contains.
  const byRef = new Map(branches.map((b) => [b.ref, b]));
  await Promise.all(
    branches.map(async (b) => {
      if (!b.ahead) return;
      const others = branches.filter((o) => o !== b && o.ahead && o.ahead < b.ahead).map((o) => o.ref);
      if (!others.length) return;
      const out = await git('for-each-ref', `--merged=${b.ref}`, '--format=%(refname:short)', ...others.map((r) => (refs.has(r) ? `refs/heads/${r}` : `refs/remotes/${r}`)));
      const parents = (out ?? '')
        .split('\n')
        .filter(Boolean)
        .map((r) => byRef.get(r))
        .filter(Boolean)
        .sort((x, y) => y.ahead - x.ahead);
      if (parents[0]) {
        b.parent = parents[0].name;
        b.aheadOfParent = b.ahead - parents[0].ahead;
      }
    }),
  );

  // The default branch: origin's tip, and the main checkout's local copy.
  let local = null;
  if (base !== def && refs.has(def)) {
    const counts = await git('rev-list', '--left-right', '--count', `${base}...${def}`);
    if (counts) {
      const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
      local = { ahead, behind };
    }
  }
  return {
    key,
    top: main,
    slug,
    name: path.basename(key.replace(/\/\.git\/?$/, '')) || path.basename(main),
    defaultBranch: def,
    base,
    tip: refs.get(base) ?? null,
    local,
    worktrees: worktrees.map((w) => ({ path: w.path, branch: w.branch })),
    branches,
  };
}

module.exports = { scanPaths, touchedTops, findClones, repoTree, parseWorktrees };
