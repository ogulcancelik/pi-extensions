# pi-session-recall

Recall past [pi](https://github.com/badlogic/pi-mono) sessions. Search through conversation history and query specific sessions with an LLM.

## Install

```bash
pi install npm:@ogulcancelik/pi-session-recall
```

Or add manually to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@ogulcancelik/pi-session-recall"]
}
```

## What it does

Two tools that let the agent recall past sessions:

### `session_search`

Literal text search across all past sessions using ripgrep-style fixed-string matching. It is not semantic search. The agent should search for one distinctive token or exact phrase at a time, such as a filename, package name, error string, function name, issue id, or remembered wording.

Spaces mean exact spaces in an exact phrase. For unrelated concepts, the agent should call `session_search` multiple times instead of combining them into one query.

### `session_query`

Deep-dives into a specific session file. Loads the conversation, sends it to an LLM, and answers your question about it.

For large sessions that exceed the model's context window, it uses smart windowing: keeps the first/last messages plus keyword-relevant sections, marking gaps with `[... N messages omitted ...]`.

### `/session-recall`

Command to configure which model is used for `session_query`. Opens a picker with all your available models.

By default, queries use your **current session model**. If you want to save tokens, pick a cheaper model (e.g. Haiku, GPT-4o mini).

## Configuration

Config is stored at `~/.pi/agent/session-recall.json`:

```json
{
  "queryModel": {
    "provider": "anthropic",
    "id": "claude-haiku-4-5"
  }
}
```

If no model is configured (or the configured model isn't available), it falls back to whatever model is active in your current session.

## Requirements

- [pi](https://github.com/badlogic/pi-mono) v0.40+
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) — recommended for fast search, falls back to `grep` or Node-native scan

## License

MIT
