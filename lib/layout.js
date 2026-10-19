'use strict';

// The sidebar layout this plugin installs into Herdr's config.toml, and the
// marker-delimited block editing that installs and removes it.
//
// Colours follow the `[theme] name` in config.toml when it is one we have a
// palette for; anything else gets Tokyo Night. Re-run Configure after
// switching themes.

const { GLYPH, MAX_TABS } = require('./tokens');
const { MAX_DESC, DETAIL_LINES } = require('./live');

const TIMER_SECONDS = 3;

const PALETTES = {
  'tokyo-night': {
    text: '#c0caf5',
    subtext: '#a9b1d6',
    muted: '#737aa2',
    working: '#e0af68',
    blocked: '#f7768e',
    done: '#9ece6a',
    pr: '#7aa2f7',
    merged: '#bb9af7',
    issue: '#7dcfff',
  },
  catppuccin: {
    text: '#cdd6f4',
    subtext: '#a6adc8',
    muted: '#7f849c',
    working: '#f9e2af',
    blocked: '#f38ba8',
    done: '#a6e3a1',
    pr: '#89b4fa',
    merged: '#cba6f7',
    issue: '#94e2d5',
  },
};

function themeName(configText) {
  const theme = /^\s*\[theme\]\s*$([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m.exec(configText ?? '');
  const name = theme && /^\s*name\s*=\s*"([^"]+)"/m.exec(theme[1]);
  return name ? name[1] : null;
}

function palette(configText) {
  const name = themeName(configText) ?? '';
  const key = Object.keys(PALETTES).find((k) => name.startsWith(k));
  return PALETTES[key ?? 'tokyo-night'];
}

let C = PALETTES['tokyo-night'];

const BEGIN = '# >>> herdr-overseer sidebar block (managed by the yeutterg.herdr-overseer plugin; edits are overwritten)';
const END = '# <<< herdr-overseer sidebar block';
const TIMER_BEGIN = '# >>> herdr-overseer timer (managed by the yeutterg.herdr-overseer plugin)';
const TIMER_END = '# <<< herdr-overseer timer';

const q = (s) => JSON.stringify(s); // TOML basic strings share JSON's escapes.

function tok(token, style = {}) {
  const parts = [`token = ${q(token)}`];
  if (style.fg) parts.push(`fg = ${q(style.fg)}`);
  if (style.bold !== undefined) parts.push(`bold = ${style.bold}`);
  if (style.dim !== undefined) parts.push(`dim = ${style.dim}`);
  if (style.rules) parts.push(`rules = [${style.rules.map(rule).join(', ')}]`);
  return `{ ${parts.join(', ')} }`;
}

function rule(r) {
  return `{ ${Object.entries(r)
    .map(([k, v]) => `${k} = ${typeof v === 'string' ? q(v) : v}`)
    .join(', ')} }`;
}

// The agent's status line: icon and tab name, coloured by status.
const headRules = () => [
  { contains: GLYPH.blocked, fg: C.blocked, bold: true },
  { contains: GLYPH.working, fg: C.working, bold: true },
  { contains: GLYPH.done, fg: C.done, bold: true },
  { contains: GLYPH.idle, fg: C.text, bold: true },
  { contains: GLYPH.unknown, fg: C.muted },
];


const prStateRules = () => [
  { contains: '(merged)', fg: C.merged },
  { contains: '(closed)', fg: C.blocked },
  { contains: '(draft)', fg: C.muted },
];

// Branch, then PRs, then issues, each on its own line(s).
function detailRows() {
  const style = { branch: { fg: C.muted }, pr: { fg: C.pr, rules: prStateRules() }, iss: { fg: C.issue } };
  return DETAIL_LINES.flatMap(([key, max]) => Array.from({ length: max }, (_, i) => [tok(`$${key}${i + 1}`, style[key])]));
}

// Each nested tab row starts "├ <glyph>" or "└ <glyph>"; colour by glyph.
const tabRowRules = () => [
  [GLYPH.blocked, { fg: C.blocked, bold: true }],
  [GLYPH.working, { fg: C.working }],
  [GLYPH.done, { fg: C.done }],
  [GLYPH.idle, { fg: C.subtext }],
  [GLYPH.unknown, { fg: C.muted }],
].flatMap(([glyph, style]) => ['├', '└'].map((branch) => ({ starts_with: `${branch} ${glyph}`, ...style })));

