# pi-worktree

Relocate the active [pi](https://github.com/earendil-works/pi) session to another git working tree while preserving the full conversation history. When you create a new worktree or switch to another repository and want to keep working there without losing context, this extension forks the session file, moves it to the new directory, and auto-continues.

## Install

```bash
pi install npm:@ogulcancelik/pi-worktree
```

Or add manually to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@ogulcancelik/pi-worktree"]
}
```

## What it does

### `switch_worktree` tool

Validates that the target path is inside a non-bare git working tree, then pre-fills the editor with `/switch-worktree <path>`. Press Enter to confirm the relocation.

### `/switch-worktree` command

Direct command for manual relocation. Usage:

```
/switch-worktree <path>
```

## How the switch works

1. Validates the path is inside a non-bare git working tree
2. Forks the current session file to the worktree directory via `SessionManager.forkFrom`
3. Removes the `parentSession` reference so the forked session is standalone
4. Switches the active session to the new file
5. Deletes the old session file
6. Sends an auto-continue message so work resumes automatically

## Herdr integration

When running inside [herdr](https://github.com/ogulcancelik/herdr) (`HERDR_ENV` is set), the extension emits `herdr:blocked` events so the UI can show a pending state while waiting for the user to press Enter. Outside herdr, these events are silently skipped.

## Requirements

- [pi](https://github.com/earendil-works/pi) v0.40+
- Git

## License

MIT
