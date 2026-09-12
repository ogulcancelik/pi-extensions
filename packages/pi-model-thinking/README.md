# pi-model-thinking

Auto-set and remember thinking levels per model in pi.

No more `Ctrl+P` → `Shift+Tab` → `Shift+Tab` when switching models. This extension remembers what thinking level you set for each model and restores it automatically.

## Install

```bash
pi install npm:@ogulcancelik/pi-model-thinking
```

For local development:

```bash
pi install ~/Projects/pi-extensions/packages/pi-model-thinking
```

## How it works

The extension uses a single file: `~/.pi/agent/model-thinking.json`.

This file is both your **initial config** and your **live state**. You can seed it manually, or let it grow organically as you use pi.

### If the model is in the file

On `model_select` (Ctrl+P, /model, session restore), the extension automatically applies the stored thinking level.

### If the model is NOT in the file

The extension does nothing. Pi handles thinking natively, exactly as before.

### When you manually change thinking (Shift+Tab)

The extension writes the new level into `model-thinking.json` for that exact model. Next time you use that model — even in a new session — it starts with your chosen level.

If your change matches a provider-level default in the file, the exact model entry is cleaned up automatically.

## Config format

`~/.pi/agent/model-thinking.json`:

```json
{
  "models": {
    "anthropic/claude-sonnet-4-5": "high",
    "openai/gpt-5.2-codex": "medium"
  },
  "providers": {
    "fireworks": "low"
  }
}
```

Resolution order:
1. `models["provider/modelId"]` — exact match
2. `providers["provider"]` — provider-wide fallback
3. Not in file → extension ignores, pi handles natively

You don't need to create the file yourself. Start with no config at all and it is created the first time you change a thinking level with `Shift+Tab`.

A model is **managed** once it appears in the file (exact or by provider). For unmanaged models, pi handles thinking natively and the extension does not interfere — no entry is written until you change that model's level yourself.

## Commands

**`/model-thinking`** — shows current resolution and whether the active model is managed.

**`/model-thinking reset`** — deletes `model-thinking.json`, clearing all remembered levels.

## Example flow

Start pi with no config file:

1. Use Claude. Thinking is handled by pi natively and no file is created.
2. `Shift+Tab` change thinking to `low`. The extension creates `~/.pi/agent/model-thinking.json` and writes `"anthropic/claude-sonnet-4-5": "low"`.
3. Quit pi, start a new session, `Ctrl+P` back to Claude. Thinking is automatically `low`.
4. Switch to GPT (not in the file). Extension does nothing — pi's native default applies.
5. `Shift+Tab` on GPT to `medium`. The extension adds it to the file.
6. Switch back to Claude → `low`. Switch to GPT → `medium`. No manual tweaking needed.

Optionally seed the file first with provider-wide defaults, which are overridden per model:

```json
{
  "providers": {
    "anthropic": "high",
    "openai-codex": "medium"
  }
}
```

With that in place, `Shift+Tab` back to `high` on Claude removes the exact-model override, since it matches the provider default.