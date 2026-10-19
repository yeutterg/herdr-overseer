'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SOURCE = 'yeutterg.herdr-glance';

function socketPath() {
  return process.env.HERDR_SOCKET_PATH ?? path.join(configDir(), 'herdr.sock');
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
  const dir = process.env.HERDR_PLUGIN_STATE_DIR ?? path.join(os.tmpdir(), SOURCE);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}-${sessionName()}.json`);
}

function userConfig() {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!dir) return {};
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
