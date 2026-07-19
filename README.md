# pi extensions

Extensions for [pi](https://github.com/earendil-works/pi), the terminal-based coding agent.

This is my working collection rather than a single polished suite. Some extensions are part of my daily setup, some are occasional tools, and others are experiments I may change or stop using. The table is sorted roughly by how actively I use them.

| Package | Description | Usage |
|---------|-------------|-------|
| [pi-minimal-footer](packages/pi-minimal-footer) | Minimal footer with context gauge and subscription usage bars | 🔥 Core |
| [pi-session-recall](packages/pi-session-recall) | Search and query past sessions — "remember when we tried X?" | 🔥 Core |
| [pi-auto-permissions](packages/pi-auto-permissions) | Context-aware Bash permissions with automated guardian review | 🟢 Active |
| [pi-codex-subagents](packages/pi-codex-subagents) | Codex-shaped, session-scoped subagents with templates, waits, steering, and a live overlay | 🟢 Active |
| [pi-handoff](packages/pi-handoff) | Transfer context to a new session with full briefing | 🟡 Moderate+ |
| [pi-quit-and-delete](packages/pi-quit-and-delete) | Keyboard shortcut to quit pi and permanently delete the active session file | 🟠 Moderate |
| [pi-ssh-tools](packages/pi-ssh-tools) | Toggle explicit SSH tools on demand via `/ssh` without replacing local tools | 🟠 Moderate |
| [pi-fork-plus](packages/pi-fork-plus) | Fork from the session tree, including editable assistant-message forks | 🧪 Experimental |
| [pi-herdr](packages/pi-herdr) | Herdr-native pane, tab, and workspace orchestration for long-running workflows | 🧪 Experimental |
| [pi-model-agents](packages/pi-model-agents) | Load model-specific AGENTS.md instructions based on the active pi model | 🧪 Experimental |
| [pi-model-thinking](packages/pi-model-thinking) | Auto-set and remember thinking levels per model | 🧪 Experimental |
| [pi-ghost](packages/pi-ghost) | Ephemeral side conversation overlay — open a temporary ghost session inside the current pi UI | ⚪ Very rare |
| [pi-ghostty-theme-sync](packages/pi-ghostty-theme-sync) | Sync pi theme with Ghostty terminal colors | ⚪ Very rare |
| [pi-goal](packages/pi-goal) | Break work into tasks, spawn parallel worker agents | ⚪ Very rare |
| [pi-sketch](packages/pi-sketch) | Visual sketching in the terminal | ⚪ Very rare |
| [pi-tmux](packages/pi-tmux) | Tmux pane management — largely superseded by Herdr | ⚪ Very rare |
| [pi-worktree](packages/pi-worktree) | Relocate the active pi session to a git worktree while preserving conversation history | ⚪ Very rare |
| [pi-web-browse](packages/pi-web-browse) | Deprecated — use [agent-skills](https://github.com/ogulcancelik/agent-skills) for web browsing | ⛔ Deprecated |

## Install

```bash
pi install npm:@ogulcancelik/<package-name>
```

See each package's README for setup and usage.
