# pi-codex-compaction

> [!WARNING]
> This extension is under active development. Its behavior may change.

OpenAI Codex native remote compaction integrated into Pi's existing compaction lifecycle.

Pi 0.84.4 or later is recommended. Older releases use a compatibility fallback for safe mid-run compaction.

## Why native compaction

Pi normally summarizes older messages as text. This extension instead asks OpenAI Codex for its native opaque compaction checkpoint and stores that checkpoint in Pi's real compaction entry. Pi therefore stops rebuilding and rendering the replaced transcript, while OpenAI receives its native compacted history on later requests.

## How it works

On Pi 0.84.4 and later, Pi owns compaction timing and continuation. It triggers compaction manually, at its configured context threshold, or during overflow recovery. Threshold checks run after tools finish and before the next assistant response, so long tool-driven runs compact and resume without being aborted or restarted.

On older Pi releases, the extension enables its legacy 90% guard. It stops before the next provider request, invokes Pi's compaction lifecycle after the run settles, and resumes only when needed. The fallback turns off automatically after Pi is upgraded.

When the active model uses `openai-codex/openai-codex-responses`, the extension handles Pi's `session_before_compact` event. It sends the finalized Responses history to the Codex endpoint with a trailing `compaction_trigger`, stores the returned opaque `compaction` item in Pi's compaction entry, and lets Pi continue the same run with the rebuilt context.

Pi requires compaction events to store a summary string, so each entry receives a short local checkpoint marker. The marker is filtered from provider context and is never sent to OpenAI.

In interactive mode, each native compaction adds `OpenAI compaction running…` and completion or failure markers to the chat transcript. These durable TUI entries are never included in model context.

## Install

```bash
pi install npm:@ogulcancelik/pi-codex-compaction
```

## Behavior

Native compaction activates only for `openai-codex`. Other providers never receive the opaque checkpoint or the local marker; after a provider switch they can see only Pi messages that remain outside the native checkpoint. The extension performs no text-summary model call.

Native checkpoints are persisted in `CompactionEntry.details`. Resume, forks, tree navigation, and repeated compaction derive state from the newest checkpoint on the active branch. The request advertises Codex's `remote_compaction_v2` feature on compaction and follow-up calls.

Compaction is fail-closed. If a native request fails, Pi's compaction is cancelled and the previous history remains intact. The extension never silently falls back to Pi text summarization. If a persisted native checkpoint is malformed or belongs to another Codex model, the next request is aborted rather than sending Pi's local marker to OpenAI.

## Configuration

On Pi 0.84.4 and later, configure compaction through Pi in `~/.pi/agent/settings.json` or project-local `.pi/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

Pi compacts when context exceeds `contextWindow - reserveTokens`. For example, a `reserveTokens` value of `27200` gives a 90% threshold for a 272k context window.

On older Pi releases only, the fallback defaults to `autoCompact: true` and `thresholdRatio: 0.9`. Existing `~/.pi/agent/pi-codex-compaction.json` and project-local `.pi/pi-codex-compaction.json` overrides remain supported until Pi is upgraded.

## Data handling

The current conversation is sent to the ChatGPT Codex Responses endpoint. OpenAI returns an opaque `encrypted_content` value, which is stored in the local Pi session JSONL and replayed to OpenAI on compatible subsequent requests.

## Limitations

Native checkpoints are model-specific. Switch back to the model that created the checkpoint before continuing. Provider switching is not a portability path because no textual summary is generated.

Pi does not expose a finalized provider payload during `session_before_compact`. The extension mirrors Pi's Codex message conversion and combines it with the latest observed request shape to construct the compaction request. Extensions loaded later that independently rewrite provider payloads can therefore create order-dependent behavior.
