'use strict';

// The sidebar layout this plugin installs into Herdr's config.toml, and the
// marker-delimited block editing that installs and removes it.
//
// Colours follow the `[theme] name` in config.toml when it is one we have a
// palette for; anything else gets Tokyo Night. Re-run Configure after
// switching themes.

const { GLYPH, MAX_TABS } = require('./tokens');

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

const BEGIN = '# >>> herdr-glance sidebar block (managed by the yeutterg.herdr-glance plugin; edits are overwritten)';
const END = '# <<< herdr-glance sidebar block';

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

const stateTextRules = () => [
  { equals: 'blocked', fg: C.blocked, bold: true },
  { equals: 'working', fg: C.working },
  { equals: 'done', fg: C.done },
  { equals: 'idle', fg: C.muted },
  { equals: 'unknown', hide: true },
];

// Tab names that only repeat the agent or a number add nothing to the row.
const GENERIC_TAB_RULES = [
  ...['claude', 'codex', 'gemini', 'pi', 'opencode', 'amp', 'droid'].map((name) => ({ equals: name, hide: true })),
  { lt: 1000, hide: true },
];

const prStateRules = () => [
  { equals: 'merged', fg: C.merged },
  { equals: 'closed', fg: C.blocked },
  { equals: 'draft', fg: C.muted },
];

// Each nested tab row starts "├ <glyph>" or "└ <glyph>"; colour by glyph.
const tabRowRules = () => [
  [GLYPH.blocked, { fg: C.blocked, bold: true }],
  [GLYPH.working, { fg: C.working }],
  [GLYPH.done, { fg: C.done }],
  [GLYPH.idle, { fg: C.subtext }],
  [GLYPH.unknown, { fg: C.muted }],
].flatMap(([glyph, style]) => ['├', '└'].map((branch) => ({ starts_with: `${branch} ${glyph}`, ...style })));

function agentRows() {
  return [
    ['$gap'],
    [tok('$group', { fg: C.subtext, bold: true })],
    [
      'state_icon',
      tok('tab', { fg: C.text, bold: true, rules: GENERIC_TAB_RULES }),
      tok('state_text', { rules: stateTextRules() }),
    ],
    [tok('terminal_title_stripped', { fg: C.text })],
    [tok('$branch', { fg: C.muted }), tok('$pr', { fg: C.pr }), tok('$pr_state', { rules: prStateRules() }), tok('$issues', { fg: C.issue })],
  ];
}

function spaceRows() {
  const tabRows = Array.from({ length: MAX_TABS }, (_, i) => [tok(`$tab${i + 1}`, { rules: tabRowRules() })]);
  return [['state_icon', tok('workspace', { bold: true }), tok('branch', { fg: C.muted }), 'git_status'], ...tabRows];
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

function stripBlock(text) {
  const start = text.indexOf(BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(END, start);
  if (end < 0) throw new Error('found the start of the herdr-glance block but not its end; fix config.toml by hand');
  const before = text.slice(0, start).replace(/\n+$/, '\n');
  const after = text.slice(end + END.length).replace(/^\n+/, '');
  return before + (after ? `\n${after}` : '');
}

// Tables we would define that something else already defines.
function conflicts(text) {
  return ['ui.sidebar.agents', 'ui.sidebar.spaces'].filter((t) =>
    new RegExp(`^\\s*\\[${t.replace(/\./g, '\\.')}(\\.[^\\]]*)?\\]`, 'm').test(text),
  );
}

function applyBlock(text) {
  const base = stripBlock(text);
  const clash = conflicts(base);
  if (clash.length) {
    throw new Error(
      `config.toml already defines [${clash.join('], [')}] outside this plugin's block. ` +
        'Remove those tables (or run another sidebar plugin\'s "unconfigure" action) and try again.',
    );
  }
  return `${base.replace(/\n*$/, '\n')}\n${block(text)}\n`;
}

module.exports = { themeName, palette, PALETTES, block, applyBlock, stripBlock, conflicts, BEGIN, END };
