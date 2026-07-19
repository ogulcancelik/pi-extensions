# pi-auto-permissions

A context-aware permission system for Pi shell commands, with an automated guardian that checks what the user actually authorized.

Pi Auto Permissions pauses configured Bash commands before execution. A guardian model reviews the exact command against a compact view of the current conversation:

- Clearly authorized and compliant commands run automatically.
- Authorized commands that violate the user's constraints are blocked with feedback so the agent can revise them.
- Commands without clear authorization are sent to the user for confirmation.
- High-risk commands always require confirmation.

Only user messages can grant permission or impose constraints. The assistant cannot authorize its own command.

## Example

Suppose Git commits are globally guarded.

If the user says:

> Fix the failing test and commit it with a concise lowercase message.

Then a matching commit can run without another permission prompt:

```text
git commit -m "fix retry test"
```

But the guardian rejects a command that violates the request:

```text
git commit -m "Fix the Failing Retry Test and Update Documentation"
```

If the conversation never authorized a commit, an interactive Pi session asks the user before running it. A non-interactive session blocks it.

Permissions are contextual, not permanent. Each command is judged against the current conversation and the exact action being proposed.

## Install

```bash
pi install npm:@ogulcancelik/pi-auto-permissions
```

For local development:

```bash
pi install /absolute/path/to/pi-extensions/packages/pi-auto-permissions
```

Remove or disable other extensions that gate the same commands to avoid duplicate prompts.

## Define your policy

The extension ships with an empty command policy. Nothing is guarded until you add rules, and commands that do not match a rule run normally.

Configuration is read before every Bash command from:

```text
$PI_CODING_AGENT_DIR/pi-auto-permissions/config.json
```

`PI_CODING_AGENT_DIR` defaults to `~/.pi/agent`.

Here is a small starter policy for commits, pushes, and publishing:

```json
{
  "rules": [
    {
      "pattern": "\\bgit\\s+commit\\b",
      "flags": "i",
      "level": "guarded",
      "group": "git",
      "label": "Git commit"
    },
    {
      "pattern": "\\bgit\\s+push\\b",
      "flags": "i",
      "level": "guarded",
      "group": "git",
      "label": "Git push"
    },
    {
      "pattern": "\\bnpm\\s+publish\\b",
      "flags": "i",
      "level": "guarded",
      "group": "npm",
      "label": "npm publish"
    }
  ]
}
```

Rule fields are:

- `pattern`: JavaScript regular expression source
- `flags`: optional regular expression flags, defaulting to `i`
- `level`: `guarded` for guardian review or `convention` for a direct policy block
- `group`: policy group used by trusted-project bypasses
- `label`: short description shown during review
- `message`: optional feedback; required for convention rules

A convention rule blocks directly with its configured feedback instead of asking the guardian. The agent can call `request_override` for a legitimate one-session exception. Overrides require user confirmation and cannot bypass guarded rules.

Set `enabled` to `false` to disable the extension. Invalid configuration fails closed and blocks Bash calls until corrected.

## Guardian configuration

By default, the guardian uses Pi's active model with low reasoning effort and a 30-second timeout. You can select a separate low-cost model:

```json
{
  "reviewer": {
    "provider": "openai-codex",
    "model": "gpt-5.6-luna",
    "reasoningEffort": "low",
    "timeoutMs": 30000
  }
}
```

### Guardian prompt

The bundled prompt evaluates authorization, command risk, and compliance with user constraints. Replace it inline with `systemPrompt`, or load a file:

```json
{
  "systemPromptFile": "./guardian-prompt.md"
}
```

Relative paths resolve from the configuration directory. Set only one of `systemPrompt` or `systemPromptFile`.

The guardian must return one of three decisions:

- `approve`: execute the command
- `revise`: block it and tell the main agent what to correct
- `ask_user`: open Pi's normal confirmation prompt

## Conversation context and caching

The guardian receives a compact chronological view of the active conversation branch plus the exact pending command. It includes user and assistant text and small summaries of finalized tool calls, but excludes thinking, tool output bodies, file contents, patches, images, and session metadata.

The first review sends the complete compact evidence. Later reviews reuse the same reviewer session and append only newly finalized evidence and the latest action. The extension uses stable session identity, cache affinity, and long cache retention when supported by the provider. Branch changes, model or policy changes, failures, cancellation, and context pressure reset the reviewer session.

Assistant and tool evidence provide context but never grant permission. Later user messages override earlier conflicting user instructions.

Trusted projects may optionally provide their root `AGENTS.md`, or `CLAUDE.md` when no `AGENTS.md` exists, as policy evidence:

```json
{
  "reviewEvidence": {
    "projectInstructions": true
  }
}
```

Project instructions help interpret the requested workflow, but cannot independently authorize an action or override guardian policy.

## Review display

The default UI shows guardian progress in a temporary widget below the editor. Configure it with:

```json
{
  "ui": {
    "enabled": true,
    "resultDisplayMs": 2500,
    "placement": "widget"
  }
}
```

Set `placement` to `toolRow` to show the review inside Pi's Bash tool row:

```text
$ git commit --dry-run -m "fix auth"
  ◌ guardian running · Git commit · openai-codex/gpt-5.6-luna
```

`toolRow` reconstructs Pi's standard local Bash definition because Pi does not expose renderer-only decoration. Do not use it with SDK-provided, remote, sandboxed, or otherwise replaced Bash backends. The extension detects non-native Bash tools and falls back to the widget instead of replacing them.

Set `ui.enabled` to `false` to hide review state without disabling enforcement.

## Trusted groups

In a trusted project, create `.pi/trusted-ops` to bypass selected rule groups:

```text
git
gh
```

Group names come from your configured rules. A trusted group bypasses all review for that group, so use it only in projects you control.

## Failure behavior

A missing reviewer model, unavailable credentials, malformed response, timeout, cancellation, or oversized review context never auto-approves a command.

- Interactive sessions fall back to user confirmation.
- Non-interactive sessions block the command.
- Invalid configuration blocks Bash calls until corrected.

## Security boundary

Rules match raw shell text. Quoting, variables, aliases, generated scripts, or other indirection can evade a regex, while quoted command text can cause false positives.

Pi Auto Permissions is a permission layer for normal agent behavior. It is not an operating-system sandbox or a defense against hostile shell input. Pair it with sandboxing when commands need a hard security boundary.

## License

MIT
