#!/usr/bin/env node
'use strict';

// Agent overview: a full-screen TUI that runs in its own tab and shows every
// agent in ONE space: status, how long it has been in that state, its
// activity, branch, PRs/issues, your notes, and the selected agent's latest
// output. Opened by the `overview` actions (bin/open-overview.js), which pass
// the space in OVERSEER_WORKSPACE_ID.
//
// Two views, switched with tab (or 1 / 2):
//   agents  each agent with status, activity, branch, PRs/issues, notes and
//           the selected one's latest output
//   git     a tree per repo the agents work in: branches (ahead/behind,
//           uncommitted files), which agent drives each, and the PRs and
//           issues hanging off them (lib/gitview.js)
//
// Keys: ↑/↓ or j/k select · enter go to the agent · n add a note ·
// x delete the agent's latest note · tab switch view · q quit (closes the tab).

const { call, snapshot } = require('../lib/ipc');
const { SOURCE, stateFile, readJson, configDir } = require('../lib/session');
const { agentGroupTokens, GLYPH, isGenericLabel, isAgent, OVERVIEW_AGENT } = require('../lib/tokens');
const { wrap } = require('../lib/live');
const { notesFor, addNote, removeNote, readNotes } = require('../lib/notes');
const { palette } = require('../lib/layout');
const { buildGitModel, renderGitView } = require('../lib/gitview');

const POLL_MS = 2000;
const PREVIEW_LINES = 6;

const WORKSPACE = process.env.OVERSEER_WORKSPACE_ID || process.env.HERDR_WORKSPACE_ID;
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
  view: 'agents', // agents | git
  mode: 'list', // list | note | confirm-delete
  gitOrder: [], // pane ids in git-view order, for moving the selection there
  input: '',
  message: '',
  offset: 0,
  error: '',
};

function labelFor(pane) {
  const tab = ui.snap.tabs.find((t) => t.tab_id === pane.tab_id);
  // Same rule as the sidebar: generic tab names ("1", "claude") show the
  // agent's name, since the activity is on the next line anyway.
  return tab && !isGenericLabel(tab.label) ? tab.label : pane.agent;
}

// Herdr lists this tab in the agents panel once it reports itself as an
// agent; that row carries the space's header, so clicking the header opens
// the overview. Re-claimed whenever Herdr has forgotten it (e.g. a restart).
async function claimRow(snap) {
  const me = snap.panes.find((p) => p.pane_id === SELF);
  if (!me || me.agent === OVERVIEW_AGENT) return;
  await call('pane.report_agent', { pane_id: SELF, source: SOURCE, agent: OVERVIEW_AGENT, state: 'idle' });
}

