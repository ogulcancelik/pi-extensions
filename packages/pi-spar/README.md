# pi-spar

Agent-to-agent sparring for [pi](https://github.com/badlogic/pi-mono). Back-and-forth conversations with peer AI models for debugging, design review, and challenging your thinking.

## Install

```bash
pi install npm:@ogulcancelik/pi-spar
```

## Setup

Configure which models are available for sparring:

```
/spar-models
```

This shows all models from your pi configuration and lets you assign short aliases (e.g., `opus`, `gpt5`).

## Usage

The extension provides a `spar` tool the agent can use, plus commands for viewing sessions.

### Tool: `spar`

The agent uses this automatically when you ask it to consult another model:

```
"spar with gpt5 about whether this architecture makes sense"
"ask opus to review the error handling in src/auth.ts"
```

Sessions persist — follow up, push back, disagree. The peer can read files, grep, and explore your codebase but can't execute commands or write files.

### Commands

| Command | Description |
|---------|-------------|
| `/spar-models` | Configure available sparring models |
| `/peek [session]` | Watch a spar session in a floating overlay |
| `/peek-all` | List all sessions, pick one to peek |

### Peek

The peek overlay renders the spar conversation using the same components as pi's main TUI — same message styling, same syntax-highlighted tool output, same everything. It's pi inside pi.

- **j/k** or **↑/↓** — scroll
- **g/G** — jump to top/bottom
- **q** or **Esc** — close

Live sessions auto-scroll as the peer model responds.

## License

MIT
