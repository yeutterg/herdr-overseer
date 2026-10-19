# Herdr Glance

A [Herdr](https://herdr.dev) plugin that makes the sidebar answer "what is each agent doing, and what has it produced?" without clicking around.

**Agents panel**: agents are nested under their space, with one coloured status icon each. Unselected agents take two lines: status and tab name, then one line of live activity. Select an agent (click it, or focus its pane) and it expands: the activity wraps over up to four lines, and its branch and PRs/issues appear.

```
restful
  ● auth-refactor
  Waiting for approval to run npm…
  ◐ token-race                       ← selected
  Fixing the token refresh race in
  the auth middleware
  ⎇ fix/138-token-race
  PR #142 · Issue #138
  ○ docs
  Idle
```

| Icon | Meaning |
|---|---|
| `●` red | needs you (blocked) |
| `◐` | working |
| `✔` | done |
| `○` | idle |
| `·` | no agent |

Tabs with generic names like `1` or `claude` show the agent's name instead.

Both levels are sorted by priority, like Herdr's own `priority` sort: needs you, then done, working and idle, most recent change first. A space ranks by its most urgent agent, so a space with someone waiting on you jumps to the top. Herdr can't group agents itself, so the plugin sets the panel order (the header reads **priority**). Set `nest_agents` to `false` (see Options) to get Herdr's flat list back, or run **unconfigure**.

**Spaces panel**: each space lists its tabs underneath, with the same status icons:

```
● restful
  ├ ◐ api
  ├ ● Waiting for approval to run npm…
  └ ○ docs
```

There is no branch on the space line, since a space's tabs can each be on a different branch. Tabs with generic names show their pane's terminal title instead. Herdr gives each space one click target, so clicking a nested tab line focuses the space, not that tab.

**Window title**: the outer terminal window is titled `Herdr: <session>`. This helps tiling window managers and makes it easier to remember which session is which.

## Where PRs and issues come from

- **The pane's branch.** On anything other than the default branch, `gh pr list --head <branch>` finds its PR, the PR's state and the issues it closes. Merged or closed PRs drop off after 3 days. A number in the branch name also counts as an issue: `fix/138-…`, `issue-138`, `gh-138`.
- **URLs printed in the pane.** Any `github.com/<owner>/<repo>/pull/N` or `/issues/N` URL in the last 400 lines is remembered for that agent session (the last 8). This catches PRs and issues an agent created while staying on `main`.

References to the same repo show as `#N`, and references to another repo show as `repo#N`. PR lookups are cached for 60 seconds.

## How it works

There's no daemon, and Herdr itself is not modified. The plugin reports [custom sidebar tokens](https://herdr.dev/docs/configuration), and **Configure** writes marked blocks into `config.toml` that lay them out.

- `bin/refresh.js` runs on startup and on agent status, tab and pane events. It looks up branches, PRs and issues, and sets the space headers, status lines, tab lists and panel order. Overlapping runs are serialised per session.
- `bin/live.js` runs on selection changes and every 3 seconds. It handles the activity lines, the selected agent's expansion and the window title. It's cheap: one snapshot and no git or `gh` calls.

The every-3-seconds part needs a workaround. Herdr has no timer for plugins, and it doesn't report terminal-title changes. It does re-run tab-bar status commands on an interval, so Configure installs one (`ui.tab_bar_right`) that prints nothing and runs `live.js`. If you already set `tab_bar_right` yourself, Configure leaves it alone, and activity then updates only on agent events and selection changes.

Herdr doesn't tell plugins how wide the sidebar is, so wrapped lines break at `ui.sidebar_width` (26 unless you set it). On a sidebar Herdr has widened for long space names, lines end early but are never cut off. Set `wrap_width` to match yours.

## Requirements

- Herdr ≥ 0.9.0
- Node.js ≥ 20
- `git`
- `gh`, authenticated, for PR lookups. Without it you still get everything except branch PRs.

## Install

```bash
herdr plugin install yeutterg/herdr-glance
herdr plugin action invoke yeutterg.herdr-glance.configure
```

For development, run `herdr plugin link /path/to/this/repo` instead of `install`.

Configure refuses to run if another plugin already owns `[ui.sidebar.agents]` or `[ui.sidebar.spaces]`. Run that plugin's unconfigure action first. It backs up `config.toml` to `config.toml.glance-backup` before every write, then reloads every running session.

Colours follow your `[theme] name` (Tokyo Night and Catppuccin are included). Re-run Configure after switching themes.

## Options

`$(herdr plugin config-dir yeutterg.herdr-glance)/config.json`:

```json
{
  "window_title": "Herdr: {session}",
  "nest_agents": true,
  "details": "selected",
  "wrap_width": 23
}
```

The available placeholders are `{session}`, `{agent}`, `{workspace}`, `{tab}` and `{hostname}`. `{agent}` is the focused tab as the sidebar names it (its own name, or the agent's activity when the name is generic). An empty string leaves the window title alone. Setting `nest_agents` to `false` turns off nesting and leaves the order to Herdr's `agent_panel_sort`; each agent then shows its space name on its first line. With `details` set to `"always"`, every agent shows its branch and PRs/issues, not just the selected one. `wrap_width` is the number of text columns for the selected agent's wrapped activity; it defaults to `ui.sidebar_width` minus 3.

## Actions

| Action | What it does |
|---|---|
| `configure` | Install or repair the sidebar layout and the refresh timer |
| `unconfigure` | Remove the layout, clear tokens, the agent order and the window title. Run this before uninstalling. |
| `refresh` | Repaint every running session now, bypassing the PR cache |

## Development

```bash
npm test
node bin/configure.js --print   # show the block without writing it
```
