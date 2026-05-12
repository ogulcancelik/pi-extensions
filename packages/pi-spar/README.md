# pi-spar

Agent-to-agent sparring for [pi](https://github.com/earendil-works/pi). Back-and-forth conversations with peer AI models for debugging, design review, and challenging your thinking.

## Install

```bash
pi install npm:@ogulcancelik/pi-spar
```

## Setup

Configure which models are available for sparring by editing `~/.pi/agent/spar/config.json`:

```json
{
  "models": [
    { "alias": "opus", "provider": "anthropic", "id": "claude-opus-4.7", "when": "best for deep reasoning" },
    { "alias": "minimax", "provider": "minimax", "id": "minimax-m2.7", "when": "great ui/ux eye, weaker on code" }
  ]
}
```

Each entry needs `alias`, `provider`, and `id`. The optional `when` field is shown in the tool description to help the agent pick the right model for the task.

> **Note:** Changes are picked up on the next `spar` tool call — no restart needed. The `when` text is included in the live tool description the agent sees.

## Usage

The extension provides a `spar` tool the agent can use, plus commands for viewing sessions.

### Tool: `spar`

The agent uses this when you ask it to consult another model:

```
"spar with gpt about whether this architecture makes sense"
"ask opus to review the error handling in src/auth.ts"
```

Sessions persist — follow up, push back, disagree. The peer can read files, grep, and explore your codebase but can't execute commands or write files.

### Commands

| Command | Description |
|---------|-------------|
| `/spar [session]` | Watch a spar session in a floating overlay |
| `/spview` | Browse all sessions — view, peek, or delete |

### Peek overlay

`/spar` opens a floating overlay that renders the spar conversation using the same components as pi's main TUI — same message styling, same syntax-highlighted tool output, same everything. It's pi inside pi.

![peek overlay demo](./assets/peek-demo.jpg)

- **j/k** or **↑/↓** — scroll
- **g/G** — jump to top/bottom
- **q** or **Esc** — close

Live sessions auto-scroll as the peer model responds.

### Session browser

`/spview` opens an inline session browser:

- **j/k** or **↑/↓** — navigate
- **enter** — open peek overlay for selected session
- **d** — delete selected session
- **D** — delete all non-active sessions
- **q** or **Esc** — close

## License

MIT
