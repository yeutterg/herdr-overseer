'use strict';

// Notes you keep on an agent from the overview tab. They are scratch notes
// about the job in hand, so they belong to the pane the agent runs in and
// are deleted when that pane (or its tab) closes. Stored in the plugin's
// state dir, outside the repo, one file for all sessions.

const path = require('node:path');

const { stateFile, sessionName, readJson, writeJson } = require('./session');

function notesFile() {
  // stateFile() is per session; notes are not.
  return path.join(path.dirname(stateFile('state')), 'notes.json');
}

function noteKey(pane, session = sessionName()) {
  return `${session}:${pane.pane_id}`;
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

// Drops this session's notes on panes that no longer exist. Notes from older
// versions, keyed by the agent's session id, move onto the agent's pane.
function pruneNotes(snap, session = sessionName()) {
  const all = readNotes();
  const live = new Set(snap.panes.map((p) => noteKey(p, session)));
  const paneByTerminal = new Map(snap.panes.map((p) => [p.terminal_id, p]));
  const byAgentSession = new Map();
  for (const agent of snap.agents ?? []) {
    const pane = paneByTerminal.get(agent.terminal_id);
    if (pane && agent.agent_session?.value) byAgentSession.set(agent.agent_session.value, noteKey(pane, session));
  }
  let changed = false;
  for (const [key, list] of Object.entries(all)) {
    const moved = byAgentSession.get(key);
    if (moved) {
      all[moved] = [...(all[moved] ?? []), ...list].sort((a, b) => a.at - b.at);
      delete all[key];
      changed = true;
    } else if (key.startsWith(`${session}:`) && !live.has(key)) {
      delete all[key];
      changed = true;
    }
  }
  if (changed) writeJson(notesFile(), all);
  return changed;
}

module.exports = { noteKey, readNotes, notesFor, addNote, removeNote, pruneNotes };
