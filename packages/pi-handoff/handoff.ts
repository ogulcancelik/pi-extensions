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
const CONTEXT_GUARD_STATE_TYPE = "pi-handoff:context-guard-state";

interface ContextGuardState {
	suppressed: boolean;
	reason: "declined" | "dismissed";
}

type ContextGuardSessionManager = Pick<ExtensionCommandContext["sessionManager"], "getBranch">;

interface PendingHandoff {
	prompt: string;
	parentSession: string | undefined;
}

// ---------------------------------------------------------------------------
// Shared helpers
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

function isContextGuardState(value: unknown): value is ContextGuardState {
	if (!value || typeof value !== "object") return false;

	const candidate = value as Partial<ContextGuardState>;
	return (
		candidate.suppressed === true &&
		(candidate.reason === "declined" || candidate.reason === "dismissed")
	);
}

function isContextGuardSuppressed(sessionManager: ContextGuardSessionManager): boolean {
	const branch = sessionManager.getBranch();

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== CONTEXT_GUARD_STATE_TYPE) continue;
		return isContextGuardState(entry.data) && entry.data.suppressed;
	}

	return false;
}

function suppressContextGuard(pi: ExtensionAPI, reason: ContextGuardState["reason"]): void {
	pi.appendEntry(CONTEXT_GUARD_STATE_TYPE, {
		suppressed: true,
		reason,
	} satisfies ContextGuardState);
}

// ---------------------------------------------------------------------------
// handoff helpers
// ---------------------------------------------------------------------------

function queueHandoff(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionCommandContext, "hasUI" | "sessionManager">,
	prompt: string,
): PendingHandoff | string {
	if (!ctx.hasUI) {
		return "Handoff requires interactive mode.";
	}

	const pendingHandoff: PendingHandoff = {
		prompt,
		parentSession: ctx.sessionManager.getSessionFile(),
	};

	pi.sendUserMessage("/handoff-resume", { deliverAs: "followUp" });
	return pendingHandoff;
}

async function resumeHandoff(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	pendingHandoff: PendingHandoff,
): Promise<void> {
	const finalPrompt = buildFinalPrompt(pendingHandoff.prompt, pendingHandoff.parentSession);
	const switchResult = await ctx.newSession({ parentSession: pendingHandoff.parentSession });
	if (switchResult.cancelled) {
		ctx.ui.notify("New session cancelled", "info");
		return;
	}

	pi.sendUserMessage(finalPrompt);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// ── Context guard state ────────────────────────────────────────────────
	let contextGuardPrompted = false;
	let contextGuardSuppressed = false;
	let pendingHandoff: PendingHandoff | undefined;

	pi.on("session_start", (_event, ctx) => {
		contextGuardPrompted = false;
		contextGuardSuppressed = isContextGuardSuppressed(ctx.sessionManager);
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (contextGuardPrompted || contextGuardSuppressed) return;
		if (!ctx.hasUI) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.percent === null || usage.percent < CONTEXT_THRESHOLD_PERCENT) return;

		contextGuardPrompted = true;
		const pct = Math.round(usage.percent);
		const sessionBefore = ctx.sessionManager.getSessionId();

		const timeoutController = new AbortController();
		let didTimeout = false;
		const timeoutId = setTimeout(() => {
			didTimeout = true;
			timeoutController.abort();
		}, AFK_TIMEOUT_MS);

		const choice = await ctx.ui.select(
			`Context at ${pct}% — handoff to a new session?`,
			["Yes, handoff", "No, keep going"],
			{ signal: timeoutController.signal },
		);

		clearTimeout(timeoutId);

		// Session changed while waiting (e.g. handoff tool fired) — bail
		if (ctx.sessionManager.getSessionId() !== sessionBefore) return;

		if (choice === "No, keep going") {
			contextGuardSuppressed = true;
			suppressContextGuard(pi, "declined");
			return;
		}

		if (!choice && !didTimeout) {
			contextGuardSuppressed = true;
			suppressContextGuard(pi, "dismissed");
			return;
		}

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

	pi.registerCommand("handoff-resume", {
		description: "Complete a queued handoff",
		handler: async (_args, ctx) => {
			if (!pendingHandoff) {
				ctx.ui.notify("No pending handoff.", "error");
				return;
			}

			const handoff = pendingHandoff;
			pendingHandoff = undefined;
			await resumeHandoff(pi, ctx, handoff);
		},
	});

	// ── handoff tool ───────────────────────────────────────────────────────
	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Transfer context to a new focused session. ONLY use this when the user explicitly asks for a handoff. " +
			"NEVER call this yourself — only when the user says 'handoff' or the context guard at 90% triggers it. " +
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
			const result = queueHandoff(pi, ctx, params.prompt);
			if (typeof result === "string") {
				return {
					content: [{ type: "text", text: result }],
					details: {},
				};
			}

			pendingHandoff = result;
			return {
				content: [{ type: "text", text: "Handoff queued. New session will start after this turn." }],
				details: {},
			};
		},
	});
}
