# pi-herdr

Pi-native tools for controlling [Herdr](https://github.com/ogulcancelik/herdr) layouts, terminal panes, and coding agents.

## Install

```bash
pi install npm:@ogulcancelik/pi-herdr
```

Or add the package to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@ogulcancelik/pi-herdr"]
}
```

The extension activates only when Pi runs inside a Herdr-managed pane with `HERDR_ENV=1` and `HERDR_PANE_ID` set.

This package provides structured Pi tools only. It does not bundle Herdr's standalone agent skill. Install that skill separately when you want direct access to the complete installed CLI.

## Execution model

Herdr exposes three distinct primitives:

- Layout organizes terminal locations. Workspaces contain tabs, and tabs contain panes.
- Pane controls a raw terminal containing a shell, test, server, build, log, or other ordinary process.
- Agent controls a recognized coding agent currently occupying a pane.

A pane exists independently of an agent. Starting an agent requires an existing pane at an available interactive shell prompt and never creates or changes layout.

The extension registers one tool for each primitive.

### `herdr_layout`

Use `herdr_layout` to inspect and create workspaces, tabs, and panes, or move panes between tabs and workspaces.

| Action | Description |
|---|---|
| `current` | Inspect the pane running the current Pi process |
| `machine_list` | List saved Herdr SSH machines |
| `workspace_list` | List workspaces |
| `workspace_create` | Create a workspace, first tab, and root pane |
| `workspace_focus` | Focus a workspace |
| `tab_list` | List tabs |
| `tab_create` | Create a tab and root pane |
| `tab_focus` | Focus a tab |
| `pane_list` | List panes in a workspace |
| `pane_layout` | Inspect pane geometry |
| `pane_split` | Split an existing pane |
| `pane_move` | Move a pane into an existing tab, a new tab, or a new workspace |

Creation defaults to the caller pane's foreground working directory and preserves UI focus. When `pane_split` omits a direction, the tool chooses right for a sufficiently wide pane and down for a narrow or tall pane.

Workspace, tab, and pane IDs are opaque. Always use IDs returned by Herdr instead of constructing them.

#### Moving a pane

`pane_move` requires an explicit `pane` and exactly one destination mode:

- `tab` with a required `direction` of `right` or `down`. Optional `targetPane` selects the destination pane to split; otherwise Herdr uses the tab's focused pane. Optional `ratio` sets the split ratio.
- `newTab: true`. Optional `workspace` selects the destination workspace; otherwise Herdr uses the source workspace. Optional `label` names the new tab.
- `newWorkspace: true`. Optional `label` names the new workspace and `tabLabel` names its first tab.

`workspace` is only valid with `newTab`, not as a substitute for `tab`. Moves preserve UI focus unless `focus: true`. Pass `machine` as usual for a saved SSH machine; moves stay on that machine.

```json
{ "action": "pane_move", "pane": "w1:p2", "tab": "w2:t1", "direction": "right", "targetPane": "w2:p1", "ratio": 0.5 }
```

```json
{ "action": "pane_move", "pane": "w1:p2", "newTab": true, "workspace": "w2", "label": "review" }
```

```json
{ "action": "pane_move", "pane": "w1:p2", "newWorkspace": true, "label": "review", "tabLabel": "agent" }
```

The pane ID can change after a move, especially across workspaces. The result reports the returned pane ID, tab ID, and workspace ID. Use that pane ID for all subsequent calls, not the old ID. Agent names follow the pane and remain valid targets for `herdr_agent`. Do not move panes you did not create unless the user explicitly asks.

### `herdr_pane`

Use `herdr_pane` for ordinary commands and intentional raw terminal control.

| Action | Description |
|---|---|
| `get` | Inspect a pane |
| `run` | Submit a shell command atomically with Enter |
| `read` | Read terminal output |
| `wait_output` | Wait for literal or regular-expression output |
| `send_text` | Send literal text without Enter |
| `send_keys` | Send logical terminal keys |
| `close` | Close a pane other than the pane running Pi |

`wait_output` searches existing output immediately before waiting for future output. Use `recent-unwrapped` for logs and transcripts.

Pane actions do not validate coding-agent identity or interpret agent lifecycle. Use `herdr_agent` when a pane contains a recognized coding agent.

### `herdr_agent`

Use `herdr_agent` to control a recognized coding agent by unique live name or by its hosting pane ID.

| Action | Description |
|---|---|
| `list` | List recognized agents |
| `get` | Inspect an agent |
| `start` | Start a supported agent in an existing available shell pane |
| `prompt` | Submit a prompt and optionally wait for settlement |
| `wait` | Wait for lifecycle state |
| `read` | Read the resolved agent terminal stream |
| `send_keys` | Send validated logical keys to the agent UI |
| `focus` | Focus the agent's pane |
| `rename` | Set or clear a live agent name |

Agent targets accept a unique live agent name or the pane ID currently hosting that agent. They do not accept terminal IDs or bare agent-kind labels.

Lifecycle states are:

- `working`: actively processing
- `blocked`: waiting for approval or an answer
- `done`: ready after unseen background work completed
- `idle`: ready and considered seen
- `unknown`: present, but lifecycle cannot be classified confidently

`prompt` waits by default and settles on the first `idle`, `done`, or `blocked` state unless `until` narrows the accepted states. A prompt submitted from a non-working state must produce an observed lifecycle change within five seconds or Herdr returns `agent_prompt_stalled`.

## Typical workflows

Start a coding agent in a sibling pane:

```json
{ "action": "pane_split" }
```

Use the returned pane ID:

```json
{
  "action": "start",
  "name": "reviewer",
  "kind": "codex",
  "pane": "w1:p2"
}
```

Prompt it and wait for settlement:

```json
{
  "action": "prompt",
  "target": "reviewer",
  "prompt": "Review the current diff and report only actionable findings.",
  "timeout": 120000
}
```

Read the result:

```json
{
  "action": "read",
  "target": "reviewer",
  "source": "recent-unwrapped",
  "lines": 120
}
```

For an ordinary command, split a pane with `herdr_layout`, submit the command with `herdr_pane run`, then use `herdr_pane wait_output` or `herdr_pane read`.

## Saved SSH machines

Every tool accepts an optional `machine`: the label or ID of a machine saved with `herdr machine add`. Without it, tools target the local Herdr server. With it, each call runs as `herdr --machine <machine> ...` against that machine's session.

Find saved machines first:

```json
{ "action": "machine_list" }
```

Then pass the label to every call for that machine:

```json
{ "action": "list", "machine": "devbox" }
```

Workspace, tab, and pane IDs belong to one machine. `w1:p1` on a remote machine is unrelated to `w1:p1` locally.

The caller's pane is local, so nothing defaults to it on a remote machine:

- `current` is local only.
- `pane_split` and `pane_layout` require `pane`. `pane_move` always requires it, locally or remotely.
- `tab_create` requires `workspace`.
- `pane_list` without `workspace` lists every pane on the machine.
- Creation actions pass `cwd` only when given, or for `pane_split`, the source pane's cwd. Otherwise the remote server picks.
- `close` does not apply the caller-pane guard.

## Invocation policy

The tools are opt-in. Pi uses them only when the user explicitly mentions Herdr or asks to inspect or control Herdr. Installing this package does not turn general background work or delegation into a Herdr workflow.

The default topology is a sibling pane in the caller's current tab and working directory. Focus remains with the user. Another tab, workspace, worktree, or working directory is used only when requested.

## Output limits

Read output is truncated to the last 2,000 lines or 50KB, whichever is reached first.

Full-screen agents may render through the terminal's alternate screen. Rows that leave that screen do not enter Herdr's host scrollback. If increasing `lines` does not reveal the complete response, ask the agent to write its response to a temporary Markdown file and read that file directly.

## Requirements

- Pi 0.80 or newer
- Herdr 0.7.5 or newer
- Herdr 0.9.1 or newer on both machines to use `machine`
- Pi running inside a Herdr pane

## License

MIT
