#!/usr/bin/env node
'use strict';

// Agent overview: a full-screen TUI that runs in its own tab and shows every
// agent in ONE space: status, how long it has been in that state, its
// activity, branch, PRs/issues, your notes, and the selected agent's latest
// output. Opened by the `overview` actions (bin/open-overview.js), which pass
// the space in GLANCE_WORKSPACE_ID.
//
// Keys: ↑/↓ or j/k select · enter go to the agent · n add a note ·
// x delete the agent's latest note · q quit (closes the tab).

const { call, snapshot } = require('../lib/ipc');
const { stateFile, readJson, configDir } = require('../lib/session');
const { agentGroupTokens, GLYPH, isGenericLabel } = require('../lib/tokens');
const { wrap } = require('../lib/live');
const { notesFor, addNote, removeNote, readNotes } = require('../lib/notes');
const { palette } = require('../lib/layout');

const POLL_MS = 2000;
const PREVIEW_LINES = 6;

const WORKSPACE = process.env.GLANCE_WORKSPACE_ID || process.env.HERDR_WORKSPACE_ID;
const SELF = process.env.HERDR_PANE_ID;

let C;
try {
  C = palette(require('node:fs').readFileSync(require('node:path').join(configDir(), 'config.toml'), 'utf8'));
} catch {
  C = palette('');
}

// ---- terminal helpers -------------------------------------------------------

const ESC = '\x1b[';
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `${ESC}38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const paint = (text, ...styles) => `${styles.join('')}${text}${RESET}`;

const STATUS_COLOR = { blocked: C.blocked, working: C.working, done: C.done, idle: C.subtext, unknown: C.muted };
const STATUS_WORD = { blocked: 'needs you', working: 'working', done: 'done', idle: 'idle', unknown: '—' };

const len = (s) => [...s].length;
function fit(text, width) {
  const chars = [...(text ?? '')];
  if (width <= 0) return '';
  return chars.length <= width ? chars.join('') : `${chars.slice(0, width - 1).join('')}…`;
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(h / 24)}d`;
}

const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);

// ---- state --------------------------------------------------------------------

const ui = {
  snap: null,
  agents: [], // panes in this space, priority order
  selected: null, // pane_id
  since: new Map(), // pane_id -> { status, at } (at = null: before this tab opened)
  preview: [],
  mode: 'list', // list | note | confirm-delete
  input: '',
  message: '',
  offset: 0,
  error: '',
};

function labelFor(pane) {
  const tab = ui.snap.tabs.find((t) => t.tab_id === pane.tab_id);
  return tab && !isGenericLabel(tab.label) ? tab.label : pane.terminal_title_stripped || pane.agent;
}

async function poll() {
  try {
    const snap = await snapshot();
    ui.snap = snap;
    ui.error = '';
    const order = agentGroupTokens(snap);
    ui.agents = snap.panes
      .filter((p) => p.agent && p.workspace_id === WORKSPACE && p.pane_id !== SELF)
      .sort((a, b) => (order.get(a.pane_id).gsort < order.get(b.pane_id).gsort ? -1 : 1));
    const now = Date.now();
    for (const p of ui.agents) {
      const prev = ui.since.get(p.pane_id);
      if (!prev) ui.since.set(p.pane_id, { status: p.agent_status, at: null });
      else if (prev.status !== p.agent_status) ui.since.set(p.pane_id, { status: p.agent_status, at: now });
    }
    if (!ui.agents.some((p) => p.pane_id === ui.selected)) ui.selected = ui.agents[0]?.pane_id ?? null;
    await loadPreview();
  } catch (err) {
    ui.error = err.message;
  }
  render();
}

async function loadPreview() {
  if (!ui.selected) {
    ui.preview = [];
    return;
  }
  try {
    const read = await call('pane.read', { pane_id: ui.selected, source: 'recent', lines: 40 });
    ui.preview = (read.read?.text ?? '')
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .filter((l) => l.trim() && !/^[─━-]{8,}$/.test(l.trim()))
      .slice(-PREVIEW_LINES);
  } catch {
    ui.preview = [];
  }
}

// ---- rendering ------------------------------------------------------------------

