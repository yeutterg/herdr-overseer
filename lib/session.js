'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SOURCE = 'yeutterg.herdr-overseer';

// Tab-bar commands get HERDR_SESSION but not always the socket path.
function socketPath() {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  const session = process.env.HERDR_SESSION;
  return session && session !== 'default'
    ? path.join(configDir(), 'sessions', session, 'herdr.sock')
    : path.join(configDir(), 'herdr.sock');
}

function configDir() {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, 'herdr');
}

// Named sessions run their own server at <config>/sessions/<name>/herdr.sock;
// the default session's socket sits directly in <config>. Herdr also exports
// HERDR_SESSION into panes, but plugin hooks are not guaranteed to get it.
function sessionName() {
  if (process.env.HERDR_SESSION) return process.env.HERDR_SESSION;
  const dir = path.dirname(socketPath());
  return path.basename(path.dirname(dir)) === 'sessions' ? path.basename(dir) : 'default';
}

// Plugins share one state dir across sessions, so per-session files carry
// the session name.
function stateFile(name) {
  // The tab-bar timer runs outside the plugin environment, so fall back to
  // the same directory Herdr hands hooks.
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state');
  const dir = process.env.HERDR_PLUGIN_STATE_DIR ?? path.join(stateHome, 'herdr', 'plugins', SOURCE);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}-${sessionName()}.json`);
}

function userConfig() {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR ?? path.join(configDir(), 'plugins', 'config', SOURCE);
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

module.exports = { SOURCE, socketPath, configDir, sessionName, stateFile, userConfig, readJson, writeJson };
