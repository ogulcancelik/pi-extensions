import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ReplacedSessionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const DEFAULT_CONTEXT_THRESHOLD_PERCENT = 95;
const STATE_ENTRY = "pi-goal:state";
const CONTINUE_MESSAGE_TYPE = "pi-goal:continue";
const BUDGET_MESSAGE_TYPE = "pi-goal:budget-limit";
const HANDOFF_MESSAGE_TYPE = "pi-goal:handoff";
const SUMMARY_MESSAGE_TYPE = "pi-goal:summary";

type GoalStatus = "active" | "paused" | "budget_limited" | "handoff_started" | "complete" | "cleared";

type GoalStateEvent =
	| "created"
	| "status_changed"
	| "continued"
	| "budget_limited"
	| "handoff_requested"
	| "handoff_completed"
	| "completed"
	| "cleared";

interface GoalStateEntry {
	version: 1;
	event: GoalStateEvent;
	goalId: string;
	objective?: string;
	status?: GoalStatus;
	thresholdPercent?: number;
	contextPercent?: number | null;
	contextTokens?: number | null;
	contextWindow?: number | null;
	sessionIndex?: number;
	parentSession?: string;
	currentSession?: string;
	handoffPrompt?: string;
	timestamp: number;
}

interface GoalRuntimeState {
	goalId: string;
	objective: string;
	status: GoalStatus;
	thresholdPercent: number;
	sessionIndex: number;
	sessions: string[];
	parentSession?: string;
	currentSession?: string;
	lastContextPercent: number | null;
	lastContextTokens: number | null;
	contextWindow: number | null;
	lastHandoffPrompt?: string;
	continuationInFlight: boolean;
	handoffInFlight: boolean;
}

let runtimeState: GoalRuntimeState | null = null;
let capturedCommandContext: ExtensionCommandContext | undefined;

function newGoalId(): string {
	return `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function shortObjective(objective: string, max = 64): string {
	const oneLine = objective.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, max - 1)}…`;
}

function pushUnique(values: string[], value: string | undefined): void {
	if (!value || values.includes(value)) return;
	values.push(value);
}

function usageFields(usage: ContextUsage | undefined, fallback?: GoalRuntimeState) {
	return {
		contextPercent: usage?.percent ?? fallback?.lastContextPercent ?? null,
		contextTokens: usage?.tokens ?? fallback?.lastContextTokens ?? null,
		contextWindow: usage?.contextWindow ?? fallback?.contextWindow ?? null,
	};
}

function applyEntry(state: GoalRuntimeState | null, entry: GoalStateEntry): GoalRuntimeState | null {
	if (!entry || entry.version !== 1 || !entry.goalId) return state;

	if (!state || entry.event === "created" || state.goalId !== entry.goalId) {
		if (!entry.objective) return state;
		state = {
			goalId: entry.goalId,
			objective: entry.objective,
			status: entry.status ?? "active",
			thresholdPercent: entry.thresholdPercent ?? DEFAULT_CONTEXT_THRESHOLD_PERCENT,
			sessionIndex: entry.sessionIndex ?? 1,
			sessions: [],
			parentSession: entry.parentSession,
			currentSession: entry.currentSession,
			lastContextPercent: entry.contextPercent ?? null,
			lastContextTokens: entry.contextTokens ?? null,
			contextWindow: entry.contextWindow ?? null,
			lastHandoffPrompt: entry.handoffPrompt,
			continuationInFlight: false,
			handoffInFlight: entry.status === "budget_limited" || entry.status === "handoff_started",
		};
	}

	if (!state || state.goalId !== entry.goalId) return state;

	if (entry.objective) state.objective = entry.objective;
	if (entry.status) state.status = entry.status;
	if (entry.thresholdPercent) state.thresholdPercent = entry.thresholdPercent;
	if (typeof entry.sessionIndex === "number") state.sessionIndex = entry.sessionIndex;
	if (entry.parentSession) state.parentSession = entry.parentSession;
	if (entry.currentSession) state.currentSession = entry.currentSession;
	if (entry.contextPercent !== undefined) state.lastContextPercent = entry.contextPercent;
	if (entry.contextTokens !== undefined) state.lastContextTokens = entry.contextTokens;
	if (entry.contextWindow !== undefined) state.contextWindow = entry.contextWindow;
	if (entry.handoffPrompt) state.lastHandoffPrompt = entry.handoffPrompt;

	pushUnique(state.sessions, entry.parentSession);
	pushUnique(state.sessions, entry.currentSession);

	state.handoffInFlight = state.status === "budget_limited" || state.status === "handoff_started";
	return state;
}

