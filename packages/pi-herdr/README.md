# pi-herdr

Herdr-native orchestration for [pi](https://github.com/earendil-works/pi). The package combines a structured `herdr` tool for common operations with Herdr's current agent skill for the complete installed CLI.

## Install

```bash
pi install npm:@ogulcancelik/pi-herdr
```

Or add it to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@ogulcancelik/pi-herdr"]
}
```

The extension and skill activate only inside a Herdr-managed pane with `HERDR_ENV=1` and `HERDR_PANE_ID` set.

## Invocation policy

Herdr is opt-in. The agent uses this package only when the user explicitly mentions Herdr or asks to inspect or control Herdr panes, tabs, workspaces, commands, or agents. Installing the package does not turn every background command or delegation opportunity into a Herdr workflow.

When Herdr is requested, the default topology is a sibling pane in the caller's current tab and cwd. Focus remains with the user unless `focus: true` is explicitly requested. Another tab, workspace, worktree, or cwd is used only when requested.

## Structured tool

The `herdr` tool covers the common safe orchestration surface:

| Action | Description |
|---|---|
| `list` | List panes in the caller's workspace |
| `current` | Show the caller-owned pane, independent of UI focus |
| `workspace_list` | List workspaces |
| `workspace_create` | Create a workspace and optionally alias its root pane |
| `workspace_focus` | Focus a workspace |
| `tab_list` | List tabs |
| `tab_create` | Create a tab and optionally alias its root pane |
| `tab_focus` | Focus a tab |
| `focus` | Focus a workspace, tab, or exact pane target |
| `pane_rename` | Set a visible pane label |
| `pane_split` | Split a pane and optionally alias and label the result |
| `agent_list` | List detected and reported agents |
| `agent_get` | Inspect an agent by name, terminal id, pane id, or alias |
| `run` | Submit text and Enter atomically in an existing pane |
| `read` | Read pane output |
| `watch` | Wait for output matching text or regex |
| `wait_agent` | Wait for one or more recognized agents to reach accepted statuses |
| `send` | Send literal text or keys without implicit Enter |
| `stop` | Close a pane, never the pane running the current pi process |

The tool intentionally does not mirror every Herdr command. The bundled `herdr` skill tells the agent to inspect the installed binary for less common operations such as worktrees, pane movement, resize, zoom, terminal attach, notifications, integrations, and session management. This keeps the typed tool focused while the installed Herdr CLI remains authoritative.

## Current-pane and identity behavior

Herdr now uses opaque public ids such as `w1`, `w1:t1`, `w1:p1`, and `term_...`. Encoded suffixes may contain letters. The extension reads ids from Herdr responses and never constructs them.

`current` uses `herdr pane current --current`, so it resolves the pane that launched pi rather than whichever pane another client currently focuses. Pane aliases are stored in tool-result details and reconstructed when a pi session loads or changes branches.

`pane_split` defaults to the caller's pane. If `direction` is omitted, the tool reads the source pane layout and chooses `right` for a sufficiently wide pane or `down` for a narrow or tall pane. Creation and split actions preserve UI focus unless `focus: true` is passed.

## Reading and waiting

Read sources are:

- `visible`: rendered viewport
- `recent`: recent rendered scrollback, including soft wraps
- `recent-unwrapped`: recent scrollback with soft wraps joined; preferred for logs and transcripts
- `detection`: bottom-buffer evidence used by agent detection; valid for `read`, not `watch`

Use `watch` for servers, tests, builds, and other ordinary commands. Use `wait_agent` only for panes containing recognized coding agents.

Agent statuses are:

- `working`: actively processing
- `blocked`: waiting for user input or approval
- `done`: completed and unseen
- `idle`: completed or waiting and considered seen
- `unknown`: no recognized agent state

Treat both `idle` and `done` as completed when inspecting an agent. Which one appears depends on tab visibility, client focus, and whether the completed result has been seen.

## Examples

Create and label a sibling pane using geometry-aware direction selection:

```json
{ "action": "pane_split", "newPane": "reviewer" }
```

Start an interactive agent, wait for its initial prompt, then submit work atomically:

```json
{ "action": "run", "pane": "reviewer", "command": "codex" }
```

```json
{ "action": "wait_agent", "pane": "reviewer", "status": "idle", "timeout": 30000 }
```

```json
{ "action": "run", "pane": "reviewer", "command": "Review the current diff and report actionable findings." }
```

Wait for completion whether the result is seen or unseen:

```json
{
  "action": "wait_agent",
  "pane": "reviewer",
  "statuses": ["idle", "done"],
  "mode": "any",
  "timeout": 120000
}
```

Read the resulting transcript:

```json
{ "action": "read", "pane": "reviewer", "source": "recent-unwrapped", "lines": 120 }
```

Wait for an ordinary process by output instead of agent status:

```json
{
  "action": "watch",
  "pane": "server",
  "match": "ready|listening",
  "regex": true,
  "timeout": 30000
}
```

## Package dependencies

Pi-provided runtime modules are declared as peer dependencies and are not bundled:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

The extension imports schemas from `typebox`, matching current Pi package guidance.

## Requirements

- pi 0.80 or newer
- Herdr 0.7.3 or newer
- pi running inside a Herdr pane

## License

MIT
