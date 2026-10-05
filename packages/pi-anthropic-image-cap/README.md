# pi-anthropic-image-cap

Keeps image-heavy Anthropic sessions from hitting the API's request size limit.

## The problem

Anthropic rejects requests larger than 32 MB. Pi sends the whole conversation on every turn, images included, and it tracks context by tokens, not bytes. Images are cheap in tokens but heavy in bytes, so a session with a few dozen screenshots can pass 32 MB while the context is still mostly empty.

When that happens, pi treats the rejection like a full context and compacts the whole session. You lose your history at 50k tokens because of images.

## What this does

Before each request to an Anthropic model, it drops the oldest images from what gets sent. This is what Claude Code does too, as described in its docs under [Accumulating many images](https://code.claude.com/docs/en/prompt-caching#accumulating-many-images). The rules and numbers below match Claude Code 2.1.282:

- If the images add up to more than 24 MB, the oldest are dropped until they're under 14 MB.
- If there are more than 100 images (600 on 1M-context models), the oldest are dropped until there are 80 (or 580).
- Images inside tool results are replaced with `[media removed: request limit]`. Images you attached to a message are removed.

Your saved session keeps every image. Only the outgoing request changes, and nothing is summarized.

Images are dropped in batches, not one per turn. That keeps the start of the conversation the same between trims, so Anthropic's prompt cache stays valid.

It applies to every model that uses the Anthropic Messages API (`api: "anthropic-messages"`), whatever its provider, so Claude served through a proxy such as CLIProxyAPI is covered too. Models on other APIs are not touched.

## Install

```bash
pi install npm:@ogulcancelik/pi-anthropic-image-cap
```
