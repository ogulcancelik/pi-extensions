import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type {
	AgentInfo,
	AgentStatus,
	HerdrAgents,
	HerdrLayout,
	HerdrPanes,
	PaneInfo,
	PaneSize,
	ReadSource,
	SplitDirection,
	TabInfo,
	WaitOutputSource,
	WorkspaceInfo,
} from "./herdr";

const StatusEnum = StringEnum(["idle", "working", "blocked", "done", "unknown"] as const, {
	description: "Agent lifecycle state",
});

const ReadSourceEnum = StringEnum(["visible", "recent", "recent-unwrapped", "detection"] as const, {
	description: "Terminal snapshot source",
});

const OutputFormatEnum = StringEnum(["text", "ansi"] as const, {
	description: "Output format; ansi preserves terminal styling",
});

const DirectionEnum = StringEnum(["right", "down"] as const, {
	description: "Split direction. When omitted, the tool chooses from the source pane geometry.",
});

const AgentKindEnum = StringEnum(
	[
		"pi",
		"claude",
		"codex",
		"gemini",
		"cursor",
		"devin",
		"agy",
		"cline",
		"omp",
		"mastracode",
		"opencode",
		"copilot",
		"kimi",
		"kiro",
		"droid",
		"amp",
		"grok",
		"hermes",
		"kilo",
		"qodercli",
		"maki",
	] as const,
	{ description: "Supported coding agent kind and canonical executable" },
);

function formatOutput(output: string): string {
	const truncation = truncateTail(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) return truncation.content;
	return `[Showing last ${truncation.outputLines} of ${truncation.totalLines} lines]\n${truncation.content}`;
}

/** Right for a pane wide enough to share, down for a narrow or tall one. */
function chooseSplitDirection(size: PaneSize): SplitDirection {
	return size.width >= 80 && size.width >= size.height * 2 ? "right" : "down";
}

/** A pane's working directory for new terminals: where its foreground program is. */
function paneCwd(pane: PaneInfo): string | undefined {
	return pane.foreground_cwd || pane.cwd;
}

function statusDot(theme: any, status: AgentStatus): string {
	switch (status) {
		case "blocked":
			return theme.fg("warning", "●");
		case "working":
			return theme.fg("accent", "●");
		case "done":
			return theme.fg("success", "●");
		case "idle":
			return theme.fg("muted", "○");
		default:
			return theme.fg("dim", "·");
	}
}

function agentDisplayName(agent: AgentInfo): string {
	return agent.name || agent.display_agent || agent.agent || agent.pane_id;
}

function summarizeAgent(agent: AgentInfo): string {
	const cwd = agent.cwd ? ` ${agent.cwd}` : "";
	return `${agentDisplayName(agent)}: [${agent.pane_id}] (${agent.agent_status}${agent.focused ? ", focused" : ""})${cwd}`;
}

function summarizePane(pane: PaneInfo, currentPaneId?: string): string {
	const flags = [
		pane.pane_id === currentPaneId ? "current" : pane.focused ? "focused" : null,
		pane.agent,
		pane.agent_status !== "unknown" ? pane.agent_status : null,
	]
		.filter(Boolean)
		.join(", ");
	const cwd = pane.foreground_cwd || pane.cwd;
	return `${pane.label || pane.pane_id}: [${pane.pane_id}]${flags ? ` (${flags})` : ""}${cwd ? ` ${cwd}` : ""}`;
}

function summarizeTab(tab: TabInfo): string {
	const flags = [tab.focused ? "focused" : null, tab.agent_status !== "unknown" ? tab.agent_status : null]
		.filter(Boolean)
		.join(", ");
	return `${tab.label}: [${tab.tab_id}]${flags ? ` (${flags})` : ""}`;
}

