# pi-minimal-footer

Minimal footer for [pi](https://github.com/badlogic/pi-mono) that replaces the default footer with a compact two-line display: context gauge on top, subscription usage bars below.

![Claude Max](assets/claude.png)

![OpenAI Codex](assets/codex.png)

## Features

- **Context gauge** — optional working directory and git branch, model, thinking level, and context window usage with token counts
- **Subscription usage bars** — rolling window quotas with reset timers for supported providers
- **Auto-refresh** — fetches usage on startup and model switch, then every 5 minutes
- **Git integration** — branch name, dirty state, ahead/behind counts

## Supported providers

| Provider | What it shows |
|----------|---------------|
| Claude Max | 5h + weekly rolling windows |
| OpenAI Codex | Primary + secondary rolling windows |
| GitHub Copilot | Premium interactions + chat quotas |
| Google Gemini | Pro + Flash remaining quotas |
| MiniMax | 5h + weekly rolling windows (Token Plan / Coding Plan) |
| MiniMax CN | Same as MiniMax, China endpoint |

## Install

```bash
pi install npm:@ogulcancelik/pi-minimal-footer
```

## Configuration

Environment variables (all optional):

| Variable | Description | Default |
|----------|-------------|---------|
| `PI_MINIMAL_FOOTER_SHOW_CWD` | Show current working directory in footer status line | `1` |
| `PI_MINIMAL_FOOTER_SHOW_BRANCH` | Show git branch/dirty/ahead/behind in footer status line | `1` |

Accepted false values: `0`, `false`, `no`, `off` (case-insensitive).

## How it works

The footer reads context usage from the last assistant message's token counts (free — comes with every LLM response). Subscription usage is fetched from each provider's dedicated quota API using your existing auth tokens from `~/.pi/agent/auth.json` or environment variables.

Usage is fetched:
- Once on startup
- Immediately on model switch (Ctrl+P)
- Every 5 minutes after that

Git state is refreshed:
- Once on startup
- When pi reports a branch change
- At the end of each turn

The footer adapts to narrow terminals by stacking lines vertically instead of the single-line wide layout.

## Known issues

### Claude Max usage bar not showing

Anthropic's OAuth usage endpoint (`/api/oauth/usage`) has been returning persistent 429 (rate limit) errors since late March 2026, affecting all third-party tools that display Claude usage data (CodexBar, oh-my-claudecode, claude-pulse, etc.). This is an Anthropic-side issue — tracked in [claude-code#30930](https://github.com/anthropics/claude-code/issues/30930) and [claude-code#31021](https://github.com/anthropics/claude-code/issues/31021). The usage bar will start working again once Anthropic fixes the endpoint.

## Notes

- Replaces the default pi footer entirely via `ctx.ui.setFooter()`
- Auth tokens are read from `~/.pi/agent/auth.json` (populated by `/login`) or standard env vars (`ANTHROPIC_API_KEY`, `MINIMAX_API_KEY`, etc.)
- Providers without auth simply don't show a usage bar — no errors
