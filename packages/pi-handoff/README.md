# pi-handoff

Context-aware session handoff for [pi](https://github.com/badlogic/pi-mono). Transfer context to a new session via command, tool, or automatic context guard.

## Install

```bash
pi install npm:@ogulcancelik/pi-handoff
```

Or add manually to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@ogulcancelik/pi-handoff"]
}
```

## What it does

Three ways to hand off context to a fresh session:

### `/handoff <instruction>`

User-initiated. Tell the agent what to focus on — it writes a complete handoff prompt and starts a new session.

```
/handoff continue with phase two of the refactor plan
/handoff focus on the combat sim changes, especially the Unity port
```

### `handoff` tool

Agent-initiated. The agent writes the handoff prompt directly when asked. The prompt includes all relevant context, decisions, files, and next steps so the new session can continue without the old conversation.

### Context guard (automatic)

At **90% context usage**, you get a prompt:

```
Context at 92% — handoff to a new session?
> Yes, handoff
  No, keep going
```

If you pick yes — or don't respond within 60 seconds — the agent automatically writes a handoff prompt and starts a new session. No context lost silently.

## How it works

1. The agent writes a self-contained prompt summarizing the current session
2. A new session is created (with parent session tracking)
3. The handoff prompt is delivered to the new session as the first message
4. The prompt includes a reference to the parent session file

## Pairs well with pi-session-recall

The handoff prompt includes a parent session reference. If you also have [pi-session-recall](https://github.com/ogulcancelik/pi-session-recall) installed, the new session can query the parent for additional context using `session_query` — useful when the agent needs details that didn't make it into the handoff prompt.

```bash
pi install npm:@ogulcancelik/pi-session-recall
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono) v0.40+

## License

MIT
