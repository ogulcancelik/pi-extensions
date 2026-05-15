# pi-quit-and-delete

A [pi](https://github.com/earendil-works/pi) extension that adds a keyboard shortcut to quit pi and permanently delete the active session file.

## Install

```bash
pi install npm:@ogulcancelik/pi-quit-and-delete
```

Or add manually to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@ogulcancelik/pi-quit-and-delete"]
}
```

## Usage

Press **Ctrl+Shift+X** to immediately:

1. Delete the current session `.jsonl` file from disk
2. Hard-exit pi immediately

If the session is ephemeral (in-memory, no file), pi quits without deleting anything.

## Customizing the Shortcut

### Environment Variable

Set `PI_QUIT_AND_DELETE_SHORTCUT` before running pi:

```bash
export PI_QUIT_AND_DELETE_SHORTCUT="ctrl+shift+x"
pi
```

### Settings JSON

Add to `~/.pi/agent/settings.json`:

```json
{
  "@ogulcancelik/pi-quit-and-delete": {
    "shortcut": "ctrl+shift+x"
  }
}
```

Precedence: environment variable > settings.json > default (`ctrl+shift+x`).

## License

MIT