function reconstructState(ctx: ExtensionContext): GoalRuntimeState | null {
	let state: GoalRuntimeState | null = null;
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		state = applyEntry(state, entry.data as GoalStateEntry);
	}
	runtimeState = state;
	return state;
}

function setController(ctx: ExtensionCommandContext | ReplacedSessionContext | undefined): void {
	capturedCommandContext = ctx;
}

function appendState(pi: ExtensionAPI, event: GoalStateEvent, patch: Partial<GoalStateEntry> = {}): GoalStateEntry | null {
	const current = runtimeState;
	const goalId = patch.goalId ?? current?.goalId;
	if (!goalId) return null;

	const entry: GoalStateEntry = {
		version: 1,
		event,
		goalId,
		thresholdPercent: patch.thresholdPercent ?? current?.thresholdPercent ?? DEFAULT_CONTEXT_THRESHOLD_PERCENT,
		timestamp: Date.now(),
		...patch,
	};

	pi.appendEntry(STATE_ENTRY, entry);
	runtimeState = applyEntry(runtimeState, entry);
	return entry;
}

function updateUsage(state: GoalRuntimeState, usage: ContextUsage | undefined): void {
	if (!usage) return;
	state.lastContextPercent = usage.percent;
	state.lastContextTokens = usage.tokens;
	state.contextWindow = usage.contextWindow;
}

function formatPercent(value: number | null | undefined): string {
	if (value === null || value === undefined) return "?";
	return `${Math.round(value)}%`;
}

function formatContext(state: GoalRuntimeState): string {
	return `${formatPercent(state.lastContextPercent)} / ${state.thresholdPercent}%`;
}

function goalSessionName(objective: string, sessionIndex: number): string {
	const base = `goal: ${shortObjective(objective, 52)}`;
	return sessionIndex <= 1 ? base : `${base} (${sessionIndex})`;
}

function updateTui(ctx: ExtensionContext, state = runtimeState): void {
	if (!ctx.hasUI) return;

	if (!state || state.status === "cleared") {
		ctx.ui.setStatus("goal", undefined);
		ctx.ui.setWidget("goal", undefined);
		return;
	}

	let status = "goal: ";
	if (state.status === "active") status += `active ${formatPercent(state.lastContextPercent)}`;
	else if (state.status === "budget_limited") status += `budget ${formatPercent(state.lastContextPercent)}`;
	else if (state.status === "handoff_started") status += `handoff ${state.sessionIndex}`;
	else if (state.status === "paused") status += "paused";
	else if (state.status === "complete") status += "complete";
	ctx.ui.setStatus("goal", status);

	if (state.status === "complete") {
		ctx.ui.setWidget("goal", undefined);
		return;
	}

	let next = "continuing automatically";
	if (state.status === "paused") next = "paused by user";
	if (state.status === "budget_limited") next = "waiting for goal_handoff";
	if (state.status === "handoff_started") next = "starting linked handoff session";

	ctx.ui.setWidget("goal", [
		`Goal: ${shortObjective(state.objective, 90)}`,
		`Status: ${state.status.replace(/_/g, "-")} · context ${formatContext(state)} · session ${state.sessionIndex}`,
		`Next: ${next}`,
	]);
}

function buildInitialPrompt(objective: string): string {
	return [
		"Active goal started.",
		"",
		"Objective:",
		objective,
		"",
		"Work toward this objective. Before declaring completion, audit the actual current state: files, command output, tests, and other concrete evidence. If the goal is achieved and no required work remains, call update_goal with status \"complete\". If not complete, continue with the next concrete action.",
	].join("\n");
}

