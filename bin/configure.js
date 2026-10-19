#!/usr/bin/env node
'use strict';

// --apply   write (or repair) the managed sidebar block and reload sessions
// --remove  remove it, clear this plugin's tokens and window title, reload
// --refresh repaint every running session now
// --print   print the block without touching anything

const fs = require('node:fs');
const path = require('node:path');

const { call, snapshot } = require('../lib/ipc');
const { SOURCE, configDir } = require('../lib/session');
const { applyBlock, stripBlock } = require('../lib/layout');
const { MAX_TABS } = require('../lib/tokens');

const CONFIG = path.join(configDir(), 'config.toml');

// The `node` on PATH (e.g. /opt/homebrew/bin/node) rather than
// process.execPath, which is a versioned path that breaks on upgrade.
function nodePath() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'node');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return process.execPath;
}

// Config is shared by every session, so every running server reloads it.
function sessionSockets() {
  const sockets = [path.join(configDir(), 'herdr.sock')];
  const dir = path.join(configDir(), 'sessions');
  try {
    for (const name of fs.readdirSync(dir)) sockets.push(path.join(dir, name, 'herdr.sock'));
  } catch {}
  return sockets.filter((s) => fs.existsSync(s));
}

async function eachSession(fn) {
  await Promise.allSettled(sessionSockets().map((sock) => fn(sock).catch(() => {}))); // stopped sessions leave sockets behind
}

async function clearTokens(sock) {
  const snap = await snapshot(sock);
  const paneTokens = { desc1: null, desc2: null, desc3: null, desc4: null, gap: null, tail: null, group: null, gsort: null, head: null, space: null, branch: null, pr: null, pr_state: null, issues: null };
  const wsTokens = Object.fromEntries(Array.from({ length: MAX_TABS }, (_, i) => [`tab${i + 1}`, null]));
  await Promise.allSettled([
    ...snap.panes.map((p) => call('pane.report_metadata', { pane_id: p.pane_id, source: SOURCE, tokens: paneTokens }, sock)),
    ...snap.workspaces.map((w) =>
      call('workspace.report_metadata', { workspace_id: w.workspace_id, source: SOURCE, tokens: wsTokens }, sock),
    ),
    call('client.window_title.clear', {}, sock),
    call('agent.view.clear', { source: SOURCE }, sock),
  ]);
}

function backup() {
  const copy = `${CONFIG}.glance-backup`;
  fs.copyFileSync(CONFIG, copy);
  return copy;
}

async function main() {
  const mode = process.argv[2] ?? '--apply';
  if (mode === '--print') {
    console.log(applyBlock(fs.readFileSync(CONFIG, 'utf8'), '<timer command>').text);
    return;
  }
  if (mode === '--refresh') {
    refreshAll();
    return;
  }
  const before = fs.readFileSync(CONFIG, 'utf8');
  // Absolute paths: tab-bar commands run in a plain shell, outside the plugin.
  const timerCommand = `"${nodePath()}" "${path.join(__dirname, 'live.js')}" --tick`;
  let after;
  if (mode === '--remove') after = stripBlock(before);
  else {
    const applied = applyBlock(before, timerCommand);
    after = applied.text;
    if (!applied.timer) {
      console.log('config.toml already sets ui.tab_bar_right, so the refresh timer was not installed; activity lines update on agent events and selection changes only.');
    }
  }
  if (after !== before) {
    const copy = backup();
    fs.writeFileSync(CONFIG, after);
    console.log(`${mode === '--remove' ? 'Removed' : 'Wrote'} the sidebar block in ${CONFIG} (backup: ${copy})`);
  } else {
    console.log('config.toml already up to date');
  }
  if (mode === '--remove') await eachSession(clearTokens);
  await eachSession((sock) => call('server.reload_config', {}, sock));
  // Paint tokens now rather than on the next agent event.
  if (mode !== '--remove') refreshAll();
}

// Hooks only ever refresh the session they fired in, so a session with no
// agent activity keeps old tokens until something here repaints it.
function refreshAll() {
  const { spawnSync } = require('node:child_process');
  for (const sock of sessionSockets()) {
    spawnSync(process.execPath, [path.join(__dirname, 'refresh.js'), '--force'], {
      env: { ...process.env, HERDR_SOCKET_PATH: sock, HERDR_SESSION: '' },
      stdio: 'inherit',
      timeout: 30_000,
    });
  }
}

main().catch((err) => {
  console.error(`herdr-glance configure: ${err.message}`);
  process.exitCode = 1;
});
