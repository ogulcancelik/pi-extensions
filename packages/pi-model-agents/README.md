# pi-model-agents

Steer different model families through custom AGENTS.md instructions in pi.

`pi-model-agents` keeps your normal `AGENTS.md` as the shared instruction file, then inserts an additional file based on the active model before each agent run. This lets different model families receive different behavioral guidance without changing the shared prompt.

## Install

```bash
pi install npm:@ogulcancelik/pi-model-agents
```

For local development:

```bash
pi install ~/Projects/pi-extensions/packages/pi-model-agents
```

## How it works

On every `before_agent_start` event, the extension resolves an alias for the current model and inserts matching instruction files into the system prompt.

Alias resolution order:

1. Exact model key from `model-agents.json`: `models["<provider>/<model id>"]`
2. Provider alias from `model-agents.json`: `providers["<provider>"]`
3. Raw provider name

The first matching alias wins. If its file is missing, the extension reports the missing file in `/model-agents` instead of silently falling back to a broader alias.

The resolved alias loads files named:

```text
AGENTS_<alias>.md
```

For example, alias `kimi` loads `AGENTS_kimi.md`.

The section is inserted after the last loaded `AGENTS.md` context block when possible. If Pi changes the prompt format or another extension rewrites that section, `pi-model-agents` safely falls back to appending the section at the end.

## Zero-config usage

Without a config file, the extension uses the provider name directly.

If the active model provider is `openai-codex`, it looks for:

```text
AGENTS_openai-codex.md
```

It searches beside loaded context files, including the real target of a symlinked global `~/.pi/agent/AGENTS.md`, plus `~/.pi/agent` and the project `.pi` directory.

## Config

Create `model-agents.json` beside your global `AGENTS.md`, or at `~/.pi/agent/model-agents.json`, or in the project `.pi/model-agents.json`.

Config precedence is: `PI_MODEL_AGENTS_CONFIG`, project `.pi/model-agents.json`, config beside the real global `AGENTS.md`, then `~/.pi/agent/model-agents.json`.

You can also set an explicit path:

```bash
export PI_MODEL_AGENTS_CONFIG=/path/to/model-agents.json
```

When `PI_MODEL_AGENTS_CONFIG` is set, that file is authoritative. If it is missing or invalid, the extension reports the error and does not fall back to zero-config lookup.

Example:

```json
{
  "models": {
    "fireworks/accounts/fireworks/routers/kimi-k2p6-turbo": "kimi",
    "openrouter/openai/gpt-5.1": "openai"
  },
  "providers": {
    "openai-codex": "openai",
    "anthropic": "anthropic"
  }
}
```

With that config:

```text
fireworks/accounts/fireworks/routers/kimi-k2p6-turbo -> AGENTS_kimi.md
openai-codex/* -> AGENTS_openai.md
anthropic/* -> AGENTS_anthropic.md
```

## Custom paths

Use `directories` to control where files are searched. Relative paths are resolved from the config file directory.

Global config and `PI_MODEL_AGENTS_CONFIG` are trusted and may point anywhere. Project-local `.pi/model-agents.json` is restricted to files inside the project directory, including symlink targets, so an untrusted repository cannot make the extension load arbitrary local files into the model prompt. The default project `.pi` search directory is also ignored if it is a symlink outside the project.

```json
{
  "directories": [".", "./model-agents"],
  "filenamePattern": "{alias}.md",
  "models": {
    "fireworks/accounts/fireworks/routers/kimi-k2p6-turbo": "kimi"
  }
}
```

Use `files` for explicit alias-to-file mapping. Explicit file mappings are authoritative for that alias; if the configured file is missing or blocked, the extension reports the error instead of falling back to `filenamePattern` lookup.

```json
{
  "files": {
    "kimi": "./families/kimi.md",
    "openai": "./families/openai.md"
  },
  "models": {
    "fireworks/accounts/fireworks/routers/kimi-k2p6-turbo": "kimi"
  },
  "providers": {
    "openai-codex": "openai"
  }
}
```

## Debugging

Run:

```text
/model-agents
```

It shows the current provider, model key, resolved alias, config file, loaded instruction files, searched paths, and any config or file errors.

## Notes

The extension does not mutate session history, so repeated prompts with the same model keep the same system prompt and can still get cache hits. Pi calls `before_agent_start` with the base system prompt for each new user prompt, so switching models mid-session naturally swaps the appended model-specific instructions. That switch would miss cache anyway because the provider or model changed.