function buildContinuationPrompt(state: GoalRuntimeState): string {
	return [
		"Continue the active goal.",
		"",
		"Objective:",
		state.objective,
		"",
		`Context usage: ${formatContext(state)}.`,
		"Do not repeat completed work. Use the conversation history and concrete evidence. Before declaring completion, audit files, command output, tests, and other concrete state. Call update_goal with status \"complete\" only when the objective is actually complete and no required work remains. Otherwise continue with the next concrete action.",
	].join("\n");
}

function buildBudgetPrompt(state: GoalRuntimeState): string {
	return [
		`The active goal has reached the context budget limit at ${formatPercent(state.lastContextPercent)} of the model context window.`,
		"",
		"Do not start new substantive work in this session. Prepare a complete handoff for the next session and call goal_handoff.",
		"",
		"The handoff must include:",
		"- The active objective.",
		"- What has been completed.",
		"- Important decisions and constraints.",
		"- Files and commands that matter.",
		"- Known blockers or risks.",
		"- The exact next action the next session should take.",
		"",
		"Do not call update_goal unless the goal is actually complete.",
	].join("\n");
}

function buildManualHandoffPrompt(state: GoalRuntimeState): string {
	return [
		"The user requested a handoff for the active goal now.",
		"",
		"Do not start new substantive work in this session. Prepare a complete handoff for the next session and call goal_handoff.",
		"",
		"Objective:",
		state.objective,
		"",
		"The handoff must include completed work, decisions and constraints, files and commands that matter, blockers or risks, and the exact next action.",
	].join("\n");
}

