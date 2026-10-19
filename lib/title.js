'use strict';

const os = require('node:os');

const { call } = require('./ipc');
const { sessionName, userConfig } = require('./session');
const { windowTitle } = require('./tokens');

const DEFAULT_FORMAT = '{session} › {workspace}';

// Sets the outer terminal's window title from an already-fetched snapshot,
// so a tiling window manager (and you) can tell sessions apart.
async function applyTitle(snap) {
  const format = userConfig().window_title ?? DEFAULT_FORMAT;
  if (!format) return;
  const ws = snap.workspaces.find((w) => w.workspace_id === snap.focused_workspace_id);
  const tab = snap.tabs.find((t) => t.tab_id === snap.focused_tab_id);
  const title = windowTitle(format, {
    session: sessionName(),
    workspace: ws?.label,
    tab: tab?.label,
    hostname: os.hostname().split('.')[0],
  });
  if (title) await call('client.window_title.set', { title });
}

module.exports = { applyTitle, DEFAULT_FORMAT };
