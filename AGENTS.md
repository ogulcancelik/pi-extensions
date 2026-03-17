# Agent Instructions

Pi extensions monorepo. Each package in `packages/` is an independent pi extension published to npm under `@ogulcancelik/`.

## Structure

```
packages/
  pi-spar/          # agent-to-agent sparring
  pi-session-recall/ # search past sessions
  pi-handoff/       # session context transfer
  pi-web-browse/    # headless browser browsing
  pi-sketch/        # visual sketching
  pi-goal/          # autonomous goal pursuit
```

Each package has its own `package.json` with `"pi": { "extensions": [...] }` declaring entry points.

## Writing Extensions

Extensions are TypeScript loaded by pi via [jiti](https://github.com/unjs/jiti) — no build step. The entry point exports a default function receiving `ExtensionAPI`.

Available imports:
- `@mariozechner/pi-coding-agent` — extension types, components, utilities
- `@mariozechner/pi-tui` — TUI components (Text, Container, SelectList, etc.)
- `@mariozechner/pi-ai` — AI types (Message, Model, StringEnum)
- `@sinclair/typebox` — schema definitions for tool parameters

Pi extension docs: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md

## Adding a Package

1. Create `packages/pi-<name>/` with `package.json`, `index.ts`, `README.md`, `LICENSE`
2. Use `@ogulcancelik/pi-<name>` as the npm package name
3. Set `"pi": { "extensions": ["./index.ts"] }` in package.json

## Publishing

```bash
cd packages/pi-<name>
npm version patch   # or minor/major
npm publish --access public
```

Then commit the version bump and push.

## Conventions

- TypeScript, no build step
- Lowercase, conventional commits, no emojis
- Each package is independent — no cross-package dependencies