function summarizeWorkspace(workspace: WorkspaceInfo): string {
	const flags = [
		workspace.focused ? "focused" : null,
		workspace.agent_status !== "unknown" ? workspace.agent_status : null,
	]
		.filter(Boolean)
		.join(", ");
	return `${workspace.label}: [${workspace.workspace_id}]${flags ? ` (${flags})` : ""}`;
}

function renderToolCall(tool: string, args: Record<string, any>, theme: any, context: any) {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	let text = theme.fg("toolTitle", theme.bold(`${tool} `));
	text += theme.fg("accent", args.action || "?");
	const target = args.target || args.pane || args.tab || args.workspace;
	if (target) text += theme.fg("muted", ` ${target}`);
	if (args.name) text += theme.fg("muted", ` ${args.name}`);
	if (args.kind) text += theme.fg("dim", ` › ${args.kind}`);
	if (args.direction) text += theme.fg("dim", ` › ${args.direction}`);
	if (args.command) text += theme.fg("dim", ` › ${args.command}`);
	if (args.prompt) text += theme.fg("dim", ` › ${args.prompt}`);
	if (args.match) text += theme.fg("dim", ` › ${args.match}`);
	if (args.text !== undefined) text += theme.fg("dim", ` › ${JSON.stringify(args.text)}`);
	if (args.keys?.length) text += theme.fg("dim", ` › ${args.keys.join(" ")}`);
	component.setText(text);
	return component;
}

function renderToolResult(
	result: any,
	options: { expanded: boolean; isPartial: boolean },
	theme: any,
	context?: { isError?: boolean },
) {
	if (options.isPartial) return new Text(theme.fg("warning", "◌ waiting"), 0, 0);
	const details = result.details as Record<string, any> | undefined;
	const content = result.content?.[0];
	const rawText = content?.type === "text" ? content.text : "";
	if (context?.isError) return new Text(theme.fg("error", `✗ ${rawText || "failed"}`), 0, 0);
	if (!details) return new Text(rawText, 0, 0);

	if (details.agent) {
		const agent = details.agent as AgentInfo;
		return new Text(
			`${statusDot(theme, agent.agent_status)} ${theme.fg("accent", agentDisplayName(agent))} ${theme.fg("dim", agent.agent_status)}`,
			0,
			0,
		);
	}
	if (Array.isArray(details.agents)) {
		const agents = details.agents as AgentInfo[];
		return new Text(
			agents.length
				? agents
					.map(
						(agent) =>
							`${statusDot(theme, agent.agent_status)} ${theme.fg(agent.focused ? "accent" : "muted", agentDisplayName(agent))} ${theme.fg("dim", agent.agent_status)}`,
					)
					.join("\n")
				: theme.fg("dim", "no agents"),
			0,
			0,
		);
	}
	if (details.read) {
		let text = theme.fg("accent", `▤ ${details.target || details.pane}`);
		if (options.expanded && rawText) text += `\n${rawText.split("\n").slice(0, 40).map((line: string) => theme.fg("dim", line)).join("\n")}`;
		return new Text(text, 0, 0);
	}
	return new Text(theme.fg("success", `✓ ${details.action || "done"}`), 0, 0);
}

/**
 * Registers the herdr_layout, herdr_pane, and herdr_agent tools against a Herdr.
 * The tools own the Pi contract (actions, defaults, validation, rendering); the
 * Herdr owns how its CLI does each step.
 *
 * @param pi - The extension API to register with.
 * @param herdr - The Herdr the tools drive; each tool uses only its own part.
 */
export function registerHerdrTools(pi: ExtensionAPI, herdr: HerdrLayout & HerdrPanes & HerdrAgents) {
	registerLayoutTool(pi, herdr);
	registerPaneTool(pi, herdr);
	registerAgentTool(pi, herdr);
}