async function poll() {
  try {
    const snap = await snapshot();
    ui.snap = snap;
    ui.error = '';
    await claimRow(snap);
    const order = agentGroupTokens(snap);
    ui.agents = snap.panes
      .filter((p) => isAgent(p) && p.workspace_id === WORKSPACE && p.pane_id !== SELF)
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
  const tab = (name, key) =>
    ui.view === name ? paint(` ${key} ${name} `, BOLD, `${ESC}7m`, rgb(C.text)) : paint(` ${key} ${name} `, rgb(C.muted));
  const title = paint(` ${ws?.label ?? WORKSPACE} `, BOLD, rgb(C.text)) + tab('agents', '1') + tab('git', '2');
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
  const name = labelFor(pane);
  const state = `${STATUS_WORD[status] ?? status}${since?.at ? ` ${ago(Date.now() - since.at)}` : ''}`;
  const right = name === pane.agent ? state : `${pane.agent} · ${state}`;
  const label = fit(name, width - len(right) - 7);
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

// Styles named by lib/gitview.js.
const SEG_STYLE = {
  text: rgb(C.text),
  bold: BOLD + rgb(C.text),
  muted: rgb(C.muted),
  tree: rgb(C.muted),
  faint: DIM + rgb(C.muted),
  repo: BOLD + rgb(C.text),
  branch: rgb(C.text),
  default: rgb(C.subtext),
  ahead: rgb(C.done),
  behind: rgb(C.blocked),
  dirty: rgb(C.working),
  'pr-open': rgb(C.pr),
  'pr-merged': rgb(C.merged),
  'pr-closed': rgb(C.blocked),
  'pr-draft': rgb(C.muted),
  issue: rgb(C.issue),
  ...Object.fromEntries(Object.entries(STATUS_COLOR).map(([s, c]) => [`status-${s}`, rgb(c)])),
};

// Paints a line of [text, style] segments, cut to the screen width.
function paintSegs(segs, width) {
  let room = width;
  let out = '';
  for (const [text, style] of segs) {
    if (room <= 0) break;
    const shown = len(text) > room ? fit(text, room) : text;
    out += paint(shown, SEG_STYLE[style] ?? '');
    room -= len(shown);
  }
  return out;
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
  const keys = '↑↓ select · enter go to agent · tab switch view · n note · x delete note · q quit';
  return [paint('─'.repeat(width), rgb(C.muted)), paint(` ${fit(ui.error || ui.message || keys, width - 1)}`, rgb(ui.error ? C.blocked : C.muted))];
}

function render() {
  const width = Math.max(30, process.stdout.columns || 80);
  const height = Math.max(8, process.stdout.rows || 24);
  const top = header(width);
  const bottom = footer(width);
  const bodyHeight = height - top.length - bottom.length;

  const body = [];
  let selStart = 0;
  let selEnd = 0;
  if (ui.view === 'git') {
    const details = readJson(stateFile('details'), {});
    const meta = readJson(stateFile('refmeta'), {});
    const trees = readJson(stateFile('trees'), []);
    const { lines, agentLines } = renderGitView(buildGitModel(ui.agents, details, trees, meta), {
      labelFor,
      selected: ui.selected,
      meta,
      width,
    });
    ui.gitOrder = [...new Set(agentLines.values())];
    for (const [i, id] of agentLines) {
      if (id === ui.selected) {
        selStart = i;
        selEnd = i + 1;
        break;
      }
    }
    body.push(...lines.map((segs) => paintSegs(segs, width)));
  }
  const notesAll = readNotes();
  for (const pane of ui.view === 'agents' ? ui.agents : []) {
    const block = agentBlock(pane, width, notesAll);
    if (pane.pane_id === ui.selected) {
      selStart = body.length;
      selEnd = body.length + block.length;
    }
    body.push(...block, '');
  }
  if (ui.view === 'agents' && !ui.agents.length) body.push('', paint('  No agents are running in this space yet.', rgb(C.muted)));

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
  // The git view lists agents in a different order (by repo and branch).
  const order = ui.view === 'git' && ui.gitOrder.length ? ui.gitOrder : ui.agents.map((p) => p.pane_id);
  const i = order.indexOf(ui.selected);
  const next = order[Math.max(0, Math.min(order.length - 1, i + delta))];
  if (next && next !== ui.selected) {
    ui.selected = next;
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
  if (s === 'q' || s === '\x03') return quit(0);
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
  } else if (s === '\t' || s === 'v') ui.view = ui.view === 'agents' ? 'git' : 'agents';
  else if (s === '1') ui.view = 'agents';
  else if (s === '2') ui.view = 'git';
  else if (s === 'r') poll();
  render();
}

function quit(code = 0) {
  process.stdout.write(`${ESC}?25h${ESC}?1049l`);
  process.exit(code);
}

// Exit code that tells the pane's shell loop (herdr-plugin.toml) to start
// the overview again: open tabs pick up plugin updates without being closed.
const RELOAD = 75;

function watchForUpdates() {
  const fs = require('node:fs');
  const path = require('node:path');
  let timer = null;
  for (const dir of ['bin', 'lib']) {
    try {
      fs.watch(path.join(__dirname, '..', dir), () => {
        clearTimeout(timer);
        timer = setTimeout(() => quit(RELOAD), 500);
      });
    } catch {}
  }
}

function main() {
  if (!WORKSPACE) {
    console.error('herdr-overseer overview: no space given (OVERSEER_WORKSPACE_ID); open it with the overview action.');
    process.exit(1);
  }
  process.stdout.write(`${ESC}?1049h${ESC}?25l`);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', onKey);
  process.stdout.on('resize', render);
  process.on('SIGTERM', () => quit(0));
  process.on('SIGHUP', () => quit(0));
  watchForUpdates();
  poll();
  setInterval(poll, POLL_MS);
}

main();