// Lines that are empty for an agent disappear, so an unselected agent is two
// lines (status, one line of activity) and the selected one grows to show its
// wrapped activity, branch and PRs/issues.
function agentRows() {
  return [
    [tok('$group', { fg: C.subtext, bold: true })],
    [tok('$head', { rules: headRules() }), tok('$space', { fg: C.subtext })],
    ...Array.from({ length: MAX_DESC }, (_, i) => [tok(`$desc${i + 1}`, { fg: C.subtext })]),
    ...detailRows(),
    ['$tail'],
  ];
}

function spaceRows() {
  const tabRows = Array.from({ length: MAX_TABS }, (_, i) => [tok(`$tab${i + 1}`, { rules: tabRowRules() })]);
  // No branch here: a space's tabs can each be on a different one, so the
  // branch is shown per agent instead.
  return [['state_icon', tok('workspace', { bold: true })], ...tabRows];
}

function rowsToml(rows) {
  return `rows = [\n${rows.map((row) => `  [${row.map((t) => (t.startsWith('{') ? t : q(t))).join(', ')}],`).join('\n')}\n]`;
}

function block(configText) {
  C = palette(configText);
  return [
    BEGIN,
    '[ui.sidebar.agents]',
    'row_gap = 0',
    rowsToml(agentRows()),
    '',
    '[ui.sidebar.spaces]',
    'row_gap = 0',
    rowsToml(spaceRows()),
    END,
  ].join('\n');
}

// The timer. Herdr has no periodic hook for plugins, but it re-runs tab-bar
// status commands on an interval; this one prints nothing and keeps the
// activity lines and the selected agent current. It is a key of [ui], so it
// has its own block placed inside that table.
function timerBlock(command) {
  return [
    TIMER_BEGIN,
    `tab_bar_right = [{ type = "command", command = ${q(command)}, interval_seconds = ${TIMER_SECONDS}, timeout_seconds = 2 }]`,
    TIMER_END,
  ].join('\n');
}

function strip(text, begin, end) {
  const start = text.indexOf(begin);
  if (start < 0) return text;
  const stop = text.indexOf(end, start);
  if (stop < 0) throw new Error('found the start of a herdr-overseer block but not its end; fix config.toml by hand');
  const before = text.slice(0, start).replace(/\n+$/, '\n');
  const after = text.slice(stop + end.length).replace(/^\n+/, '');
  return before + after;
}

function stripBlock(text) {
  return strip(strip(text, BEGIN, END), TIMER_BEGIN, TIMER_END);
}

// Tables we would define that something else already defines.
function conflicts(text) {
  return ['ui.sidebar.agents', 'ui.sidebar.spaces'].filter((t) =>
    new RegExp(`^\\s*\\[${t.replace(/\./g, '\\.')}(\\.[^\\]]*)?\\]`, 'm').test(text),
  );
}

// Returns { text, timer }: timer is false when the user already has their
// own tab_bar_right, which we leave alone (activity then refreshes on agent
// events and selection changes only).
function applyBlock(text, timerCommand) {
  let base = stripBlock(text);
  const clash = conflicts(base);
  if (clash.length) {
    throw new Error(
      `config.toml already defines [${clash.join('], [')}] outside this plugin's block. ` +
        'Remove those tables (or run another sidebar plugin\'s "unconfigure" action) and try again.',
    );
  }
  const timer = Boolean(timerCommand) && !/^\s*tab_bar_right\s*=/m.test(base);
  if (timer) {
    const ui = /^\[ui\][ \t]*$/m.exec(base);
    base = ui
      ? `${base.slice(0, ui.index + ui[0].length)}\n${timerBlock(timerCommand)}${base.slice(ui.index + ui[0].length)}`
      : `${base.replace(/\n*$/, '\n')}\n[ui]\n${timerBlock(timerCommand)}\n`;
  }
  return { text: `${base.replace(/\n*$/, '\n')}\n${block(text)}\n`, timer };
}

module.exports = { themeName, palette, PALETTES, block, applyBlock, stripBlock, conflicts, BEGIN, END };
