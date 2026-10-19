#!/usr/bin/env node
'use strict';

// --apply   write (or repair) the managed sidebar block and reload sessions
// --remove  remove it, clear this plugin's tokens and window title, reload
// --print   print the block without touching anything

const fs = require('node:fs');
const path = require('node:path');

const { call, snapshot } = require('../lib/ipc');
const { SOURCE, configDir } = require('../lib/session');
const { applyBlock, stripBlock, block } = require('../lib/layout');
const { MAX_TABS } = require('../lib/tokens');

const CONFIG = path.join(configDir(), 'config.toml');

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
  const paneTokens = { gap: null, group: null, gsort: null, branch: null, pr: null, pr_state: null, issues: null };
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
    console.log(block(fs.readFileSync(CONFIG, 'utf8')));
    return;
  }
  const before = fs.readFileSync(CONFIG, 'utf8');
  const after = mode === '--remove' ? stripBlock(before) : applyBlock(before);
  if (after !== before) {
    const copy = backup();
    fs.writeFileSync(CONFIG, after);
    console.log(`${mode === '--remove' ? 'Removed' : 'Wrote'} the sidebar block in ${CONFIG} (backup: ${copy})`);
  } else {
    console.log('config.toml already up to date');
  }
  if (mode === '--remove') await eachSession(clearTokens);
  await eachSession((sock) => call('server.reload_config', {}, sock));
  if (mode !== '--remove') {
    // Paint tokens now rather than on the next agent event.
    const { spawnSync } = require('node:child_process');
    for (const sock of sessionSockets()) {
      spawnSync(process.execPath, [path.join(__dirname, 'refresh.js'), '--force'], {
        env: { ...process.env, HERDR_SOCKET_PATH: sock, HERDR_SESSION: '' },
        stdio: 'inherit',
        timeout: 30_000,
      });
    }
  }
}

main().catch((err) => {
  console.error(`herdr-glance configure: ${err.message}`);
  process.exitCode = 1;
});
