#!/usr/bin/env node
'use strict';

// Repaints every token this plugin owns, then the window title.
//
// Hooks fire in bursts (one status change per pane, several per second while
// agents work), so runs are serialised per session: a run that finds another
// in progress leaves a "dirty" mark and exits, and the running one goes round
// once more when it finishes.

const fs = require('node:fs');

const { call, snapshot } = require('../lib/ipc');
const { SOURCE, stateFile, readJson, writeJson } = require('../lib/session');
const { gitInfo, isTrunk, prForBranch, issueFromBranch, scanRefs } = require('../lib/github');
const { paneTokens, workspaceTokens } = require('../lib/tokens');
const { applyTitle } = require('../lib/title');

const PR_TTL_MS = 60_000;
const LOCK_STALE_MS = 60_000;
const SCAN_LINES = 400;
const SEEN_CAP = 8;

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

  const agentPanes = snap.panes.filter((p) => p.agent);
  const liveKeys = new Set();

  const paneJobs = agentPanes.map(async (pane) => {
    // Keyed by the agent's own session id so history survives a pane move.
    const key = pane.agent_session?.value ?? pane.pane_id;
    liveKeys.add(key);

    const info = await git(pane.foreground_cwd ?? pane.cwd);
    const branchPr = info?.repo && !isTrunk(info) ? await pr(info) : null;

    let text = '';
    try {
      const read = await call('pane.read', { pane_id: pane.pane_id, source: 'recent', lines: SCAN_LINES });
      text = read.read?.text ?? '';
    } catch {
      // Unreadable pane: keep what was seen before.
    }
    const seen = mergeSeen(state.seen[key] ?? [], scanRefs(text));
    state.seen[key] = seen;

    const tokens = paneTokens({
      git: info,
      pr: branchPr?.none ? null : branchPr,
      seen,
      branchIssue: info && !isTrunk(info) ? issueFromBranch(info.branch) : null,
    });
    await report(state, repaint, `pane:${pane.pane_id}`, tokens, () =>
      call('pane.report_metadata', { pane_id: pane.pane_id, source: SOURCE, tokens }),
    );
  });

  const wsJobs = snap.workspaces.map((ws) => {
    const tokens = workspaceTokens(ws, snap.tabs, snap.panes);
    return report(state, repaint, `ws:${ws.workspace_id}`, tokens, () =>
      call('workspace.report_metadata', { workspace_id: ws.workspace_id, source: SOURCE, tokens }),
    );
  });

  const results = await Promise.allSettled([...paneJobs, ...wsJobs, applyTitle(snap)]);
  for (const r of results) if (r.status === 'rejected') console.error(`herdr-glance: ${r.reason?.message ?? r.reason}`);

  for (const key of Object.keys(state.seen)) if (!liveKeys.has(key)) delete state.seen[key];
  const liveIds = new Set([
    ...agentPanes.map((p) => `pane:${p.pane_id}`),
    ...snap.workspaces.map((w) => `ws:${w.workspace_id}`),
  ]);
  for (const id of Object.keys(state.reported)) if (!liveIds.has(id)) delete state.reported[id];
  for (const [key, entry] of Object.entries(state.prs)) if (now - entry.at > 24 * 3600_000) delete state.prs[key];
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

// Skip identical reports: each one makes Herdr redraw the sidebar.
async function report(state, repaint, id, tokens, send) {
  const sig = JSON.stringify(tokens);
  if (!repaint && state.reported[id] === sig) return;
  await send();
  state.reported[id] = sig;
}

async function main() {
  const lock = stateFile('lock').replace(/\.json$/, '.lock');
  const dirty = `${lock}.dirty`;
  if (!acquire(lock)) {
    fs.writeFileSync(dirty, '');
    return;
  }
  const file = stateFile('state');
  const state = { prs: {}, seen: {}, reported: {}, ...readJson(file, {}) };
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
  console.error(`herdr-glance refresh: ${err.message}`);
  process.exitCode = 1;
});
