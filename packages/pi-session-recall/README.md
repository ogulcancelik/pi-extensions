# pi-session-recall

Give [pi](https://github.com/earendil-works/pi) access to past conversations. Ask a normal question about previous work, and the agent can find the relevant sessions and inspect them for an answer.

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

## How it works

The extension adds two tools to pi: `session_search` and `session_query`. You do not need to call them yourself. Ask the agent a natural-language question such as:

> What did we decide about authentication and security?

The agent can then:

1. Search for a few distinctive terms or exact phrases across your saved session files.
2. Review the matching snippets and select the most relevant sessions.
3. Ask `session_query` a focused question about each selected session.
4. Combine the answers and respond with the relevant decisions, changes, or context.

For example, the tool flow may look like this:

```text
You: What did we decide about authentication and security?
Agent: session_search("authentication")
Agent: session_search("security")
Agent: session_query(<matching-session>, "What decisions did we make about authentication and security?")
Agent: <answers your question>
```

Other useful prompts include:

- `How did we fix the Cannot find module '@sinclair/typebox' error?`
- `Which files did we change when we added passkey authentication?`
- `Find the session where we discussed Blender VAT baking.`
- `What approach did we reject for token refresh, and why?`

There is no background indexing or vector database. Recall happens on demand: the main agent searches session JSONL files, then an LLM reads the relevant conversation and answers a focused question.

### `session_search`

Searches all past sessions using case-insensitive, literal fixed-string matching—essentially `rg -i -F`. It is not regex or semantic search. One call should contain one distinctive token or exact phrase, such as a filename, package name, error string, function name, issue ID, or remembered wording.

Spaces are treated as part of the exact phrase. To search for separate concepts such as authentication and security, the agent makes separate calls rather than searching for `authentication security` as one phrase.

### `session_query`

Loads one selected session and sends its conversation to an LLM with a focused question. It includes user and assistant messages plus tool calls, while omitting assistant thinking and tool results to reduce cost.

For a session larger than the model's context window, it keeps the beginning, end, and sections relevant to the question. Omitted sections are marked with `[... N messages omitted ...]`.

## Configuration

To use a dedicated model for `session_query`, create or edit `~/.pi/agent/session-recall.json`:

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

- [pi](https://github.com/earendil-works/pi) v0.40+
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) — recommended for fast search, falls back to `grep` or Node-native scan

## License

MIT
