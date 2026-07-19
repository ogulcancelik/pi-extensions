# pi-codex-subagents

Codex-shaped, session-scoped subagents for [Pi](https://github.com/earendil-works/pi). Spawn isolated child Pi processes, wait for their final responses, steer active work, and inspect sessions in a live overlay.

Requires Pi 0.80.4 or newer and Node.js 22.19 or newer.

## Install

```bash
pi install npm:@ogulcancelik/pi-codex-subagents
```

For local development:

```bash
pi install /absolute/path/to/pi-extensions/packages/pi-codex-subagents
```

## Tools

| Tool | Purpose |
|---|---|
| `spawn_agent` | Spawn a fresh-context child Pi process |
| `wait_agent` | Wait for one completion and return its final text |
| `wait_all_agents` | Wait for every selected agent |
| `list_agents` | List current-session agents, or explicitly include historical sessions |
| `read_agent_response` | Read an agent's latest final raw text response |
| `send_message` | Steer a running agent or start another turn when settled |
| `interrupt_agent` | Abort the current turn while preserving its session for later messages |

Agent names are unique within their parent session. The same task name can exist safely in different Pi sessions. Read and control tools are always scoped to the current parent session; only `list_agents(include_all: true)` crosses session boundaries, and that view is read-only.

## Agent templates

Templates are user-defined Markdown files in:

```text
~/.pi/agent/pi-codex-subagents/agents/*.md
```

No templates are installed automatically. Example:

```md
---
name: reviewer
description: Focused read-only code review agent
provider: openai-codex
model: gpt-5.6-sol
thinking: high
tools: read,bash,grep,find,ls
skills: web-investigate
extensions: @scope/pi-extra-tools, ~/.pi/agent/extensions/local-helper.ts
hint: Give this reviewer exact file paths and a narrow scope.
---
You are a focused review subagent. Return concise findings with file paths.
```

`provider` and `model` are an optional pair. When both are present, Pi launches that exact provider/model combination. If either is absent, the child inherits the parent agent's provider and model. `thinking` is also optional and otherwise inherits the parent. Template `tools` override inherited tool names.

`skills` may contain skill names or paths. `extensions` may contain local files/directories or npm package names already installed by Pi. Package names are resolved from project-local packages first and then Pi's global npm directory. Missing packages are never installed automatically.

When a template loads extensions but omits `tools`, the child uses Pi's normal tool activation so tools registered by those extensions are available. Set template `tools` when you want an explicit allowlist. Without configured extensions, omitted template tools inherit the parent's active tool names as before.

Automatic extension, skill, and prompt-template discovery is disabled in children. Only explicitly configured skills and extensions load. If the inherited parent model comes from an extension-registered provider, add that provider extension to the selected template; otherwise the isolated child cannot resolve the provider.

## Configuration

Optional configuration lives at:

```text
~/.pi/agent/pi-codex-subagents/config.json
```

```json
{
  "storageDir": "~/.local/state/pi-codex-subagents/runs",
  "retentionDays": 7,
  "defaults": {
    "skills": ["web-investigate"],
    "extensions": ["@scope/pi-extra-tools"]
  }
}
```

`storageDir` accepts an absolute path, `~/...`, or a path relative to the package configuration directory. By default runs are stored in `~/.pi/agent/pi-codex-subagents/runs`. `retentionDays` defaults to `7`; expired runs and oversized tool outputs are removed when the extension loads. Set it to `0` to disable automatic cleanup. Runtime sockets remain in the operating system temporary directory and are removed when agents stop.

Configuration is read when agents spawn, while cleanup runs when the extension loads. Restart Pi after changing `storageDir` or `retentionDays` so storage lookup and cleanup use the same configuration throughout the process.

Template skills and extensions override configured defaults. Skills explicitly requested by the parent are added to configured template/default skills. Tool selection belongs to the template or is inherited from the parent.

## Commands

`/agents` browses agents in the current session. Press Tab to switch to the read-only all-sessions view. `/subagent <task-name>` opens one current-session agent directly.

The overlay uses the child working directory for tool rendering and synchronizes in-progress output when opened midway through a run. Use Left/Right to switch between agents in the current browser scope.

Child RPC processes are terminated after completion, failure, or interruption so settled agents do not keep consuming memory. `send_message` starts a fresh child process with the persisted session and continues from there. On startup, the extension also reconciles and terminates validated owned children left behind by an earlier extension process.

## Output limits

Wait and response tools follow Pi's standard 50 KB / 2,000-line output limit. Oversized output is truncated and the complete text is written beside the runtime data; the returned notice includes a path that can be read with Pi's `read` tool.

## Environment

`PI_SUBAGENT_PI_BIN` overrides the Pi executable used for child processes. Normally children use the same Pi installation as the parent.

## License

MIT
