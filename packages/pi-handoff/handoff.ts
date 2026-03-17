/**
 * Handoff extension — transfer context to a new focused session.
 *
 * Three triggers:
 *
 * 1. /handoff <instruction> (user-initiated)
 *    Tells the current agent to write a handoff prompt with the given focus,
 *    then call the handoff tool to start a new session.
 *
 * 2. handoff tool (agent-initiated)
 *    The agent writes the handoff prompt directly and starts a new session.
 *
 * 3. Context guard (automatic)
 *    At 90% context usage, prompts the user to handoff. If the user confirms
 *    or is AFK (60s timeout), tells the agent to call the handoff tool.
 *
 * Usage:
 *   /handoff focus on the combat sim changes, especially the Unity port
 *   /handoff continue with phase two of the refactor plan
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONTEXT_THRESHOLD_PERCENT = 90;
const AFK_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Shared: build the parent session reference for the final prompt
// ---------------------------------------------------------------------------

function buildFinalPrompt(body: string, sessionFile: string | undefined): string {
	if (sessionFile) {
		return (
			`**Parent session:** \`${sessionFile}\`\n` +
			`Use \`session_query("${sessionFile}", "<your question>")\` if you need more detail from the previous session.\n\n` +
			body
		);
	}
	return body;
}

// ---------------------------------------------------------------------------
// handoff tool — agent writes the prompt, starts new session
// ---------------------------------------------------------------------------

async function agentHandoff(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	prompt: string,
): Promise<string | undefined> {
	if (!ctx.hasUI) {
		return "Handoff requires interactive mode.";
	}

	const currentSessionFile = ctx.sessionManager.getSessionFile();
	const finalPrompt = buildFinalPrompt(prompt, currentSessionFile);

	// Defer to next tick so the tool_result is recorded in the OLD session first
	setTimeout(async () => {
		const switchResult = await ctx.newSession({ parentSession: currentSessionFile });
		if (switchResult.cancelled) return;
		pi.sendUserMessage(finalPrompt, { deliverAs: "followUp" });
	}, 0);

	return undefined;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// ── Context guard state ────────────────────────────────────────────────
	let contextGuardPrompted = false;

	pi.on("session_start", () => {
		contextGuardPrompted = false;
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (contextGuardPrompted) return;
		if (!ctx.hasUI) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.percent === null || usage.percent < CONTEXT_THRESHOLD_PERCENT) return;

		contextGuardPrompted = true;
		const pct = Math.round(usage.percent);
		const sessionBefore = ctx.sessionManager.getSessionId();

		const choice = await ctx.ui.select(
			`Context at ${pct}% — handoff to a new session?`,
			["Yes, handoff", "No, keep going"],
			{ timeout: AFK_TIMEOUT_MS },
		);

		// Session changed while waiting (e.g. handoff tool fired) — bail
		if (ctx.sessionManager.getSessionId() !== sessionBefore) return;

		if (choice === "No, keep going") return;

		if (!choice) {
			ctx.ui.notify("No response — auto-handoff to preserve context.", "warning");
		}

		pi.sendMessage(
			{
				customType: "context-guard-handoff",
				content:
					`Context is at ${pct}%. Handoff to a new session now. ` +
					`Use the handoff tool — write a thorough prompt for the next agent that includes ` +
					`all relevant context, decisions, files involved, and what to do next.`,
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});

	// ── /handoff command ───────────────────────────────────────────────────
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			const instruction = args.trim();
			if (!instruction) {
				ctx.ui.notify("Usage: /handoff <what to focus on for the new session>", "error");
				return;
			}

			pi.sendMessage(
				{
					customType: "user-handoff",
					content:
						`The user wants to handoff to a new session. Their instruction: "${instruction}"\n\n` +
						`Use the handoff tool — write a complete prompt for the next agent. ` +
						`Incorporate the user's instruction as the focus. Include all relevant context, ` +
						`decisions, files involved, and what to do next.`,
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
	});

	// ── handoff tool ───────────────────────────────────────────────────────
	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Transfer context to a new focused session. ONLY use this when the user explicitly asks for a handoff. " +
			"You are starting a new session — the next agent has NO context from this conversation. " +
			"Write a complete, self-contained prompt that includes: " +
			"(1) relevant context and decisions from this session, " +
			"(2) files involved, " +
			"(3) what the next agent should do. " +
			"Be thorough — this is the only briefing the next agent gets.",
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"The complete handoff prompt for the next session's agent. Include all necessary context, files, and the task.",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const error = await agentHandoff(pi, ctx, params.prompt);
			return {
				content: [{ type: "text", text: error ?? "Handoff complete. New session started." }],
			};
		},
	});
}
