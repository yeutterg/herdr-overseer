'use strict';

// The fast half of the plugin: everything derived from Herdr's snapshot alone
// (panel order, space headers, status icons, the Spaces tab list, activity
// lines, which agent is selected), which changes far more often than
// branches or PRs. Runs on focus hooks and on a timer (a tab-bar status
// command, the only periodic hook Herdr offers), so it must stay cheap:
// one snapshot, no git, no gh, and only changed tokens get reported.
//
// Every agent shows its activity on one line (Herdr truncates it). The
// selected agent instead gets it wrapped over up to MAX_DESC lines, plus its
// branch, PR and issue lines, which refresh.js caches in the details file.

const fs = require('node:fs');
const path = require('node:path');

const { call, snapshot } = require('./ipc');
const { SOURCE, configDir, stateFile, readJson, writeJson, userConfig } = require('./session');
const { applyTitle } = require('./title');
const { agentGroupTokens, workspaceTokens } = require('./tokens');

const MAX_DESC = 4;
const DETAIL_KEYS = ['branch', 'pr', 'pr_state', 'issues'];

// Herdr does not expose the sidebar's width, and auto-widens it for long
// space names, so wrap at the configured width: lines may end early on a
// wider sidebar, but are never cut off. `wrap_width` overrides.
function wrapWidth() {
  const configured = userConfig().wrap_width;
  if (configured) return configured;
  let sidebar = 26;
  try {
    const m = /^\s*sidebar_width\s*=\s*(\d+)/m.exec(fs.readFileSync(path.join(configDir(), 'config.toml'), 'utf8'));
    if (m) sidebar = Number(m[1]);
  } catch {}
  return sidebar - 3; // two columns of indent, one for the scrollbar
}

// Word wrap; a word longer than the line is split. The last line gets an
// ellipsis when text is left over.
function wrap(text, width, maxLines) {
  const words = (text ?? '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (let word of words) {
    while ([...word].length > width) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push([...word].slice(0, width).join(''));
      word = [...word].slice(width).join('');
    }
    if (!line) line = word;
    else if ([...line].length + 1 + [...word].length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    const last = [...lines[maxLines - 1]];
    lines[maxLines - 1] = `${last.slice(0, Math.max(0, width - 1)).join('')}…`;
  }
  return lines;
}

function liveTokens(pane, { selected, details, width, detailsMode }) {
  const tokens = {};
  const title = pane.terminal_title_stripped ?? '';
  const lines = selected ? wrap(title, width, MAX_DESC) : [title];
  for (let i = 0; i < MAX_DESC; i++) tokens[`desc${i + 1}`] = lines[i] || null;
  const showDetails = detailsMode === 'always' || selected;
  for (const k of DETAIL_KEYS) tokens[k] = showDetails ? details?.[k] ?? null : null;
  return tokens;
}

// forceTitle: focus hooks always re-set the window title in case Herdr
// rewrote it; the timer only sets it when it would change.
async function updateLive(snap, { forceTitle = false } = {}) {
  snap = snap ?? (await snapshot());
  const cfg = userConfig();
  const width = wrapWidth();
  const detailsMode = cfg.details ?? 'selected';
  const details = readJson(stateFile('details'), {});
  const groups = agentGroupTokens(snap, { nest: cfg.nest_agents !== false });
  const file = stateFile('live');
  const last = readJson(file, {});
  const next = {};
  // Only changed tokens are sent: every report makes Herdr redraw.
  const send = (id, tokens, report) => {
    const sig = JSON.stringify(tokens);
    if (last[id] === sig) {
      next[id] = sig;
      return null;
    }
    return report().then(() => {
      next[id] = sig;
    });
  };

  const jobs = snap.panes
    .filter((p) => p.agent)
    .map((pane) => {
      const tokens = {
        ...groups.get(pane.pane_id),
        ...liveTokens(pane, {
          selected: pane.pane_id === snap.focused_pane_id,
          details: details[pane.pane_id],
          width,
          detailsMode,
        }),
      };
      return send(`pane:${pane.pane_id}`, tokens, () =>
        call('pane.report_metadata', { pane_id: pane.pane_id, source: SOURCE, tokens }),
      );
    });
  const wsJobs = snap.workspaces.map((ws) => {
    const tokens = workspaceTokens(ws, snap.tabs, snap.panes);
    return send(`ws:${ws.workspace_id}`, tokens, () =>
      call('workspace.report_metadata', { workspace_id: ws.workspace_id, source: SOURCE, tokens }),
    );
  });

  const title = applyTitle(snap, forceTitle ? null : last.__title).then((t) => {
    next.__title = t;
  });
  const results = await Promise.allSettled([...jobs, ...wsJobs, title]);
  for (const r of results) if (r.status === 'rejected') console.error(`herdr-glance live: ${r.reason?.message ?? r.reason}`);
  writeJson(file, next);
}

module.exports = { updateLive, liveTokens, wrap, wrapWidth, MAX_DESC, DETAIL_KEYS };
