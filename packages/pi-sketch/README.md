# pi-sketch

Quick sketch pad for [pi](https://github.com/badlogic/pi-mono) - draw in browser, send to models.

![demo](https://raw.githubusercontent.com/ogulcancelik/pi-sketch/main/assets/demo.gif)

## Install

```bash
pi install npm:@ogulcancelik/pi-sketch
```

Or try without installing:

```bash
pi -e npm:@ogulcancelik/pi-sketch
```

## Usage

```
/sketch
```

Opens a canvas in your browser. Draw your sketch, press Enter to send.

## Features

- **Quick sketches** - draw arrows, boxes, diagrams
- **Clipboard paste** - `Ctrl+V` to paste screenshots, annotate on top
- **Colors** - black, red, green, blue, white (eraser)
- **Brush sizes** - 1, 2, 3 keys
- **Undo** - Z key
- **Cancel from pi** - Escape key in terminal

## Workflow

1. `/paint` - opens browser canvas (URL shown as fallback)
2. Draw your sketch
3. `Ctrl+V` to paste and annotate screenshots
4. Press Enter in browser to save
5. `Sketch: /path` appears in your editor - add context and send

## Keyboard Shortcuts (in browser)

| Key | Action |
|-----|--------|
| `Enter` | Send sketch |
| `Escape` | Cancel |
| `C` | Clear canvas |
| `Z` | Undo |
| `1-3` | Brush size |
| `Ctrl+V` | Paste image |

## License

MIT
