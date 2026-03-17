# pi-extensions

Extensions for [pi](https://github.com/badlogic/pi-mono), the terminal-based coding agent.

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [pi-spar](packages/pi-spar) | Agent-to-agent sparring with peer AI models | `@ogulcancelik/pi-spar` |
| [pi-session-recall](packages/pi-session-recall) | Search and query past sessions | `@ogulcancelik/pi-session-recall` |
| [pi-handoff](packages/pi-handoff) | Context-aware session handoff | `@ogulcancelik/pi-handoff` |
| [pi-web-browse](packages/pi-web-browse) | Web browsing via headless browser | `@ogulcancelik/pi-web-browse` |
| [pi-sketch](packages/pi-sketch) | Visual sketching tool | `@ogulcancelik/pi-sketch` |
| [pi-goal](packages/pi-goal) | Autonomous goal pursuit with sub-agents | `@ogulcancelik/pi-goal` |

## Install

```bash
pi install npm:@ogulcancelik/pi-spar
```

## Development

```bash
# Install dependencies
npm install

# Publish a single package
cd packages/pi-spar
npm publish --access public
```
