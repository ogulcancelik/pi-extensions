# pi-herdr

Herdr-native pane, tab, and workspace orchestration for [pi](https://github.com/badlogic/pi-mono). Run commands in existing panes, read output, wait for readiness, coordinate with other agents, and organize work across tabs and workspaces without falling back to tmux choreography.

## Install

```bash
pi install npm:@ogulcancelik/pi-herdr
```

Or add manually to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@ogulcancelik/pi-herdr"]
}
```

## What it does

Gives the agent a `herdr` tool with these actions:

| Action | Description |
|--------|-------------|
| **list** | List panes in the current herdr workspace |
| **workspace_list** | List workspaces |
| **workspace_create** | Create a workspace |
| **workspace_focus** | Focus a workspace |
| **tab_list** | List tabs in a workspace |
| **tab_create** | Create a tab |
| **tab_focus** | Focus a tab |
| **focus** | Focus a workspace, tab, or the tab containing a pane |
| **pane_split** | Split an existing pane and optionally alias the new pane |
| **run** | Submit a line atomically with Enter in an existing pane |
| **read** | Read output from a pane |
| **watch** | Wait until pane output matches text or regex |
| **wait_agent** | Wait until one or more panes running recognized coding agents reach one or more target statuses |
| **send** | Send raw text or keys to a pane without implicit Enter |
| **stop** | Close a pane |

## Why this exists

This replaces the most common `pi-tmux` workflow with herdr's native CLI wrappers:

- `herdr workspace ...`
- `herdr tab ...`
- `herdr pane split`
- `herdr pane run`
- `herdr pane read`
- `herdr wait output`
- `herdr wait agent-status`
- `herdr pane close`

That means the agent can do higher-level pane workflows with fewer brittle steps and better awareness of agent completion states like `done`.

## Defaults and behavior

- The extension returns early unless `HERDR_ENV` exists and `HERDR_PANE_ID` is present, so the `herdr` tool is not registered at all outside herdr
- Pane actions target pane identity. Use friendly aliases like `server` or `tests`, or real herdr pane ids from create/list results
- Alias state is stored in tool result details and reconstructed on session load and branch changes
- The extension preserves current focus by default. Creation flows stay in the current UI context unless `focus: true` is passed explicitly.
- `pane_split` creates a sibling pane from an existing pane in the current workspace and can remember it under `newPane`
- `workspace_create` and `tab_create` use herdr's returned `root_pane` when available, with a pane-list fallback for older herdr versions
- `run` only targets an existing pane alias or real pane id
- If an alias no longer points to a live pane, the extension removes it and returns an error
- `watch` uses `herdr wait output` and is the right wait primitive for normal processes like tests, dev servers, and build logs
- `wait_agent` uses herdr agent status information and can coordinate one pane or many panes that are running recognized coding agents
- `watch` and `wait_agent` forward pi's abort signal, so Escape cancels the wait
- `read` and `watch` support `visible`, `recent`, and `recent-unwrapped`

## Agent status semantics

Use `wait_agent` only for panes running a recognized coding agent. Do not use it to wait for normal shell commands, test runners, build processes, or dev servers. Use `watch` for output conditions and `read` for inspection.

When using `wait_agent`, herdr statuses mean:

- `working` — the agent is actively processing
- `blocked` — the agent needs user input or approval
- `done` — the agent finished in a background pane and you have not looked at it yet
- `idle` — the agent finished and the pane has already been seen
- `unknown` — no recognized agent is detected

Important workflow tips:

- if you start another agent in a background pane and want to wait for completion, **usually wait for `done`**
- if the pane is focused while the agent finishes, expect **`idle`** instead
- do **not** treat `blocked` as generic startup readiness

## Starting another pi cleanly

A good pattern for a fresh agent in another pane is to create a tab or workspace root pane, or split an existing pane, alias it, then run in that existing pane:

```json
{ "action": "tab_create", "label": "review", "pane": "reviewer" }
```

```json
{ "action": "run", "pane": "reviewer", "command": "pi --no-session --model openai-codex/gpt-5.4-mini" }
```

If model choice matters and the user has not specified one, the agent should ask which model/provider to use.

## Example workflows

Split an existing pane and remember the new sibling pane as `reviewer`:

```json
{ "action": "pane_split", "pane": "server", "direction": "right", "newPane": "reviewer" }
```

Create a tab and remember its root pane as `server`:

```json
{ "action": "tab_create", "label": "server", "pane": "server" }
```

Run a server in that existing pane:

```json
{ "action": "run", "pane": "server", "command": "bun run dev" }
```

Wait for readiness with regex:

```json
{ "action": "watch", "pane": "server", "match": "ready|listening on", "regex": true, "timeout": 30000 }
```

Read recent unwrapped logs:

```json
{ "action": "read", "pane": "server", "source": "recent-unwrapped", "lines": 40 }
```

Create a labeled tab and remember its returned root pane:

```json
{ "action": "tab_create", "workspace": "1", "label": "review", "pane": "reviewer" }
```

Run in that existing root pane:

```json
{ "action": "run", "pane": "reviewer", "command": "pi --no-session" }
```

Wait for another agent to finish in the same sense the UI shows:

```json
{ "action": "wait_agent", "pane": "reviewer", "status": "done", "timeout": 300000 }
```

Wait until a whole set of panes has settled into idle or done:

```json
{ "action": "wait_agent", "panes": ["pi-00f", "pi-010", "pi-016"], "statuses": ["idle", "done"], "mode": "all", "timeout": 300000 }
```

Focus the tab containing an existing pane id:

```json
{ "action": "focus", "pane": "w64eca6cb07ad62-2" }
```

List workspaces and tabs:

```json
{ "action": "workspace_list" }
```

```json
{ "action": "tab_list", "workspace": "1" }
```

## Notes for agents

- `pane_split`, `run`, `read`, `watch`, `wait_agent`, `send`, and `stop` target panes only. Do not pass tab ids to those actions.
- `wait_agent` accepts either `pane`/`status` for single-pane waits or `panes`/`statuses` for multi-pane waits, but only for panes running recognized coding agents. Use `mode: "all"` or `mode: "any"` to control how multi-pane waits resolve.
- `run` is the default way to submit a line or prompt to a pane because it sends text and Enter atomically.
- `send` is low-level input only. It does not press Enter. If you want text plus Enter as one action, use `run` instead of `send` + `Enter`.
- `run` only targets an existing pane. It never creates or restarts panes.
- If an alias is stale, the extension removes it and returns an error.
- `pane_split` requires `pane` and `direction`, accepts `newPane`, `cwd`, and `focus`, and returns the created pane.
- `tab_create` and `workspace_create` accept `label` and preserve current focus unless `focus: true` is passed explicitly.
- If you already know a real pane id from `list` or another herdr response, you can use it directly in `run`, `read`, `watch`, `wait_agent`, `send`, `stop`, or `focus`, even outside the alias map.
- Herdr does not currently expose direct pane focus. `focus` with a pane id focuses the pane's tab.

## Requirements

- [pi](https://github.com/badlogic/pi-mono) v0.40+
- [herdr](https://github.com/ogulcancelik/herdr)
- pi must be running inside a herdr pane

## License

MIT
