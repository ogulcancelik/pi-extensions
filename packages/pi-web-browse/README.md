# pi-web-browse

Web search and content extraction skill for [pi](https://github.com/badlogic/pi-mono). Search the web and fetch pages via a real headless browser (CDP).

**Works on Linux, macOS, and Windows.**

## Features

- 🔍 **Web Search** - Search via Google (falls back to DuckDuckGo if blocked)
- 🌐 **Page Fetching** - Extract readable content from any URL
- 🤖 **Bot Protection Bypass** - Handles JS challenges, Cloudflare, etc.
- 🚀 **Persistent Daemon** - Warm browser session for fast subsequent requests
- 🖥️ **Cross-Platform** - Auto-detects Brave, Chrome, Edge, Chromium

## Install

```bash
pi install npm:@ogulcancelik/pi-web-browse
```

Or via git:

```bash
pi install github.com/ogulcancelik/pi-web-browse
```

(Optional, try without installing):

```bash
pi -e npm:@ogulcancelik/pi-web-browse
```

After first use, the agent will guide you through setup.

## Usage

The agent will automatically use this skill when you ask it to search the web or fetch page content.

You can also invoke it directly:

```bash
/skill:web-browse "rust async runtime"
```

## Configuration

Environment variables (all optional):

| Variable | Description | Default |
|----------|-------------|---------|
| `WEB_BROWSE_BROWSER_BIN` | Browser binary path | Auto-detected |
| `WEB_BROWSE_USER_AGENT` | User-Agent string | Chrome on Windows |
| `WEB_BROWSE_DAEMON_PORT` | Daemon HTTP port | 9377 |
| `WEB_BROWSE_CDP_PORT` | Chrome DevTools port | 9225 |
| `WEB_BROWSE_DEBUG_DUMP` | Save debug files on failure | off |

## Browser Detection

The skill auto-detects browsers in common locations:

- **Linux:** brave, brave-browser, google-chrome, chromium (from PATH)
- **macOS:** Brave Browser, Google Chrome, Chromium, Edge (in /Applications)
- **Windows:** Brave, Chrome, Edge, Chromium (Program Files, LocalAppData)

## How It Works

1. **Search** - Uses Google via headless browser (falls back to DuckDuckGo if blocked)
2. **Fetch** - Opens URL in headless Chromium, waits for JS, extracts readable content
3. **Daemon** - Keeps a warm browser session for speed + bot-protection bypass

## License

MIT