function header(width) {
  const ws = ui.snap?.workspaces.find((w) => w.workspace_id === WORKSPACE);
  const counts = { blocked: 0, working: 0, done: 0, idle: 0 };
  for (const p of ui.agents) if (p.agent_status in counts) counts[p.agent_status] += 1;
  const title = paint(` ${ws?.label ?? WORKSPACE} `, BOLD, rgb(C.text)) + paint('agents', rgb(C.muted));
  const tally = ['blocked', 'working', 'done', 'idle']
    .filter((s) => counts[s])
    .map((s) => paint(`${GLYPH[s]} ${counts[s]} ${STATUS_WORD[s]}`, rgb(STATUS_COLOR[s])))
    .join(paint('  ·  ', rgb(C.muted)));
  return [`${title}   ${tally || paint('no agents in this space', rgb(C.muted))}`, paint('─'.repeat(width), rgb(C.muted))];
}

function agentBlock(pane, width, notesAll) {
  const sel = pane.pane_id === ui.selected;
  const status = pane.agent_status;
  const color = rgb(STATUS_COLOR[status] ?? C.muted);
  const since = ui.since.get(pane.pane_id);
  const right = `${pane.agent} · ${STATUS_WORD[status] ?? status}${since?.at ? ` ${ago(Date.now() - since.at)}` : ''}`;
  const label = fit(labelFor(pane), width - len(right) - 7);
  const pad = ' '.repeat(Math.max(1, width - 4 - len(label) - len(right) - 1));
  const lines = [
    `${sel ? paint('▸', BOLD, rgb(C.text)) : ' '} ${paint(GLYPH[status] ?? GLYPH.unknown, color)} ${paint(label, BOLD, sel ? rgb(C.text) : color)}${pad}${paint(right, rgb(C.muted))}`,
  ];
  const indent = '    ';
  const inner = width - indent.length;

  const activity = wrap(pane.terminal_title_stripped || '', inner, sel ? 4 : 1);
  for (const l of activity) lines.push(indent + paint(l, rgb(C.subtext)));

  const details = readJson(stateFile('details'), {})[pane.pane_id] ?? {};
  const refs = [
    details.branch && paint(fit(details.branch, inner), rgb(C.muted)),
    details.pr && paint(fit(details.pr_state ? `${details.pr} (${details.pr_state})` : details.pr, inner), rgb(C.pr)),
    details.issues && paint(fit(details.issues, inner), rgb(C.issue)),
  ].filter(Boolean);
  if (sel) for (const r of refs) lines.push(indent + r);
  else if (refs.length) lines.push(indent + paint(fit([details.branch, details.pr, details.issues].filter(Boolean).join(' · '), inner), rgb(C.muted)));

  const notes = notesFor(pane, notesAll);
  for (const n of sel ? notes : notes.slice(-1)) {
    const prefix = `✎ ${clock(n.at)} `;
    wrap(n.text, inner - len(prefix), sel ? 6 : 1).forEach((l, i) =>
      lines.push(indent + paint(i ? ' '.repeat(len(prefix)) + l : prefix + l, rgb(C.working))),
    );
  }
  if (!sel && notes.length > 1) lines.push(indent + paint(`  +${notes.length - 1} more note${notes.length > 2 ? 's' : ''}`, rgb(C.muted)));

  if (sel && ui.preview.length) {
    lines.push(indent + paint('latest output', rgb(C.muted)));
    for (const l of ui.preview) lines.push(indent + paint(`│ ${fit(l, inner - 2)}`, DIM, rgb(C.subtext)));
  }
  return lines;
}

function footer(width) {
  if (ui.mode === 'note') {
    const prompt = ' note › ';
    const shown = [...ui.input].slice(-(width - len(prompt) - 2)).join('');
    return [paint('─'.repeat(width), rgb(C.muted)), paint(prompt, BOLD, rgb(C.working)) + shown + paint('█', rgb(C.text))];
  }
  if (ui.mode === 'confirm-delete') {
    return [paint('─'.repeat(width), rgb(C.muted)), paint(' delete the latest note? y / n', BOLD, rgb(C.blocked))];
  }
  const keys = '↑↓ select · enter go to agent · n note · x delete note · q quit';
  return [paint('─'.repeat(width), rgb(C.muted)), paint(` ${fit(ui.error || ui.message || keys, width - 1)}`, rgb(ui.error ? C.blocked : C.muted))];
}

