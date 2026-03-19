# pi-ghostty-theme-sync

Sync [pi](https://github.com/badlogic/pi-mono) theme with your active [Ghostty](https://ghostty.org/) terminal colors.

![demo](assets/demo.gif)

On startup, the extension runs `ghostty +show-config`, generates a pi theme, and switches pi to it.

## install

```bash
pi install npm:@ogulcancelik/pi-ghostty-theme-sync
```

(Optional, try without installing):

```bash
pi -e npm:@ogulcancelik/pi-ghostty-theme-sync
```

## how it works

- Reads: `background`, `foreground`, and `palette[0..15]` from Ghostty.
- Computes a hash of `bg/fg + palette[0..15]`.
- Writes a theme to: `~/.pi/agent/themes/ghostty-sync-<hash>.json`.
- Removes older `ghostty-sync-*.json` files (keeps only the current one).
- Sets pi theme to `ghostty-sync-<hash>`.

## mapping notes

Uses ANSI slot semantics:

- `palette[1]` → `error`
- `palette[2]` → `success`
- `palette[3]` → `warning`
- `palette[4]` → `link` (links/borders)
- `palette[5]` → `accent` (primary highlight)
- `palette[6]` → `accentAlt` (secondary highlight)

Neutrals (`muted`, `dim`, subtle borders) are derived from `background` + `foreground` instead of trusting `palette[0]`/`palette[8]`.

## requirements

- Ghostty installed and `ghostty` available in `PATH`

## license

MIT
