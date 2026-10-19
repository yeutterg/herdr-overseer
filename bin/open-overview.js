#!/usr/bin/env node
'use strict';

// Opens the agent overview (bin/overview.js) as a tab named "overview" in a
// space, scoped to that space through GLANCE_WORKSPACE_ID. A space that
// already has one gets it focused instead of a second copy.
//
//   (no args)  the space you are in
//   --all      every space in this session, without moving you
//
// Disabled when the plugin's config.json sets "overview": false.

const { call, snapshot } = require('../lib/ipc');
const { userConfig } = require('../lib/session');

const TAB_LABEL = 'overview';
const PLUGIN_ID = process.env.HERDR_PLUGIN_ID ?? 'yeutterg.herdr-glance';

async function open(snap, workspaceId, focus) {
  const existing = snap.tabs.find((t) => t.workspace_id === workspaceId && t.label === TAB_LABEL);
  if (existing) {
    if (focus) await call('tab.focus', { tab_id: existing.tab_id });
    return 'existing';
  }
  const opened = await call('plugin.pane.open', {
    plugin_id: PLUGIN_ID,
    entrypoint: 'overview',
    placement: 'tab',
    workspace_id: workspaceId,
    env: { GLANCE_WORKSPACE_ID: workspaceId },
    focus,
  });
  const tabId = opened.plugin_pane?.pane?.tab_id;
  if (tabId) await call('tab.rename', { tab_id: tabId, label: TAB_LABEL });
  return 'opened';
}

async function main() {
  if (userConfig().overview === false) {
    console.log('The agent overview is turned off ("overview": false in the plugin config).');
    return;
  }
  const snap = await snapshot();
  if (process.argv.includes('--all')) {
    for (const ws of snap.workspaces) {
      const result = await open(snap, ws.workspace_id, false);
      console.log(`${ws.label}: ${result}`);
    }
    return;
  }
  const workspaceId = process.env.HERDR_WORKSPACE_ID ?? snap.focused_workspace_id;
  console.log(await open(snap, workspaceId, true));
}

main().catch((err) => {
  console.error(`herdr-glance overview: ${err.message}`);
  process.exitCode = 1;
});