function registerLayoutTool(pi: ExtensionAPI, herdr: HerdrLayout) {
	pi.registerTool({
		name: "herdr_layout",
		label: "Herdr Layout",
		description:
			"Create and inspect Herdr terminal topology. Workspaces contain tabs; tabs contain panes. Creating a workspace or tab also creates a root pane, while splitting creates another pane. Layout actions never start an agent or ordinary command. Read pane IDs from results and pass them to herdr_pane or herdr_agent. Creation defaults to the caller's cwd and preserves UI focus. pane_split defaults to the caller's pane and chooses right or down from its geometry.",
		promptSnippet: "Inspect or create Herdr workspaces, tabs, and pane topology",
		promptGuidelines: [
			"Use herdr_layout, herdr_pane, and herdr_agent only when the user explicitly mentions Herdr or asks to inspect or control Herdr.",
			"Use herdr_layout to create terminal topology before starting a process or agent. Default to a sibling pane in the caller's current tab and cwd; create a tab or workspace only when requested.",
			"Read opaque workspace, tab, and pane IDs from herdr_layout results instead of constructing them, and preserve UI focus unless the user asks to switch context.",
		],
		parameters: Type.Object({
			action: StringEnum(
				[
					"current",
					"workspace_list",
					"workspace_create",
					"workspace_focus",
					"tab_list",
					"tab_create",
					"tab_focus",
					"pane_list",
					"pane_layout",
					"pane_split",
				] as const,
				{ description: "Layout action" },
			),
			workspace: Type.Optional(Type.String({ description: "Opaque workspace ID" })),
			tab: Type.Optional(Type.String({ description: "Opaque tab ID" })),
			pane: Type.Optional(
				Type.String({ description: "Opaque source pane ID. Omit for current, pane_layout, or pane_split to use the caller's pane." }),
			),
			label: Type.Optional(Type.String({ description: "Label for a new workspace or tab" })),
			direction: Type.Optional(DirectionEnum),
			cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the caller pane's foreground cwd." })),
			focus: Type.Optional(Type.Boolean({ description: "Change UI focus after creation. Defaults to false." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "current": {
					const pane = await herdr.current(signal);
					return {
						content: [{ type: "text", text: summarizePane(pane, pane.pane_id) }],
						details: { action: "current", pane },
					};
				}
				case "workspace_list": {
					const workspaces = await herdr.listWorkspaces(signal);
					return {
						content: [{ type: "text", text: workspaces.length ? workspaces.map(summarizeWorkspace).join("\n") : "No workspaces." }],
						details: { action: "workspace_list", workspaces },
					};
				}
				case "workspace_create": {
					const current = await herdr.current(signal);
					const { workspace, tab, pane: rootPane } = await herdr.createWorkspace(
						{ cwd: params.cwd || paneCwd(current) || process.cwd(), label: params.label, focus: params.focus === true },
						signal,
					);
					return {
						content: [{ type: "text", text: `Created workspace ${workspace.workspace_id}, tab ${tab.tab_id}, root pane ${rootPane.pane_id}` }],
						details: { action: "workspace_create", workspace, tab, pane: rootPane },
					};
				}
				case "workspace_focus": {
					if (!params.workspace) throw new Error("'workspace' is required for workspace_focus");
					const workspace = await herdr.focusWorkspace(params.workspace, signal);
					return {
						content: [{ type: "text", text: `Focused workspace ${workspace.workspace_id}` }],
						details: { action: "workspace_focus", workspace },
					};
				}
				case "tab_list": {
					const tabs = await herdr.listTabs(params.workspace, signal);
					return {
						content: [{ type: "text", text: tabs.length ? tabs.map(summarizeTab).join("\n") : "No tabs." }],
						details: { action: "tab_list", tabs },
					};
				}
				case "tab_create": {
					const current = await herdr.current(signal);
					const { tab, pane: rootPane } = await herdr.createTab(
						{
							workspace: params.workspace || current.workspace_id,
							cwd: params.cwd || paneCwd(current) || process.cwd(),
							label: params.label,
							focus: params.focus === true,
						},
						signal,
					);
					return {
						content: [{ type: "text", text: `Created tab ${tab.tab_id}, root pane ${rootPane.pane_id}` }],
						details: { action: "tab_create", tab, pane: rootPane },
					};
				}
				case "tab_focus": {
					if (!params.tab) throw new Error("'tab' is required for tab_focus");
					const tab = await herdr.focusTab(params.tab, signal);
					return {
						content: [{ type: "text", text: `Focused tab ${tab.tab_id}` }],
						details: { action: "tab_focus", tab },
					};
				}
				case "pane_list": {
					const current = await herdr.current(signal);
					const workspaceId = params.workspace || current.workspace_id;
					const panes = await herdr.listPanes(workspaceId, signal);
					return {
						content: [{ type: "text", text: panes.length ? panes.map((pane) => summarizePane(pane, current.pane_id)).join("\n") : "No panes." }],
						details: { action: "pane_list", panes, workspaceId },
					};
				}
				case "pane_layout": {
					const paneId = params.pane || (await herdr.current(signal)).pane_id;
					const layout = await herdr.paneLayout(paneId, signal);
					return {
						content: [{ type: "text", text: JSON.stringify(layout, null, 2) }],
						details: { action: "pane_layout", layout },
					};
				}
				case "pane_split": {
					const current = await herdr.current(signal);
					const source = params.pane ? await herdr.getPane(params.pane, signal) : current;
					const direction = params.direction || chooseSplitDirection(await herdr.paneSize(source.pane_id, signal));
					const cwd = params.cwd || paneCwd(source) || paneCwd(current) || process.cwd();
					const pane = await herdr.splitPane(
						{ pane: source.pane_id, direction, cwd, focus: params.focus === true },
						signal,
					);
					return {
						content: [{ type: "text", text: `Created pane ${pane.pane_id} by splitting ${source.pane_id} ${direction}` }],
						details: { action: "pane_split", pane, sourcePaneId: source.pane_id, direction },
					};
				}
			}
		},
		renderCall(args, theme, context) {
			return renderToolCall("herdr_layout", args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderToolResult(result, options, theme, context);
		},
	});
}

function registerPaneTool(pi: ExtensionAPI, herdr: HerdrPanes) {
	pi.registerTool({
		name: "herdr_pane",
		label: "Herdr Pane",
		description:
			"Control a raw Herdr terminal pane. Use for shells, tests, servers, builds, logs, and other ordinary processes: run a command, read output, wait for matching output, send literal text or terminal keys, inspect, or close. Pane actions target opaque pane IDs and do not validate agent identity or interpret agent lifecycle. Use herdr_agent instead when controlling a recognized coding agent. Read output is truncated to 2000 lines or 50KB.",
		promptSnippet: "Run and inspect ordinary commands in Herdr terminal panes",
		promptGuidelines: [
			"Use herdr_pane for ordinary commands and raw terminal control; use herdr_agent for coding-agent prompts, lifecycle waits, reads, and interactive keys.",
			"Use herdr_pane wait_output for tests, servers, builds, and watchers. It searches existing output immediately; use recent-unwrapped for logs and transcripts.",
			"Do not close a Herdr pane you did not create unless the user explicitly asks. herdr_pane always refuses to close the pane running the current pi process.",
		],
		parameters: Type.Object({
			action: StringEnum(["get", "run", "read", "wait_output", "send_text", "send_keys", "close"] as const, {
				description: "Raw pane action",
			}),
			pane: Type.String({ description: "Opaque pane ID returned by herdr_layout" }),
			command: Type.Optional(Type.String({ description: "Shell command to submit atomically with Enter for run" })),
			text: Type.Optional(Type.String({ description: "Literal text to send without Enter for send_text" })),
			keys: Type.Optional(
				Type.Array(Type.String(), { description: "Logical terminal keys for send_keys, such as esc, enter, up, or ctrl+c" }),
			),
			match: Type.Optional(Type.String({ description: "Literal substring or Rust regular expression for wait_output" })),
			regex: Type.Optional(Type.Boolean({ description: "Treat match as a Rust regular expression" })),
			source: Type.Optional(ReadSourceEnum),
			lines: Type.Optional(Type.Integer({ minimum: 1, description: "Rendered terminal rows to read or search" })),
			format: Type.Optional(OutputFormatEnum),
			raw: Type.Optional(Type.Boolean({ description: "Keep ANSI escapes while matching wait_output" })),
			timeout: Type.Optional(Type.Integer({ minimum: 1, description: "Wait timeout in milliseconds; omitted means indefinite" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			switch (params.action) {
				case "get": {
					const pane = await herdr.getPane(params.pane, signal);
					return {
						content: [{ type: "text", text: summarizePane(pane) }],
						details: { action: "get", pane },
					};
				}
				case "run": {
					if (!params.command) throw new Error("'command' is required for run");
					await herdr.runCommand(params.pane, params.command, signal);
					return {
						content: [{ type: "text", text: `Submitted command to pane ${params.pane}` }],
						details: { action: "run", pane: params.pane, command: params.command },
					};
				}
				case "read": {
					const output = await herdr.readPane(
						params.pane,
						{ source: params.source || "recent-unwrapped", lines: params.lines, format: params.format },
						signal,
					);
					return {
						content: [{ type: "text", text: formatOutput(output) }],
						details: { action: "read", pane: params.pane, read: true, source: params.source || "recent-unwrapped" },
					};
				}
				case "wait_output": {
					if (!params.match) throw new Error("'match' is required for wait_output");
					if (params.source === "detection") throw new Error("wait_output does not support the detection source; use read");
					const startedAt = Date.now();
					onUpdate?.({
						content: [{ type: "text", text: `Waiting for output in ${params.pane}...` }],
						details: { action: "wait_output", pane: params.pane, waiting: true },
					});
					const matched = await herdr.waitOutput(
						params.pane,
						{
							match: params.match,
							mode: params.regex ? "regex" : "literal",
							source: params.source as WaitOutputSource | undefined,
							lines: params.lines,
							timeout: params.timeout,
							raw: params.raw === true,
						},
						signal,
					);
					return {
						content: [{ type: "text", text: `Matched: ${matched.matchedLine}\n\n${formatOutput(matched.text)}` }],
						details: {
							action: "wait_output",
							pane: params.pane,
							matchedLine: matched.matchedLine,
							elapsedMs: Date.now() - startedAt,
						},
					};
				}
				case "send_text": {
					if (!params.text) throw new Error("'text' is required for send_text");
					await herdr.sendText(params.pane, params.text, signal);
					return {
						content: [{ type: "text", text: `Sent literal text to pane ${params.pane}` }],
						details: { action: "send_text", pane: params.pane },
					};
				}
				case "send_keys": {
					if (!params.keys?.length) throw new Error("'keys' is required for send_keys");
					await herdr.sendKeys(params.pane, params.keys, signal);
					return {
						content: [{ type: "text", text: `Sent ${params.keys.join(" ")} to pane ${params.pane}` }],
						details: { action: "send_keys", pane: params.pane, keys: params.keys },
					};
				}
				case "close": {
					const current = await herdr.current(signal);
					if (params.pane === current.pane_id) throw new Error("Refusing to close the pane pi is running in.");
					await herdr.closePane(params.pane, signal);
					return {
						content: [{ type: "text", text: `Closed pane ${params.pane}` }],
						details: { action: "close", pane: params.pane },
					};
				}
			}
		},
		renderCall(args, theme, context) {
			return renderToolCall("herdr_pane", args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderToolResult(result, options, theme, context);
		},
	});
}

function registerAgentTool(pi: ExtensionAPI, herdr: HerdrAgents) {
	pi.registerTool({
		name: "herdr_agent",
		label: "Herdr Agent",
		description:
			"Control a recognized coding agent occupying an existing Herdr pane. Starting requires an available interactive shell pane created through herdr_layout and never creates or changes layout. Agent targets are unique live names or the pane ID currently hosting the agent, never terminal IDs or bare kind labels. Use prompt, wait, read, and send_keys instead of raw pane input. Lifecycle states are working, blocked, done, idle, and unknown; prompt and wait default to the first settled idle, done, or blocked state. Read output is truncated to 2000 lines or 50KB.",
		promptSnippet: "Start, prompt, wait for, read, and interact with coding agents in Herdr",
		promptGuidelines: [
			"Use herdr_agent for recognized coding agents. Use herdr_layout to create an available shell pane first; herdr_agent start never creates or moves terminal layout.",
			"For normal helper work, use herdr_layout pane_split, then herdr_agent start, herdr_agent prompt with wait enabled, and herdr_agent read. Use herdr_pane only for ordinary processes or intentional raw terminal control.",
			"Treat herdr_agent idle and done as ready states, blocked as requiring inspection or input, and unknown as uncertain rather than completed. CLI reads do not mark done work as seen.",
			"If herdr_agent read cannot recover a full alternate-screen response after increasing lines, ask the agent to write its complete response to a temporary Markdown file and return the path, then read that file directly.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "get", "start", "prompt", "wait", "read", "send_keys", "focus", "rename"] as const, {
				description: "Agent lifecycle action",
			}),
			target: Type.Optional(Type.String({ description: "Unique live agent name or pane ID currently hosting the agent" })),
			pane: Type.Optional(Type.String({ description: "Existing available shell pane ID for start" })),
			name: Type.Optional(
				Type.String({
					pattern: "^[a-z][a-z0-9_-]{0,31}$",
					description: "Unique agent name for start or replacement name for rename",
				}),
			),
			kind: Type.Optional(AgentKindEnum),
			agentArgs: Type.Optional(Type.Array(Type.String(), { description: "Native agent arguments passed unchanged after -- for start" })),
			prompt: Type.Optional(Type.String({ description: "Prompt text submitted atomically with Enter" })),
			wait: Type.Optional(Type.Boolean({ description: "Wait for lifecycle settlement after prompt. Defaults to true." })),
			until: Type.Optional(Type.Array(StatusEnum, { description: "Accepted lifecycle states for prompt with wait or wait; defaults to idle, done, or blocked" })),
			timeout: Type.Optional(Type.Integer({ minimum: 1, description: "Timeout in milliseconds; omitted means indefinite" })),
			source: Type.Optional(ReadSourceEnum),
			lines: Type.Optional(Type.Integer({ minimum: 1, description: "Rendered terminal rows to read" })),
			format: Type.Optional(OutputFormatEnum),
			keys: Type.Optional(Type.Array(Type.String(), { description: "Logical UI keys such as esc, enter, up, or ctrl+c" })),
			clearName: Type.Optional(Type.Boolean({ description: "Clear the current agent name for rename" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			switch (params.action) {
				case "list": {
					const agents = await herdr.listAgents(signal);
					return {
						content: [{ type: "text", text: agents.length ? agents.map(summarizeAgent).join("\n") : "No agents." }],
						details: { action: "list", agents },
					};
				}
				case "get": {
					if (!params.target) throw new Error("'target' is required for get");
					const agent = await herdr.getAgent(params.target, signal);
					return {
						content: [{ type: "text", text: summarizeAgent(agent) }],
						details: { action: "get", agent },
					};
				}
				case "start": {
					if (!params.name) throw new Error("'name' is required for start");
					if (!params.kind) throw new Error("'kind' is required for start");
					if (!params.pane) throw new Error("'pane' is required for start");
					if (params.timeout != null && (params.timeout <= 3000 || params.timeout > 300000)) {
						throw new Error("start timeout must be greater than 3000ms and at most 300000ms");
					}
					onUpdate?.({
						content: [{ type: "text", text: `Starting ${params.kind} as ${params.name} in ${params.pane}...` }],
						details: { action: "start", waiting: true },
					});
					const agent = await herdr.startAgent(
						{ name: params.name, kind: params.kind, pane: params.pane, agentArgs: params.agentArgs || [], timeout: params.timeout },
						signal,
					);
					return {
						content: [{ type: "text", text: `Started ${summarizeAgent(agent)}` }],
						details: { action: "start", agent },
					};
				}
				case "prompt": {
					if (!params.target) throw new Error("'target' is required for prompt");
					if (!params.prompt) throw new Error("'prompt' is required for prompt");
					const shouldWait = params.wait !== false;
					if (!shouldWait && params.until?.length) throw new Error("'until' requires wait for prompt");
					if (!shouldWait && params.timeout != null) throw new Error("'timeout' requires wait for prompt");
					if (shouldWait) {
						onUpdate?.({
							content: [{ type: "text", text: `Prompted ${params.target}; waiting for lifecycle settlement...` }],
							details: { action: "prompt", target: params.target, waiting: true },
						});
					}
					const agent = await herdr.promptAgent(
						params.target,
						params.prompt,
						shouldWait ? { until: params.until || [], timeout: params.timeout } : null,
						signal,
					);
					return {
						content: [{ type: "text", text: `${shouldWait ? "Prompt settled" : "Prompt submitted"}: ${summarizeAgent(agent)}` }],
						details: { action: "prompt", agent },
					};
				}
				case "wait": {
					if (!params.target) throw new Error("'target' is required for wait");
					onUpdate?.({
						content: [{ type: "text", text: `Waiting for agent ${params.target}...` }],
						details: { action: "wait", target: params.target, waiting: true },
					});
					const agent = await herdr.waitAgent(params.target, { until: params.until || [], timeout: params.timeout }, signal);
					return {
						content: [{ type: "text", text: `Agent settled: ${summarizeAgent(agent)}` }],
						details: { action: "wait", agent },
					};
				}
				case "read": {
					if (!params.target) throw new Error("'target' is required for read");
					const output = await herdr.readAgent(
						params.target,
						{ source: params.source || "recent-unwrapped", lines: params.lines, format: params.format },
						signal,
					);
					return {
						content: [{ type: "text", text: formatOutput(output) }],
						details: { action: "read", target: params.target, read: true, source: params.source || "recent-unwrapped" },
					};
				}
				case "send_keys": {
					if (!params.target) throw new Error("'target' is required for send_keys");
					if (!params.keys?.length) throw new Error("'keys' is required for send_keys");
					await herdr.sendAgentKeys(params.target, params.keys, signal);
					return {
						content: [{ type: "text", text: `Sent ${params.keys.join(" ")} to ${params.target}` }],
						details: { action: "send_keys", target: params.target, keys: params.keys },
					};
				}
				case "focus": {
					if (!params.target) throw new Error("'target' is required for focus");
					const agent = await herdr.focusAgent(params.target, signal);
					return {
						content: [{ type: "text", text: `Focused ${agentDisplayName(agent)}` }],
						details: { action: "focus", agent },
					};
				}
				case "rename": {
					if (!params.target) throw new Error("'target' is required for rename");
					if (!params.clearName && !params.name) throw new Error("'name' or 'clearName' is required for rename");
					const agent = await herdr.renameAgent(params.target, params.clearName ? null : params.name || null, signal);
					return {
						content: [{ type: "text", text: params.clearName ? `Cleared agent name for ${params.target}` : `Renamed agent to ${params.name}` }],
						details: { action: "rename", agent },
					};
				}
			}
		},
		renderCall(args, theme, context) {
			return renderToolCall("herdr_agent", args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderToolResult(result, options, theme, context);
		},
	});
}
