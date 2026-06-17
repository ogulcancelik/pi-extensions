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
    { "alias": "opus", "provider": "anthropic", "id": "claude-opus-4.7", "thinking": "xhigh", "when": "best for deep reasoning" },
    { "alias": "minimax", "provider": "minimax", "id": "minimax-m2.7", "thinking": "low", "when": "great ui/ux eye, weaker on code" },
    { "alias": "researcher", "provider": "openai", "id": "gpt-5.5", "tools": "read,grep,find,ls,bash", "skills": ["pi-web-browse"], "when": "can browse through the web-browse skill" }
  ]
}
```

Each entry needs `alias`, `provider`, and `id`. The optional `thinking` field sets the model's default thinking level for new spar sessions. If omitted, spar uses `high`. A tool call can still pass an explicit `thinking` value to override the config. The optional `tools` field sets the peer's tool list for new sessions; default is `read,bash,grep,find,ls`. The optional `skills` field attaches skill names or paths to new sessions. The optional `when` field is shown in the tool description to help the agent pick the right model for the task.

Valid thinking values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Skills are instructions, not tools; include `bash` if you override `tools` for a skill that needs shell commands.

> **Note:** Changes are picked up on the next `spar` tool call — no restart needed. The configured thinking, tools, skills, and `when` text are included in the live tool description the agent sees.

## Usage

The extension provides a `spar` tool the agent can use, plus commands for viewing sessions.

### Tool: `spar`

The agent uses this when you ask it to consult another model:

```
"spar with gpt about whether this architecture makes sense"
"ask opus to review the error handling in src/auth.ts"
```

Sessions persist — follow up, push back, disagree. The peer excludes mutating edit/write tools by default, and the agent can explicitly choose broader tools or skills when creating a session. Existing sessions keep their original model, tools, and skills.

### Commands

| Command | Description |
|---------|-------------|
| `/spar [session]` | Watch a spar session in a floating overlay |
| `/spview` | Browse all sessions — view, peek, or delete |

### Peek overlay

`/spar` opens a floating overlay that renders the spar conversation using the same components as pi's main TUI — same message styling, same syntax-highlighted tool output, same everything. It's pi inside pi.

![peek overlay demo](./assets/peek-demo.jpg)

- **j/k** or **↑/↓** — scroll by line
- **ctrl+u/ctrl+d** — scroll half-page
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
