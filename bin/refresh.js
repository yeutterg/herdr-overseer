#!/usr/bin/env node
'use strict';

// Repaints every token this plugin owns, then the window title.
//
// Hooks fire in bursts (one status change per pane, several per second while
// agents work), so runs are serialised per session: a run that finds another
// in progress leaves a "dirty" mark and exits, and the running one goes round
// once more when it finishes.

const fs = require('node:fs');
const path = require('node:path');

const { call, snapshot } = require('../lib/ipc');
const { SOURCE, stateFile, readJson, writeJson, userConfig } = require('../lib/session');
const { run, gitInfo, defaultBranch, parseRepo, isTrunk, prForBranch, refMeta, issueFromBranch, scanRefs } = require('../lib/github');
const { paneTokens, collectRefs, isAgent } = require('../lib/tokens');
const { updateLive } = require('../lib/live');
const { touchedTops, findClones, repoTree } = require('../lib/repotree');
const { pruneNotes } = require('../lib/notes');

const AGENT_SORT = [{ field: { token: 'gsort' }, order: 'asc' }];
const PR_TTL_MS = 60_000;
// Titles and states of every linked PR/issue, for the overview's git view.
const META_TTL_MS = 10 * 60_000;
const META_DONE_TTL_MS = 24 * 3600_000; // merged or closed rarely changes
const LOCK_STALE_MS = 60_000;
const SEEN_CAP = 8;
const TOUCHED_CAP = 8;
const TREE_TTL_MS = 30_000;
const DEFAULT_TTL_MS = 24 * 3600_000;

const force = process.argv.includes('--force');
// Herdr loses reported tokens on restart, so a startup run repaints everything.
const repaintAll = force || process.env.HERDR_PLUGIN_EVENT === 'startup';

function acquire(lock) {
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
        fs.unlinkSync(lock);
        return acquire(lock);
      }
    } catch {
      return acquire(lock);
    }
    return false;
  }
}

async function refresh(state, { repaint }) {
  const snap = await snapshot();
  // Notes die with their tab. Not at startup: panes may still be restoring.
  if (process.env.HERDR_PLUGIN_EVENT !== 'startup') pruneNotes(snap);
  const now = Date.now();
  const gitByCwd = new Map();
  const git = (cwd) => {
    if (!gitByCwd.has(cwd)) gitByCwd.set(cwd, gitInfo(cwd));
    return gitByCwd.get(cwd);
  };
  const prByKey = new Map();
  const pr = (info) => {
    const key = `${info.top}@${info.branch}`;
    if (!prByKey.has(key)) {
      const cached = state.prs[key];
      prByKey.set(
        key,
        cached && !force && now - cached.at < PR_TTL_MS
          ? Promise.resolve(cached.pr)
          : prForBranch(info).then((result) => {
              // A failed lookup (offline, gh missing) keeps the last answer.
              if (result) state.prs[key] = { at: now, pr: result };
              return result ?? cached?.pr ?? null;
            }),
      );
    }
    return prByKey.get(key);
  };

  const agentPanes = snap.panes.filter(isAgent);
  const topCache = new Map();
  state.touched = state.touched ?? {};
  const nest = userConfig().nest_agents !== false;
  const liveKeys = new Set();
  const details = {};

  const paneJobs = agentPanes.map(async (pane) => {
    // Keyed by the agent's own session id so history survives a pane move.
    const key = pane.agent_session?.value ?? pane.pane_id;
    liveKeys.add(key);

    const info = await git(pane.foreground_cwd ?? pane.cwd);
    const branchPr = info?.repo && !isTrunk(info) ? await pr(info) : null;

    let text = '';
    try {
      // Only the visible screen: a longer read of an idle full-screen agent
      // (Claude Code, OpenCode) makes Herdr scroll its transcript up and back
      // to collect history, which you see as the pane jumping. Refs and
      // touched repos accumulate across refreshes instead.
      const read = await call('pane.read', { pane_id: pane.pane_id, source: 'visible' });
      text = read.read?.text ?? '';
    } catch {
      // Unreadable pane: keep what was seen before.
    }
    // Some agents (Codex) report their session id only after starting, so
    // history kept under the pane id moves over instead of being dropped.
    const seen = mergeSeen(state.seen[key] ?? state.seen[pane.pane_id] ?? [], scanRefs(text));
    state.seen[key] = seen;
    // Checkouts named in its output: the repos it really works in.
    const prevTouched = state.touched[key] ?? state.touched[pane.pane_id] ?? [];
    const found = await touchedTops(text, topCache);
    const touched = [...prevTouched.filter((t) => !found.includes(t)), ...found].slice(-TOUCHED_CAP);
    state.touched[key] = touched;

    // Branch, PR and issue lines are shown by lib/live.js, only for the
    // selected agent, so they are cached rather than reported here.
    const linked = {
      git: info,
      pr: branchPr?.none ? null : branchPr,
      seen,
      branchIssue: info && !isTrunk(info) ? issueFromBranch(info.branch) : null,
    };
    // Display strings for the sidebar, plus structured data for the
    // overview's git view.
    details[pane.pane_id] = {
      ...paneTokens(linked),
      git: info,
      branchPr: linked.pr?.number ? { n: linked.pr.number, state: linked.pr.state } : null,
      refs: collectRefs(linked),
      touched,
    };
  });

  // Views are transient, so a restarted server needs the order set again.
  // Turning nesting off hands the order back to Herdr's own agent_panel_sort.
  const viewChanged = repaint || state.nest !== nest;
  state.nest = nest;
  const view = !viewChanged
    ? []
    : nest
      ? [call('agent.view.set', { source: SOURCE, label: 'priority', sort: AGENT_SORT })]
      : [call('agent.view.clear', { source: SOURCE })];

  const results = await Promise.allSettled([...paneJobs, ...view]);
  for (const r of results) if (r.status === 'rejected') console.error(`herdr-overseer: ${r.reason?.message ?? r.reason}`);

  writeJson(stateFile('details'), details);
  await refreshMeta(state, details, now);
  await refreshTrees(state, details, now);
  // A restarted server lost every token, so forget what live.js last sent.
  if (repaint) writeJson(stateFile('live'), {});
  // Fresh snapshot: the lookups above can take a second or two.
  await updateLive(null, { forceTitle: true });

  for (const key of Object.keys(state.seen)) if (!liveKeys.has(key)) delete state.seen[key];
  for (const key of Object.keys(state.touched)) if (!liveKeys.has(key)) delete state.touched[key];
  for (const [key, entry] of Object.entries(state.prs)) if (now - entry.at > 24 * 3600_000) delete state.prs[key];
}

