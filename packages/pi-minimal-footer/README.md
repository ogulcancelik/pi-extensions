# pi-minimal-footer

Minimal footer for [pi](https://github.com/earendil-works/pi) that replaces the default footer with a compact two-line display: context gauge on top, subscription usage bars below.

![Claude Max](assets/claude.png)

![OpenAI Codex](assets/codex.png)

## Features

- **Context gauge** — optional working directory and git branch, model, thinking level, and context window usage with token counts
- **Subscription usage bars** — rolling window quotas with reset timers for supported providers
- **Auto-refresh** — fetches usage on startup and model switch, then every 5 minutes
- **Git integration** — branch name, dirty state, ahead/behind counts

## Supported providers

| Provider       | What it shows                                          |
| -------------- | ------------------------------------------------------ |
| Claude Max     | 5h + weekly rolling windows                            |
| OpenAI Codex   | Primary + secondary rolling windows                    |
| GitHub Copilot | Premium interactions + chat quotas                     |
| Google Gemini  | Pro + Flash remaining quotas                           |
| MiniMax        | 5h + weekly rolling windows (Token Plan, credit-based)  |
| MiniMax CN     | Same as MiniMax, China endpoint                        |
| Kimi Coding    | 5h + weekly rolling windows (Plan)                     |
| OpenCode Go    | 5h + weekly + monthly usage windows                    |

### OpenAI Codex / ChatGPT models

On pi < 1.0.0 the Codex subscription was detected via the `openai-codex`
provider. Pi 1.0.0 serves those models as provider `openai` (ChatGPT OAuth with
the token sent directly to `api.openai.com`), and that direct token is rejected
by the `chatgpt.com` usage endpoint. The footer therefore resolves usage
credentials in this order:

1. `auth["openai-codex"].access` (pi < 1.0.0 OAuth login)
2. `codex login` credentials (`~/.codex/auth.json`) — same account, works with
   the usage endpoint
3. `auth["openai"].access` (pi 1.0.0 direct token; currently rejected, kept as
   a fallback)

If none of these can access the usage endpoint (for example a plain OpenAI API
key and no codex CLI login), no usage bar is shown.

## Install

```bash
pi install npm:@ogulcancelik/pi-minimal-footer
```

## Configuration

Environment variables (all optional):

| Variable                        | Description                                              | Default |
| ------------------------------- | -------------------------------------------------------- | ------- |
| `PI_MINIMAL_FOOTER_SHOW_CWD`    | Show current working directory in footer status line     | `1`     |
| `PI_MINIMAL_FOOTER_SHOW_BRANCH` | Show git branch/dirty/ahead/behind in footer status line | `1`     |
| `PI_MINIMAL_FOOTER_SHOW_PROVIDER` | Show provider/full-model-id instead of the short model ID | `0`     |

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

Anthropic's OAuth usage endpoint (`/api/oauth/usage`) rate-limits requests by `User-Agent`. Anything other than Claude Code gets persistent 429s ([claude-code#30930](https://github.com/anthropics/claude-code/issues/30930)), so the footer identifies as `claude-code/<version>`. The limit is still tight, so with many pi sessions open the bar may briefly keep showing the last known values.

## Notes

- Replaces the default pi footer entirely via `ctx.ui.setFooter()`
- Auth tokens are read from `~/.pi/agent/auth.json` (populated by `/login`) or standard env vars (`ANTHROPIC_API_KEY`, `MINIMAX_API_KEY`, etc.)
- Providers without auth simply don't show a usage bar — no errors
