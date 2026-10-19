# Herdr Glance

A [Herdr](https://herdr.dev) plugin that makes the sidebar answer "what is each agent doing, and what has it produced?" without clicking around.

**Agents panel**: agents are nested under their space, and each agent gets three lines, coloured by status rather than by vendor:

```
restful
  ▲ auth-refactor · blocked
  Waiting for approval to run npm install
  ⎇ fix/138-token-race · PR #142 · Issue #138

  ● working
  Fixing token refresh race in middleware
  ⎇ main
```

1. Status icon, tab name and status text. Generic tab names like `1` or `claude` are hidden.
2. The agent's live activity: the terminal title it sets, which Herdr repaints on its own.
3. Branch, PRs and issues.

Spaces appear in sidebar order. Within a space, agents waiting on you come first, then working, done and idle. This replaces Herdr's own panel order: the panel header reads **by space**, and **unconfigure** gives the order back to Herdr.

**Spaces panel**: each space lists its tabs underneath, with a status glyph per tab:

```
● restful  main ↑2
  ├ ● api
  ├ ▲ Waiting for approval to run npm…
  └ ○ docs
```

| Glyph | Meaning |
|---|---|
| `●` | working |
| `▲` | blocked: waiting on you |
| `✔` | done |
| `○` | idle |
| `·` | no agent |

Tabs with generic names show their pane's terminal title instead. Herdr gives each space one click target, so clicking a nested tab line focuses the space, not that tab.

**Window title**: the outer terminal window is titled `Herdr: <session>`. This helps tiling window managers and makes it easier to remember which session is which.

## Where PRs and issues come from

- **The pane's branch.** On anything other than the default branch, `gh pr list --head <branch>` finds its PR, the PR's state and the issues it closes. Merged or closed PRs drop off after 3 days. A number in the branch name also counts as an issue: `fix/138-…`, `issue-138`, `gh-138`.
- **URLs printed in the pane.** Any `github.com/<owner>/<repo>/pull/N` or `/issues/N` URL in the last 400 lines is remembered for that agent session (the last 8). This catches PRs and issues an agent created while staying on `main`.

References to the same repo show as `#N`, and references to another repo show as `repo#N`. PR lookups are cached for 60 seconds.

## How it works

There's no daemon. Herdr runs `bin/refresh.js` on startup and on agent status, tab and pane events, and `bin/title.js` on focus changes. Overlapping runs are serialised per session. The plugin reports [custom sidebar tokens](https://herdr.dev/docs/configuration) (`$gap`, `$group`, `$gsort`, `$branch`, `$pr`, `$pr_state`, `$issues`, `$tab1…$tab14`), sets an agent view that sorts by `$gsort`, and the **Configure** action writes a marked block into `config.toml` that lays those tokens out.

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
{ "window_title": "Herdr: {session}" }
```

The available placeholders are `{session}`, `{agent}`, `{workspace}`, `{tab}` and `{hostname}`. `{agent}` is the focused tab as the sidebar names it (its own name, or the agent's activity when the name is generic). An empty string leaves the window title alone.

## Actions

| Action | What it does |
|---|---|
| `configure` | Install or repair the sidebar layout |
| `unconfigure` | Remove the layout, clear tokens, the agent order and the window title. Run this before uninstalling. |
| `refresh` | Repaint every running session now, bypassing the PR cache |

## Development

```bash
npm test
node bin/configure.js --print   # show the block without writing it
```