function sendHidden(pi: ExtensionAPI, customType: string, content: string): void {
	pi.sendMessage(
		{
			customType,
			content,
			display: false,
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}

function queueInitialContinuation(pi: ExtensionAPI, state: GoalRuntimeState): void {
	state.continuationInFlight = true;
	sendHidden(pi, CONTINUE_MESSAGE_TYPE, buildInitialPrompt(state.objective));
}

function queueContinuation(pi: ExtensionAPI, state: GoalRuntimeState): void {
	state.continuationInFlight = true;
	appendState(pi, "continued", {
		status: "active",
		currentSession: state.currentSession,
		...usageFields(undefined, state),
	});
	sendHidden(pi, CONTINUE_MESSAGE_TYPE, buildContinuationPrompt(state));
}

function requestBudgetHandoff(pi: ExtensionAPI, ctx: ExtensionContext, state: GoalRuntimeState, usage: ContextUsage | undefined): void {
	updateUsage(state, usage);
	state.status = "budget_limited";
	state.handoffInFlight = true;
	state.continuationInFlight = false;
	appendState(pi, "budget_limited", {
		status: "budget_limited",
		currentSession: ctx.sessionManager.getSessionFile(),
		...usageFields(usage, state),
	});
	updateTui(ctx, state);
	if (ctx.hasUI) ctx.ui.notify("Goal context budget reached. Requesting handoff.", "warning");
	sendHidden(pi, BUDGET_MESSAGE_TYPE, buildBudgetPrompt(state));
}

function buildSummary(ctx: ExtensionContext, state = runtimeState): string {
	const usage = ctx.getContextUsage();
	if (state && usage) updateUsage(state, usage);

	if (!state || state.status === "cleared") {
		return "No active goal. Start one with `/goal <objective>`.";
	}

	const lines = [
		`Goal: ${state.objective}`,
		`Status: ${state.status.replace(/_/g, "-")}`,
		`Context: ${formatContext(state)}`,
		`Threshold: ${state.thresholdPercent}%`,
		`Session index: ${state.sessionIndex}`,
	];

	if (state.currentSession) lines.push(`Current session: ${state.currentSession}`);
	if (state.parentSession) lines.push(`Parent session: ${state.parentSession}`);
	if (state.sessions.length > 0) lines.push(`Lineage: ${state.sessions.join(" -> ")}`);
	if (state.lastHandoffPrompt) lines.push(`Last handoff: ${shortObjective(state.lastHandoffPrompt, 160)}`);

	lines.push("", "Controls: `/goal pause`, `/goal resume`, `/goal handoff`, `/goal clear`.");
	if (!capturedCommandContext) {
		lines.push("Automatic new-session handoff controller is not captured. Run `/goal resume` to restore it.");
	}
	return lines.join("\n");
}

function sendVisibleSummary(pi: ExtensionAPI, content: string): void {
	pi.sendMessage({ customType: SUMMARY_MESSAGE_TYPE, content, display: true });
}

function isNonTerminal(state: GoalRuntimeState | null): boolean {
	return !!state && state.status !== "complete" && state.status !== "cleared";
}

function startGoal(pi: ExtensionAPI, ctx: ExtensionContext, objective: string, commandCtx?: ExtensionCommandContext): GoalRuntimeState {
	const usage = ctx.getContextUsage();
	const currentSession = ctx.sessionManager.getSessionFile();
	const goalId = newGoalId();

	runtimeState = {
		goalId,
		objective,
		status: "active",
		thresholdPercent: DEFAULT_CONTEXT_THRESHOLD_PERCENT,
		sessionIndex: 1,
		sessions: currentSession ? [currentSession] : [],
		currentSession,
		lastContextPercent: usage?.percent ?? null,
		lastContextTokens: usage?.tokens ?? null,
		contextWindow: usage?.contextWindow ?? null,
		continuationInFlight: false,
		handoffInFlight: false,
	};

	if (commandCtx) setController(commandCtx);

	appendState(pi, "created", {
		goalId,
		objective,
		status: "active",
		thresholdPercent: DEFAULT_CONTEXT_THRESHOLD_PERCENT,
		sessionIndex: 1,
		currentSession,
		...usageFields(usage, runtimeState),
	});

	pi.setSessionName(goalSessionName(objective, 1));
	updateTui(ctx, runtimeState);
	if (ctx.hasUI) ctx.ui.notify("Goal started.", "info");

	if (usage?.percent !== null && usage?.percent !== undefined && usage.percent >= DEFAULT_CONTEXT_THRESHOLD_PERCENT) {
		requestBudgetHandoff(pi, ctx, runtimeState, usage);
	} else {
		queueInitialContinuation(pi, runtimeState);
	}

	return runtimeState;
}

function pauseGoal(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const state = runtimeState ?? reconstructState(ctx);
	if (!state || state.status === "cleared") return "No active goal to pause.";
	state.status = "paused";
	state.continuationInFlight = false;
	state.handoffInFlight = false;
	appendState(pi, "status_changed", { status: "paused", currentSession: ctx.sessionManager.getSessionFile() });
	updateTui(ctx, state);
	if (ctx.hasUI) ctx.ui.notify("Goal paused.", "info");
	return "Goal paused.";
}

function resumeGoal(pi: ExtensionAPI, ctx: ExtensionCommandContext): string {
	const state = runtimeState ?? reconstructState(ctx);
	if (!state || state.status === "cleared") return "No goal to resume.";
	if (state.status === "complete") return "Goal is already complete.";
	setController(ctx);
	const usage = ctx.getContextUsage();
	updateUsage(state, usage);
	state.status = "active";
	state.continuationInFlight = false;
	state.handoffInFlight = false;
	appendState(pi, "status_changed", {
		status: "active",
		currentSession: ctx.sessionManager.getSessionFile(),
		...usageFields(usage, state),
	});
	updateTui(ctx, state);
	if (ctx.hasUI) ctx.ui.notify("Goal resumed.", "info");
	if (usage?.percent !== null && usage?.percent !== undefined && usage.percent >= state.thresholdPercent) {
		requestBudgetHandoff(pi, ctx, state, usage);
	} else {
		queueContinuation(pi, state);
	}
	return "Goal resumed.";
}

function clearGoal(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const state = runtimeState ?? reconstructState(ctx);
	if (!state) return "No goal to clear.";
	state.status = "cleared";
	state.continuationInFlight = false;
	state.handoffInFlight = false;
	appendState(pi, "cleared", { status: "cleared", currentSession: ctx.sessionManager.getSessionFile() });
	updateTui(ctx, state);
	if (ctx.hasUI) ctx.ui.notify("Goal cleared.", "info");
	return "Goal cleared.";
}

function requestManualHandoff(pi: ExtensionAPI, ctx: ExtensionCommandContext): string {
	const state = runtimeState ?? reconstructState(ctx);
	if (!state || state.status === "cleared" || state.status === "complete") return "No active goal to hand off.";
	setController(ctx);
	const usage = ctx.getContextUsage();
	updateUsage(state, usage);
	state.status = "handoff_started";
	state.handoffInFlight = true;
	state.continuationInFlight = false;
	appendState(pi, "handoff_requested", {
		status: "handoff_started",
		currentSession: ctx.sessionManager.getSessionFile(),
		...usageFields(usage, state),
	});
	updateTui(ctx, state);
	if (ctx.hasUI) ctx.ui.notify("Goal handoff requested.", "info");
	sendHidden(pi, HANDOFF_MESSAGE_TYPE, buildManualHandoffPrompt(state));
	return "Goal handoff requested.";
}

function buildKickoffPrompt(objective: string, handoffPrompt: string, parentSession: string | undefined): string {
	const parent = parentSession
		? `Parent session: ${parentSession}\nUse session_query(\"${parentSession}\", \"<your question>\") if you need more detail from the previous session.\n\n`
		: "";
	return [
		"Continue this active goal from the previous session.",
		"",
		parent.trimEnd(),
		parent ? "" : undefined,
		"Goal:",
		objective,
		"",
		"Handoff from previous session:",
		handoffPrompt,
		"",
		"Continue from the exact next action. If the goal is complete, call update_goal with status \"complete\". Otherwise keep working until completion or the next context-budget handoff.",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function appendGoalStateToSessionManager(sessionManager: any, entry: GoalStateEntry, sessionName: string): void {
	if (typeof sessionManager.appendCustomEntry === "function") {
		sessionManager.appendCustomEntry(STATE_ENTRY, entry);
	}
	if (typeof sessionManager.appendSessionInfo === "function") {
		sessionManager.appendSessionInfo(sessionName);
	}
}

function startDeferredHandoff(params: {
	controller: ExtensionCommandContext;
	objective: string;
	goalId: string;
	thresholdPercent: number;
	nextSessionIndex: number;
	currentSessionFile: string | undefined;
	handoffPrompt: string;
}): void {
	setTimeout(async () => {
		try {
			const kickoffPrompt = buildKickoffPrompt(params.objective, params.handoffPrompt, params.currentSessionFile);
			const result = await params.controller.newSession({
				parentSession: params.currentSessionFile,
				setup: async (sessionManager: any) => {
					const nextSessionFile =
						typeof sessionManager.getSessionFile === "function" ? sessionManager.getSessionFile() : undefined;
					appendGoalStateToSessionManager(
						sessionManager,
						{
							version: 1,
							event: "handoff_completed",
							goalId: params.goalId,
							objective: params.objective,
							status: "active",
							thresholdPercent: params.thresholdPercent,
							sessionIndex: params.nextSessionIndex,
							parentSession: params.currentSessionFile,
							currentSession: nextSessionFile,
							handoffPrompt: params.handoffPrompt,
							contextPercent: null,
							contextTokens: null,
							contextWindow: null,
							timestamp: Date.now(),
						},
						goalSessionName(params.objective, params.nextSessionIndex),
					);
				},
				withSession: async (nextCtx) => {
					setController(nextCtx);
					if (nextCtx.hasUI) nextCtx.ui.notify("Goal handoff session started.", "info");
					await nextCtx.sendUserMessage(kickoffPrompt);
				},
			});

			if (result.cancelled) {
				console.error("pi-goal handoff was cancelled by session switch guard.");
			}
		} catch (error) {
			console.error("pi-goal failed to start handoff session:", error);
		}
	}, 0);
}

function latestAssistantError(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch() as any[];
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		if (entry.message.stopReason !== "error") return undefined;
		return entry.message.errorMessage || "Unknown agent error.";
	}
	return undefined;
}

function pauseAfterAgentError(pi: ExtensionAPI, ctx: ExtensionContext, error: string): void {
	const state = runtimeState ?? reconstructState(ctx);
	if (!state || state.status !== "active") return;

	const usage = ctx.getContextUsage();
	updateUsage(state, usage);
	state.status = "paused";
	state.continuationInFlight = false;
	state.handoffInFlight = false;
	appendState(pi, "status_changed", {
		status: "paused",
		currentSession: ctx.sessionManager.getSessionFile(),
		...usageFields(usage, state),
	});
	updateTui(ctx, state);
	if (ctx.hasUI) ctx.ui.notify(`Goal paused after agent error: ${shortObjective(error, 120)}`, "error");
}

function maybeQueueNextStep(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const state = runtimeState ?? reconstructState(ctx);
	if (!state || state.status !== "active") return;
	if (state.continuationInFlight || state.handoffInFlight || ctx.hasPendingMessages()) return;

	const usage = ctx.getContextUsage();
	updateUsage(state, usage);
	updateTui(ctx, state);

	if (usage?.percent !== null && usage?.percent !== undefined && usage.percent >= state.thresholdPercent) {
		requestBudgetHandoff(pi, ctx, state, usage);
		return;
	}

	queueContinuation(pi, state);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		updateTui(ctx);
	});


	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		updateTui(ctx);
	});

	pi.on("session_shutdown", async () => {
		capturedCommandContext = undefined;
	});

	pi.on("agent_start", async () => {
		if (!runtimeState) return;
		runtimeState.continuationInFlight = false;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const error = latestAssistantError(ctx);
		if (error) {
			pauseAfterAgentError(pi, ctx, error);
			return;
		}
		maybeQueueNextStep(pi, ctx);
	});

	pi.registerCommand("goal", {
		description: "Run a long-running main-agent goal",
		handler: async (args, ctx) => {
			const input = args.trim();
			reconstructState(ctx);
			setController(ctx);

			if (!input) {
				const summary = buildSummary(ctx);
				sendVisibleSummary(pi, summary);
				updateTui(ctx);
				return;
			}

			const command = input.toLowerCase();
			if (command === "pause") {
				sendVisibleSummary(pi, pauseGoal(pi, ctx));
				return;
			}
			if (command === "resume") {
				sendVisibleSummary(pi, resumeGoal(pi, ctx));
				return;
			}
			if (command === "clear") {
				sendVisibleSummary(pi, clearGoal(pi, ctx));
				return;
			}
			if (command === "handoff") {
				sendVisibleSummary(pi, requestManualHandoff(pi, ctx));
				return;
			}

			if (isNonTerminal(runtimeState)) {
				if (!ctx.hasUI) {
					sendVisibleSummary(pi, "A goal is already active. Use `/goal clear` first, then start the new goal.");
					return;
				}
				const replace = await ctx.ui.confirm(
					"Replace active goal?",
					`Current goal: ${shortObjective(runtimeState!.objective, 100)}\n\nReplace it with: ${shortObjective(input, 100)}?`,
				);
				if (!replace) {
					ctx.ui.notify("Goal unchanged.", "info");
					return;
				}
				appendState(pi, "cleared", { status: "cleared", currentSession: ctx.sessionManager.getSessionFile() });
			}

			startGoal(pi, ctx, input, ctx);
		},
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Return the current active pi-goal state, context usage, and session lineage.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			reconstructState(ctx);
			const summary = buildSummary(ctx);
			return {
				content: [{ type: "text", text: summary }],
				details: { state: runtimeState, contextUsage: ctx.getContextUsage(), controllerAvailable: !!capturedCommandContext },
			};
		},
	});

	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description:
			"Create one active long-running goal only when the user explicitly asked to start goal mode. Prefer the /goal command because automatic new-session handoff needs its command context.",
		parameters: Type.Object({
			objective: Type.String({ description: "The explicit user objective for the long-running goal." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconstructState(ctx);
			if (isNonTerminal(runtimeState)) {
				return {
					content: [{ type: "text", text: "A goal is already active. Ask the user to run /goal clear or /goal <new objective> to replace it." }],
					details: { state: runtimeState },
				};
			}
			const state = startGoal(pi, ctx, params.objective);
			return {
				content: [
					{
						type: "text",
						text: "Goal created. Continuing automatically. Automatic linked-session handoff will require `/goal resume` unless the goal was started from `/goal <objective>`.",
					},
				],
				details: { state, controllerAvailable: !!capturedCommandContext },
			};
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description:
			"Mark the active goal complete. Use only when the objective is actually achieved and no required work remains.",
		parameters: Type.Object({
			status: StringEnum(["complete"] as const, {
				description: "Set to complete only when the active goal is actually achieved.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconstructState(ctx);
			if (!runtimeState || runtimeState.status === "cleared") {
				return { content: [{ type: "text", text: "No active goal to complete." }], details: {} };
			}
			if (params.status !== "complete") {
				return { content: [{ type: "text", text: "update_goal only accepts status \"complete\"." }], details: { state: runtimeState } };
			}

			const usage = ctx.getContextUsage();
			updateUsage(runtimeState, usage);
			runtimeState.status = "complete";
			runtimeState.continuationInFlight = false;
			runtimeState.handoffInFlight = false;
			appendState(pi, "completed", {
				status: "complete",
				currentSession: ctx.sessionManager.getSessionFile(),
				...usageFields(usage, runtimeState),
			});
			updateTui(ctx, runtimeState);
			if (ctx.hasUI) ctx.ui.notify("Goal completed.", "info");

			return {
				content: [{ type: "text", text: `Goal complete: ${runtimeState.objective}` }],
				details: { state: runtimeState, contextUsage: usage },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "goal_handoff",
		label: "Goal Handoff",
		description:
			"Prepare and start an automatic handoff for the active goal. Use only when pi-goal says the context budget is reached or the user explicitly requested /goal handoff. The prompt must be self-contained because the next session will not have this conversation history.",
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"Complete handoff prompt for the next session. Include objective, completed work, decisions, files, commands, blockers, and exact next action.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconstructState(ctx);
			if (!runtimeState || runtimeState.status === "cleared" || runtimeState.status === "complete") {
				return { content: [{ type: "text", text: "No active goal to hand off." }], details: {} };
			}
			if (runtimeState.status !== "budget_limited" && runtimeState.status !== "handoff_started" && !runtimeState.handoffInFlight) {
				return {
					content: [{ type: "text", text: "goal_handoff is only valid after the context budget is reached or `/goal handoff` is requested." }],
					details: { state: runtimeState },
				};
			}

			const usage = ctx.getContextUsage();
			updateUsage(runtimeState, usage);
			const controller = capturedCommandContext;
			appendState(pi, "handoff_requested", {
				status: "handoff_started",
				currentSession: ctx.sessionManager.getSessionFile(),
				handoffPrompt: params.prompt,
				...usageFields(usage, runtimeState),
			});
			runtimeState.status = "handoff_started";
			runtimeState.handoffInFlight = true;
			runtimeState.continuationInFlight = false;
			updateTui(ctx, runtimeState);

			if (!controller) {
				return {
					content: [
						{
							type: "text",
							text: "Goal handoff prompt saved, but automatic session switching requires starting or resuming the goal with `/goal <objective>` or `/goal resume`.",
						},
					],
					details: { state: runtimeState, handoffPrompt: params.prompt, controllerAvailable: false },
					terminate: true,
				};
			}

			const currentSessionFile = ctx.sessionManager.getSessionFile();
			startDeferredHandoff({
				controller,
				objective: runtimeState.objective,
				goalId: runtimeState.goalId,
				thresholdPercent: runtimeState.thresholdPercent,
				nextSessionIndex: runtimeState.sessionIndex + 1,
				currentSessionFile,
				handoffPrompt: params.prompt,
			});

			return {
				content: [{ type: "text", text: "Goal handoff captured. Starting a linked new session." }],
				details: { state: runtimeState, handoffPrompt: params.prompt, controllerAvailable: true },
				terminate: true,
			};
		},
	});
}
