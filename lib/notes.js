'use strict';

// Notes you keep on an agent from the overview tab. Stored in the plugin's
// state dir, one file for all sessions, keyed by the agent's own session id
// so notes follow the agent across pane moves and Herdr restarts. Agents
// without one (some never report it) fall back to session + pane id.

const path = require('node:path');

const { stateFile, sessionName, readJson, writeJson } = require('./session');

function notesFile() {
  // stateFile() is per session; notes are not.
  return path.join(path.dirname(stateFile('state')), 'notes.json');
}

function noteKey(pane) {
  return pane.agent_session?.value ?? `${sessionName()}:${pane.pane_id}`;
}

function readNotes() {
  return readJson(notesFile(), {});
}

function notesFor(pane, all = readNotes()) {
  return all[noteKey(pane)] ?? [];
}

// Re-reads before writing so two overview tabs never drop each other's notes.
function addNote(pane, text) {
  const all = readNotes();
  const key = noteKey(pane);
  all[key] = [...(all[key] ?? []), { at: Date.now(), text }];
  writeJson(notesFile(), all);
  return all[key];
}

function removeNote(pane, index) {
  const all = readNotes();
  const key = noteKey(pane);
  const list = all[key] ?? [];
  list.splice(index, 1);
  if (list.length) all[key] = list;
  else delete all[key];
  writeJson(notesFile(), all);
  return list;
}

module.exports = { noteKey, readNotes, notesFor, addNote, removeNote };
