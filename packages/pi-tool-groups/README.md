# pi-tool-groups

A [pi](https://github.com/earendil-works/pi) extension that turns every tool call into a single line, so ten calls in a row no longer push the conversation off screen.

![pi-tool-groups](https://raw.githubusercontent.com/ogulcancelik/pi-extensions/main/packages/pi-tool-groups/assets/screenshot.png)

Each call shows as one line with a status mark: `✓` done, `✗` failed, `⋯` running. Click a line to see its output under it, and click again to close it. If the line had to cut the command short, the full command is shown above the output.

When the model makes several calls in a row, only the first step's "Thinking..." line is kept, so you don't get a stack of them.

## Install

```bash
pi install npm:@ogulcancelik/pi-tool-groups
```

## Keys

- **Click** a line to open or close that call.
- **ctrl+o** shows every call in full, like pi without the extension.
- **alt+o** switches to one summary line per run of calls (`▸ read 3 files · ran 2 commands`). Click a summary to list its calls.

## Notes

- Clicking needs pi's mouse support, which is on in fullscreen mode (pi's default).
- Collapsing the extra "Thinking..." lines patches how pi draws assistant messages. It only changes what's on screen, not what the model sees or what the session stores. A future pi release could break that part.
- HTML exports are not affected.

## License

MIT
