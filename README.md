# Herdr Overseer

A [Herdr](https://herdr.dev) plugin that makes the sidebar answer "what is each agent doing, and what has it produced?" without clicking around.

**Agents panel**: agents are nested under their space, with one coloured status icon each. Unselected agents take two lines: status and tab name, then one line of live activity. Select an agent (click it, or focus its pane) and it expands: the activity wraps over up to four lines, then its branch, its PRs and its issues each appear on their own lines, wrapped too. Lines with nothing to show are left out, so an agent with no known PRs or issues ends at its branch.

```
restful
  ● auth-refactor
  Waiting for approval to run npm…
  ◐ token-race                       ← selected
  Fixing the token refresh race in
  the auth middleware
  ⎇ fix/138-token-race
  PR #142
  Issue #138
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

Both levels are sorted by priority, using the same ranking as Herdr's own `priority` sort: needs you, then done (not yet viewed), working, idle, most recent change first. A space ranks by its most urgent agent, so a space with someone waiting on you jumps to the top. Herdr can't group agents itself, so the plugin sets the panel order (the header reads **priority**). Set `nest_agents` to `false` (see Options) to get Herdr's flat list back, or run **unconfigure**.

**Spaces panel**: each space lists its tabs underneath, with the same status icons:

```
● restful
  ├ ◐ api
  ├ ● Waiting for approval to run npm…
  └ ○ docs
```

There is no branch on the space line, since a space's tabs can each be on a different branch. Tabs with generic names show their pane's terminal title instead. Herdr gives each space one click target, so clicking a nested tab line focuses the space, not that tab.

**Agent overview** (optional): a full-screen tab, one per space, showing only that space's agents:

```
 dark-factory agents   ● 1 needs you  ·  ◐ 1 working  ·  ○ 1 idle
──────────────────────────────────────────────────────────────────
▸ ● review-fix                                  claude · needs you 2m
    Waiting for approval to run npm install
    ⎇ fix/138-login
    PR #142
    Issue #138
    ✎ 10:42 check the migration before approving
    latest output
    │ Do you want to proceed? (y/n)

  ◐ api                                           codex · working 14m
    Refactoring the session store
```

It has two views; switch with `tab` (or `1` / `2`).

**1 agents.** Each agent shows its status and how long it has been in it (counted from when the tab opened), its activity, branch, PRs/issues and your notes. The selected agent also shows its last few lines of output.

**2 git.** Every repo the space's agents touch, as a tree. Each branch shows its commits ahead (`↑`) and behind (`↓`) the default branch and its uncommitted files (`✚`). Under each branch are the agent tabs working on it and the branch's PR, with the issues it closes. PRs and issues an agent linked in repos nobody has checked out are listed under those repos, with the agent that linked them, their title, and their state (draft, merged, closed). Worktrees are grouped with their repo.

```
 ■ restful-orchestrator  LiveRestful
  ├─⎇ feature/brightstart-contracts  ↑5  ↓63  ✚90
▸ │    ◐ manual updates
  │    ◐ battery health
  └─PR #64  ← manual updates  Define owner update request contract

 □ restful-cloud  LiveRestful  linked, not checked out here
    PR #606  ← manual updates  v2: truthful owner firmware-update requests
    PR #608 merged  ← app: fix brightstart bounce back  fix: retain applied configuration
```

Keys (both views):

| Key | Action |
|---|---|
| `↑` `↓` or `j` `k` | select |
| `enter` | jump to the agent |
| `n` | add a note |
| `x` | delete the latest note |
| `tab`, `1`, `2` | switch view |
| `q` | close the tab |

Open overview tabs restart themselves when the plugin's code changes, so updates show up without reopening them.

Notes are kept per agent session, so they follow an agent across pane moves and restarts. An agent with notes gets a `✎` in the sidebar.

A new overview tab opens as the first tab in its space; move it anywhere and it stays put. To open one, run **Overview: open for this space** (`yeutterg.herdr-overseer.overview`). To add one to every space, run **Overview: open in every space** (`overview-all`). Either way, a space that already has an overview tab just gets it focused. You can bind a key to an action in Herdr's `config.toml`:

```toml
[[keys.command]]
key = "prefix+o"
type = "plugin_action"
command = "yeutterg.herdr-overseer.overview"
description = "agent overview"
```

**Window title**: the outer terminal window is titled `Herdr: <session>`. This helps tiling window managers and makes it easier to remember which session is which.

## Where PRs and issues come from

- **The pane's branch.** On anything other than the default branch, `gh pr list --head <branch>` finds its PR, the PR's state and the issues it closes. Merged or closed PRs drop off after 3 days. A number in the branch name also counts as an issue: `fix/138-…`, `issue-138`, `gh-138`.
- **URLs printed in the pane.** Any `github.com/<owner>/<repo>/pull/N` or `/issues/N` URL in the last 400 lines is remembered for that agent session (the last 8). This catches PRs and issues an agent created while staying on `main`.

References to the same repo show as `#N`, and references to another repo show as `repo#N`. PR lookups are cached for 60 seconds.

## How it works

There's no daemon, and Herdr itself is not modified. The plugin reports [custom sidebar tokens](https://herdr.dev/docs/configuration), and **Configure** writes marked blocks into `config.toml` that lay them out.

- `bin/refresh.js` runs on startup and on agent status, tab and pane events. It looks up branches, PRs and issues, and installs the panel order. Overlapping runs are serialised per session.
- `bin/live.js` runs on selection changes and every 3 seconds. It handles everything that comes from Herdr's own state: the priority order, space headers, status icons, the Spaces tab list, activity lines, the selected agent's expansion and the window title. It's cheap: one snapshot, no git or `gh` calls, and only changed tokens are sent.

The every-3-seconds part needs a workaround. Herdr has no timer for plugins, and it doesn't report terminal-title changes. It does re-run tab-bar status commands on an interval, so Configure installs one (`ui.tab_bar_right`) that prints nothing and runs `live.js`. If you already set `tab_bar_right` yourself, Configure leaves it alone, and activity then updates only on agent events and selection changes.

Herdr doesn't tell plugins how wide the sidebar is, so wrapped lines break at `ui.sidebar_width` (26 unless you set it). On a sidebar Herdr has widened for long space names, lines end early but are never cut off. Set `wrap_width` to match yours.

## Requirements

- Herdr ≥ 0.9.0
- Node.js ≥ 20
- `git`
- `gh`, authenticated, for PR lookups. Without it you still get everything except branch PRs.

## Install

```bash
herdr plugin install yeutterg/herdr-overseer
herdr plugin action invoke yeutterg.herdr-overseer.configure
```

For development, run `herdr plugin link /path/to/this/repo` instead of `install`.

Configure refuses to run if another plugin already owns `[ui.sidebar.agents]` or `[ui.sidebar.spaces]`. Run that plugin's unconfigure action first. It backs up `config.toml` to `config.toml.overseer-backup` before every write, then reloads every running session.

Colours follow your `[theme] name` (Tokyo Night and Catppuccin are included). Re-run Configure after switching themes.

## Options

`$(herdr plugin config-dir yeutterg.herdr-overseer)/config.json`:

```json
{
  "window_title": "Herdr: {session}",
  "nest_agents": true,
  "details": "selected",
  "wrap_width": 23,
  "overview": true
}
```

The available placeholders are `{session}`, `{agent}`, `{workspace}`, `{tab}` and `{hostname}`. `{agent}` is the focused tab as the sidebar names it (its own name, or the agent's activity when the name is generic). An empty string leaves the window title alone. Setting `overview` to `false` turns off the overview actions. Setting `nest_agents` to `false` turns off nesting and leaves the order to Herdr's `agent_panel_sort`; each agent then shows its space name on its first line. With `details` set to `"always"`, every agent shows its branch and PRs/issues, not just the selected one. `wrap_width` is the number of text columns for the selected agent's wrapped activity; it defaults to `ui.sidebar_width` minus 3.

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