async function refreshMeta(state, details, now) {
  state.meta = state.meta ?? {};
  const wanted = new Map();
  for (const d of Object.values(details)) {
    for (const ref of d.refs?.prs ?? []) if (ref.repo) wanted.set(`${ref.repo}#${ref.n}`, { ...ref, kind: 'pr' });
    for (const ref of d.refs?.issues ?? []) if (ref.repo) wanted.set(`${ref.repo}#${ref.n}`, { ...ref, kind: 'issue' });
  }
  await Promise.all(
    [...wanted].map(async ([key, ref]) => {
      const cached = state.meta[key];
      const ttl = cached && ['merged', 'closed'].includes(cached.state) ? META_DONE_TTL_MS : META_TTL_MS;
      // Older entries have no PR branch, which the git view needs.
      const stale = ref.kind === 'pr' && cached && !('head' in cached);
      if (cached && !stale && !force && now - cached.at < ttl) return;
      const meta = await refMeta(ref.repo, ref.kind, ref.n);
      if (meta) state.meta[key] = { ...meta, at: now };
    }),
  );
  for (const key of Object.keys(state.meta)) if (!wanted.has(key)) delete state.meta[key];
  writeJson(stateFile('refmeta'), state.meta);
}

// The git view's repo trees: every repo an agent is in or touches, plus local
// clones of repos whose PRs agents link. Written to trees-<session>.json.
async function refreshTrees(state, details, now) {
  state.trees = state.trees ?? {};
  state.defaults = state.defaults ?? {};
  const meta = state.meta ?? {};
  const defaultFor = async (slug) => {
    const cached = state.defaults[slug];
    if (cached && now - cached.at < DEFAULT_TTL_MS) return cached.name;
    const name = await defaultBranch(slug);
    if (name) state.defaults[slug] = { at: now, name };
    return name ?? cached?.name ?? null;
  };
  const seeds = new Map(); // checkout top -> { wanted, touched }
  const seed = (top) => {
    if (!seeds.has(top)) seeds.set(top, { wanted: new Set(), touched: new Set() });
    return seeds.get(top);
  };
  const prHeads = new Map(); // slug -> branch names of linked PRs
  for (const d of Object.values(details)) {
    if (d.git?.top) {
      const s = seed(d.git.top);
      if (d.git.branch && d.git.branch !== 'HEAD') s.wanted.add(d.git.branch);
      s.touched.add(d.git.top);
    }
    for (const top of d.touched ?? []) seed(top).touched.add(top);
    for (const ref of d.refs?.prs ?? []) {
      const head = meta[`${ref.repo}#${ref.n}`]?.head;
      if (!ref.repo || !head) continue;
      if (!prHeads.has(ref.repo)) prHeads.set(ref.repo, new Set());
      prHeads.get(ref.repo).add(head);
    }
  }

  // Worktrees of one repo share a tree; group seeds by their git common dir.
  const groups = new Map();
  await Promise.all(
    [...seeds].map(async ([top, s]) => {
      const out = await run('git', ['-C', top, 'rev-parse', '--git-common-dir'], top, 3000);
      if (!out) return;
      const key = path.resolve(top, out.trim());
      if (!groups.has(key)) groups.set(key, { top, wanted: new Set(), touched: new Set() });
      const g = groups.get(key);
      for (const b of s.wanted) g.wanted.add(b);
      for (const t of s.touched) g.touched.add(t);
    }),
  );

  const build = async (key, g) => {
    const sig = JSON.stringify([[...g.wanted].sort(), [...g.touched].sort()]);
    const cached = state.trees[key];
    if (cached && cached.sig === sig && !force && now - cached.at < TREE_TTL_MS) return cached.tree;
    const tree = await repoTree(g.top, { ...g, defaultFor });
    if (tree) state.trees[key] = { at: now, sig, tree };
    return tree;
  };
  const trees = new Map();
  const addHeads = (g, slug) => {
    for (const head of prHeads.get(slug) ?? []) g.wanted.add(head);
  };
  // Each repo's slug, so the branches of PRs linked there are shown too.
  await Promise.all(
    [...groups.values()].map(async (g) => {
      addHeads(g, parseRepo(await run('git', ['-C', g.top, 'remote', 'get-url', 'origin'], g.top, 3000)));
    }),
  );
  await Promise.all([...groups].map(async ([key, g]) => trees.set(key, await build(key, g))));

  // Linked repos no agent is in: look for a clone next to the known ones.
  const known = new Set([...trees.values()].filter(Boolean).map((t) => t.slug));
  const missing = [...prHeads.keys()].filter((slug) => !known.has(slug));
  if (missing.length) {
    const roots = new Set([...trees.values()].filter(Boolean).map((t) => path.dirname(t.top)));
    const clones = findClones(roots);
    await Promise.all(
      missing.map(async (slug) => {
        const top = clones.get(slug);
        if (!top) return;
        const g = { top, wanted: new Set(prHeads.get(slug)), touched: new Set() };
        const tree = await build(path.join(top, '.git'), g);
        if (tree) trees.set(tree.key, tree);
      }),
    );
  }
  for (const key of Object.keys(state.trees)) if (!trees.has(key)) delete state.trees[key];
  writeJson(stateFile('trees'), [...trees.values()].filter(Boolean));
}

// Newest last, capped, de-duplicated.
function mergeSeen(prev, found) {
  const all = [...prev, ...found];
  const out = new Map();
  for (const ref of all) {
    const k = `${ref.repo}/${ref.kind}/${ref.n}`;
    out.delete(k);
    out.set(k, ref);
  }
  return [...out.values()].slice(-SEEN_CAP);
}

async function main() {
  const lock = stateFile('lock').replace(/\.json$/, '.lock');
  const dirty = `${lock}.dirty`;
  if (!acquire(lock)) {
    fs.writeFileSync(dirty, '');
    return;
  }
  const file = stateFile('state');
  const state = { prs: {}, seen: {}, ...readJson(file, {}) };
  delete state.reported; // from older versions
  try {
    let repaint = repaintAll;
    for (let pass = 0; pass < 3; pass++) {
      try {
        fs.unlinkSync(dirty);
      } catch {}
      await refresh(state, { repaint });
      repaint = false;
      if (!fs.existsSync(dirty)) break;
    }
  } finally {
    writeJson(file, state);
    fs.unlinkSync(lock);
  }
}

main().catch((err) => {
  console.error(`herdr-overseer refresh: ${err.message}`);
  process.exitCode = 1;
});
