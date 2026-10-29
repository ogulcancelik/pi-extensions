# pi-anthropic-image-cap

Keeps image-heavy Anthropic sessions from hitting the API's request size limit.

## The problem

Anthropic rejects requests larger than 128 MB or with more than 100 images (600 on 1M-context models). Pi sends the whole conversation on every turn, images included, and it tracks context by tokens, not bytes or image count. Images are cheap in tokens, so a screenshot-heavy session can hit either limit while the context is still mostly empty.

When that happens, pi treats the rejection like a full context and compacts the whole session. You lose your history early because of images.

## What this does

Before each request to an Anthropic model, it drops the oldest images from what gets sent. This is what Claude Code does too, as described in its docs under [Accumulating many images](https://code.claude.com/docs/en/prompt-caching#accumulating-many-images). The rules below match Claude Code 2.1.282, with the size limit raised for the API's new 128 MB cap:

- If the images add up to more than 120 MB, the oldest are dropped until they're under 110 MB. The last 8 MB is left for text.
- If there are more than 100 images (600 on 1M-context models), the oldest are dropped until there are 80 (or 580).
- Images inside tool results are replaced with `[media removed: request limit]`. Images you attached to a message are removed.

Your saved session keeps every image. Only the outgoing request changes, and nothing is summarized.

Images are dropped in batches, not one per turn. That keeps the start of the conversation the same between trims, so Anthropic's prompt cache stays valid.

Other providers are not touched.

## Install

```bash
pi install npm:@ogulcancelik/pi-anthropic-image-cap
```