function render() {
  const width = Math.max(30, process.stdout.columns || 80);
  const height = Math.max(8, process.stdout.rows || 24);
  const top = header(width);
  const bottom = footer(width);
  const bodyHeight = height - top.length - bottom.length;

  const notesAll = readNotes();
  const body = [];
  let selStart = 0;
  let selEnd = 0;
  for (const pane of ui.agents) {
    const block = agentBlock(pane, width, notesAll);
    if (pane.pane_id === ui.selected) {
      selStart = body.length;
      selEnd = body.length + block.length;
    }
    body.push(...block, '');
  }
  if (!ui.agents.length) body.push('', paint('  No agents are running in this space yet.', rgb(C.muted)));

  // Keep the selected agent on screen.
  if (selStart < ui.offset) ui.offset = selStart;
  if (selEnd > ui.offset + bodyHeight) ui.offset = Math.min(selStart, selEnd - bodyHeight);
  ui.offset = Math.max(0, Math.min(ui.offset, Math.max(0, body.length - bodyHeight)));
  const visible = body.slice(ui.offset, ui.offset + bodyHeight);
  while (visible.length < bodyHeight) visible.push('');

  const frame = [...top, ...visible, ...bottom].map((l) => `${l}${ESC}K`).join('\r\n');
  process.stdout.write(`${ESC}H${frame}${ESC}J`);
}

// ---- input ----------------------------------------------------------------------

function move(delta) {
  const i = ui.agents.findIndex((p) => p.pane_id === ui.selected);
  const next = ui.agents[Math.max(0, Math.min(ui.agents.length - 1, i + delta))];
  if (next && next.pane_id !== ui.selected) {
    ui.selected = next.pane_id;
    ui.preview = [];
    loadPreview().then(render);
  }
}

const selectedPane = () => ui.agents.find((p) => p.pane_id === ui.selected);

async function goTo(pane) {
  try {
    await call('tab.focus', { tab_id: pane.tab_id });
    await call('pane.focus', { pane_id: pane.pane_id });
  } catch (err) {
    ui.message = `could not focus: ${err.message}`;
  }
}

function onKey(data) {
  const s = data.toString('utf8');
  ui.message = '';
  if (ui.mode === 'note') {
    if (s === '\x1b') ui.mode = 'list';
    else if (s === '\r' || s === '\n') {
      const pane = selectedPane();
      const text = ui.input.trim();
      if (pane && text) addNote(pane, text);
      ui.mode = 'list';
      ui.input = '';
      if (text) ui.message = 'note saved';
    } else if (s === '\x7f' || s === '\b') ui.input = [...ui.input].slice(0, -1).join('');
    else if (s === '\x15') ui.input = ''; // ctrl+u
    else if (!s.startsWith('\x1b')) ui.input += s.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f]/g, '');
    return render();
  }
  if (ui.mode === 'confirm-delete') {
    if (s === 'y' || s === 'Y') {
      const pane = selectedPane();
      const notes = pane ? notesFor(pane) : [];
      if (notes.length) removeNote(pane, notes.length - 1);
      ui.message = 'note deleted';
    }
    ui.mode = 'list';
    return render();
  }
  if (s === 'q' || s === '\x03') return quit();
  if (s === 'j' || s === '\x1b[B' || s === '\x1bOB') move(1);
  else if (s === 'k' || s === '\x1b[A' || s === '\x1bOA') move(-1);
  else if (s === 'g') move(-Infinity);
  else if (s === 'G') move(Infinity);
  else if (s === '\r' || s === '\n') {
    const pane = selectedPane();
    if (pane) goTo(pane);
  } else if (s === 'n' && selectedPane()) {
    ui.mode = 'note';
    ui.input = '';
  } else if (s === 'x' && selectedPane()) {
    if (notesFor(selectedPane()).length) ui.mode = 'confirm-delete';
    else ui.message = 'no notes on this agent';
  } else if (s === 'r') poll();
  render();
}

function quit() {
  process.stdout.write(`${ESC}?25h${ESC}?1049l`);
  process.exit(0);
}

function main() {
  if (!WORKSPACE) {
    console.error('herdr-glance overview: no space given (GLANCE_WORKSPACE_ID); open it with the overview action.');
    process.exit(1);
  }
  process.stdout.write(`${ESC}?1049h${ESC}?25l`);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', onKey);
  process.stdout.on('resize', render);
  process.on('SIGTERM', quit);
  process.on('SIGHUP', quit);
  poll();
  setInterval(poll, POLL_MS);
}

main();
