# pi-web-browse

Web search and content extraction skill for [pi](https://github.com/badlogic/pi-mono). Search the web and fetch pages via a real headless browser (CDP).

**Works on Linux, macOS, and Windows.**

## Features

- 🔍 **Web Search** - Search via Google (falls back to DuckDuckGo if blocked)
- 🌐 **Page Fetching** - Extract readable content from any URL
- 🤖 **Bot Protection Bypass** - Handles JS challenges, Cloudflare, etc.
- 🚀 **Persistent Daemon** - Warm browser session for fast subsequent requests
- 🖥️ **Cross-Platform** - Auto-detects Chrome, Brave, Edge, Chromium

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
| `WEB_BROWSE_BROWSER_BIN` | Browser binary path | Auto-detected, prefers Chrome |
| `WEB_BROWSE_USER_AGENT` | Override User-Agent string | Auto-derived from detected browser + OS |
| `WEB_BROWSE_DAEMON_PORT` | Daemon HTTP port | 9377 |
| `WEB_BROWSE_CDP_PORT` | Chrome DevTools port | 9225 |
| `WEB_BROWSE_DEBUG_DUMP` | Save debug files on failure | off |

By default, the hidden profile is browser-specific (for example `~/.config/web-browse-cdp-profile-chrome` or `~/.config/web-browse-cdp-profile-brave`) so updates do not try to reuse the same hidden profile across different Chromium-family browsers.

## Browser Detection

The skill auto-detects browsers in common locations and now prefers Chrome first, because Google Search is less likely to challenge headless Chrome than headless Brave on some setups.

- **Linux:** google-chrome, google-chrome-stable, brave, brave-browser, chromium (from PATH)
- **macOS:** Google Chrome, Google Chrome Canary, Brave Browser, Edge, Chromium (in /Applications)
- **Windows:** Chrome, Brave, Edge, Chromium (Program Files, LocalAppData)

If you want Brave anyway, set `WEB_BROWSE_BROWSER_BIN` or pass `--browser-bin`.

## How It Works

1. **Search** - Uses Google via a persistent headless browser session. If Google blocks the request, it fails fast and falls back to DuckDuckGo.
2. **Fetch** - Opens URLs in the same hidden browser session, waits for JS, and extracts readable content.
3. **Daemon** - Keeps a warm, browser-specific hidden profile/session alive for speed and bot-protection resilience without touching your normal browser profile.

## License

MIT
