# pi-handoff

Discontinued.

I am not using this extension anymore.

## Why

The original goal of `pi-handoff` was agent-driven session handoff: let the current agent prepare the handoff and start the next session directly.

That depends on an API shape upstream pi still does not expose cleanly: extension tools cannot start a new session themselves in the same way command handlers can.

Without that, the extension ends up needing awkward workarounds:

- hidden in-band prompts to make the current agent draft a handoff
- scraping assistant replies back out of the session
- brittle timing around when a new session should start

That is not robust enough to keep using.

## What I use instead

I now use the upstream handoff example directly:

- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/handoff.ts

That approach is simpler and more reliable:

1. read the current branch messages
2. make a separate summarization call to generate the handoff prompt
3. let the user review/edit it
4. start the new session

It gives up the old "agent starts the next session itself" idea, but it works cleanly on upstream pi.

## Status

This package is kept here as a discontinued experiment / reference, not an actively used extension.

## License

MIT
