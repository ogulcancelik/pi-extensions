import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
type ReadSource = "visible" | "recent" | "recent-unwrapped" | "detection";
type WaitOutputSource = Exclude<ReadSource, "detection">;
type SplitDirection = "right" | "down";
type OutputFormat = "text" | "ansi";

interface WorkspaceInfo {
	workspace_id: string;
	label: string;
	focused: boolean;
	agent_status: AgentStatus;
}

interface TabInfo {
	tab_id: string;
	workspace_id: string;
	label: string;
	focused: boolean;
	agent_status: AgentStatus;
}

interface PaneInfo {
	pane_id: string;
	workspace_id: string;
	tab_id: string;
	focused: boolean;
	cwd?: string;
	foreground_cwd?: string;
	label?: string;
	agent?: string;
	agent_status: AgentStatus;
}

interface AgentInfo {
	name?: string;
	agent?: string;
	display_agent?: string;
	agent_status: AgentStatus;
	workspace_id: string;
	tab_id: string;
	pane_id: string;
	focused: boolean;
	cwd?: string;
}

interface PaneLayoutRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface PaneLayoutSnapshot {
	workspace_id: string;
	tab_id: string;
	zoomed: boolean;
	focused_pane_id: string;
	area: PaneLayoutRect;
	panes: Array<{ pane_id: string; focused: boolean; rect: PaneLayoutRect }>;
	splits: Array<{ id: string; direction: SplitDirection; ratio: number; rect: PaneLayoutRect }>;
}

interface HerdrJsonEnvelope {
	result?: unknown;
	error?: {
		code?: string;
		message?: string;
	};
}

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

function parseHerdrError(output: string): string | null {
	const trimmed = output.trim();
	if (!trimmed) return null;
	try {
		const value = JSON.parse(trimmed) as HerdrJsonEnvelope;
		return value.error?.message || value.error?.code || trimmed;
	} catch {
		return trimmed;
	}
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted === true || (error instanceof Error && error.message === "Aborted");
}

function formatOutput(output: string): string {
	const truncation = truncateTail(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) return truncation.content;
	return `[Showing last ${truncation.outputLines} of ${truncation.totalLines} lines]\n${truncation.content}`;
}

function chooseSplitDirection(layout: PaneLayoutSnapshot, paneId: string): SplitDirection {
	const pane = layout.panes.find((candidate) => candidate.pane_id === paneId);
	if (!pane) return "right";
	return pane.rect.width >= 80 && pane.rect.width >= pane.rect.height * 2 ? "right" : "down";
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
	component.setText(text);
	return component;
}

function renderToolResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any) {
	if (options.isPartial) return new Text(theme.fg("warning", "◌ waiting"), 0, 0);
	const details = result.details as Record<string, any> | undefined;
	const content = result.content?.[0];
	const rawText = content?.type === "text" ? content.text : "";
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

export default function (pi: ExtensionAPI) {
	if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return;

	async function execHerdr(args: string[], signal?: AbortSignal) {
		const result = await pi.exec("herdr", args, { signal });
		if (signal?.aborted || result.killed) throw new Error("Aborted");
		if (result.code !== 0) {
			const message =
				parseHerdrError(result.stderr) ||
				parseHerdrError(result.stdout) ||
				`herdr ${args.join(" ")} failed with exit code ${result.code}`;
			throw new Error(message);
		}
		return result;
	}

	async function execHerdrJson<T>(args: string[], signal?: AbortSignal): Promise<T> {
		const result = await execHerdr(args, signal);
		const stdout = result.stdout.trim();
		if (!stdout) throw new Error(`Expected JSON output from herdr ${args.join(" ")}`);
		let value: HerdrJsonEnvelope;
		try {
			value = JSON.parse(stdout) as HerdrJsonEnvelope;
		} catch {
			throw new Error(`Failed to parse JSON from herdr ${args.join(" ")}`);
		}
		if (value.error) throw new Error(value.error.message || value.error.code || `herdr ${args.join(" ")} failed`);
		return value as T;
	}

	async function execHerdrText(args: string[], signal?: AbortSignal): Promise<string> {
		return (await execHerdr(args, signal)).stdout;
	}

	async function getCurrentPane(signal?: AbortSignal): Promise<PaneInfo> {
		const response = await execHerdrJson<{ result: { pane: PaneInfo } }>(["pane", "current", "--current"], signal);
		return response.result.pane;
	}

	async function getPane(paneId: string, signal?: AbortSignal): Promise<PaneInfo> {
		const response = await execHerdrJson<{ result: { pane: PaneInfo } }>(["pane", "get", paneId], signal);
		return response.result.pane;
	}

	async function getPaneLayout(paneId: string, signal?: AbortSignal): Promise<PaneLayoutSnapshot> {
		const response = await execHerdrJson<{ result: { layout: PaneLayoutSnapshot } }>(
			["pane", "layout", "--pane", paneId],
			signal,
		);
		return response.result.layout;
	}

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
					const pane = await getCurrentPane(signal);
					return {
						content: [{ type: "text", text: summarizePane(pane, pane.pane_id) }],
						details: { action: "current", pane },
					};
				}
				case "workspace_list": {
					const response = await execHerdrJson<{ result: { workspaces: WorkspaceInfo[] } }>(
						["workspace", "list"],
						signal,
					);
					const workspaces = response.result.workspaces || [];
					return {
						content: [{ type: "text", text: workspaces.length ? workspaces.map(summarizeWorkspace).join("\n") : "No workspaces." }],
						details: { action: "workspace_list", workspaces },
					};
				}
				case "workspace_create": {
					const current = await getCurrentPane(signal);
					const args = ["workspace", "create", "--cwd", params.cwd || current.foreground_cwd || current.cwd || process.cwd()];
					if (params.label) args.push("--label", params.label);
					args.push(params.focus === true ? "--focus" : "--no-focus");
					const response = await execHerdrJson<{
						result: { workspace: WorkspaceInfo; tab: TabInfo; root_pane: PaneInfo };
					}>(args, signal);
					const { workspace, tab, root_pane: rootPane } = response.result;
					return {
						content: [{ type: "text", text: `Created workspace ${workspace.workspace_id}, tab ${tab.tab_id}, root pane ${rootPane.pane_id}` }],
						details: { action: "workspace_create", workspace, tab, pane: rootPane },
					};
				}
				case "workspace_focus": {
					if (!params.workspace) throw new Error("'workspace' is required for workspace_focus");
					const response = await execHerdrJson<{ result: { workspace: WorkspaceInfo } }>(
						["workspace", "focus", params.workspace],
						signal,
					);
					return {
						content: [{ type: "text", text: `Focused workspace ${response.result.workspace.workspace_id}` }],
						details: { action: "workspace_focus", workspace: response.result.workspace },
					};
				}
				case "tab_list": {
					const args = ["tab", "list"];
					if (params.workspace) args.push("--workspace", params.workspace);
					const response = await execHerdrJson<{ result: { tabs: TabInfo[] } }>(args, signal);
					const tabs = response.result.tabs || [];
					return {
						content: [{ type: "text", text: tabs.length ? tabs.map(summarizeTab).join("\n") : "No tabs." }],
						details: { action: "tab_list", tabs },
					};
				}
				case "tab_create": {
					const current = await getCurrentPane(signal);
					const args = ["tab", "create", "--workspace", params.workspace || current.workspace_id];
					args.push("--cwd", params.cwd || current.foreground_cwd || current.cwd || process.cwd());
					if (params.label) args.push("--label", params.label);
					args.push(params.focus === true ? "--focus" : "--no-focus");
					const response = await execHerdrJson<{ result: { tab: TabInfo; root_pane: PaneInfo } }>(args, signal);
					const { tab, root_pane: rootPane } = response.result;
					return {
						content: [{ type: "text", text: `Created tab ${tab.tab_id}, root pane ${rootPane.pane_id}` }],
						details: { action: "tab_create", tab, pane: rootPane },
					};
				}
				case "tab_focus": {
					if (!params.tab) throw new Error("'tab' is required for tab_focus");
					const response = await execHerdrJson<{ result: { tab: TabInfo } }>(["tab", "focus", params.tab], signal);
					return {
						content: [{ type: "text", text: `Focused tab ${response.result.tab.tab_id}` }],
						details: { action: "tab_focus", tab: response.result.tab },
					};
				}
				case "pane_list": {
					const current = await getCurrentPane(signal);
					const workspaceId = params.workspace || current.workspace_id;
					const response = await execHerdrJson<{ result: { panes: PaneInfo[] } }>(
						["pane", "list", "--workspace", workspaceId],
						signal,
					);
					const panes = response.result.panes || [];
					return {
						content: [{ type: "text", text: panes.length ? panes.map((pane) => summarizePane(pane, current.pane_id)).join("\n") : "No panes." }],
						details: { action: "pane_list", panes, workspaceId },
					};
				}
				case "pane_layout": {
					const paneId = params.pane || (await getCurrentPane(signal)).pane_id;
					const layout = await getPaneLayout(paneId, signal);
					return {
						content: [{ type: "text", text: JSON.stringify(layout, null, 2) }],
						details: { action: "pane_layout", layout },
					};
				}
				case "pane_split": {
					const current = await getCurrentPane(signal);
					const source = params.pane ? await getPane(params.pane, signal) : current;
					const direction = params.direction || chooseSplitDirection(await getPaneLayout(source.pane_id, signal), source.pane_id);
					const cwd = params.cwd || source.foreground_cwd || source.cwd || current.foreground_cwd || current.cwd || process.cwd();
					const args = ["pane", "split", source.pane_id, "--direction", direction, "--cwd", cwd];
					args.push(params.focus === true ? "--focus" : "--no-focus");
					const response = await execHerdrJson<{ result: { pane: PaneInfo } }>(args, signal);
					const pane = response.result.pane;
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
		renderResult(result, options, theme) {
			return renderToolResult(result, options, theme);
		},
	});

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
					const pane = await getPane(params.pane, signal);
					return {
						content: [{ type: "text", text: summarizePane(pane) }],
						details: { action: "get", pane },
					};
				}
				case "run": {
					if (!params.command) throw new Error("'command' is required for run");
					await execHerdrJson(["pane", "run", params.pane, params.command], signal);
					return {
						content: [{ type: "text", text: `Submitted command to pane ${params.pane}` }],
						details: { action: "run", pane: params.pane, command: params.command },
					};
				}
				case "read": {
					const args = ["pane", "read", params.pane, "--source", params.source || "recent-unwrapped"];
					if (params.lines != null) args.push("--lines", String(params.lines));
					if (params.format) args.push("--format", params.format);
					const output = await execHerdrText(args, signal);
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
					const args = ["pane", "wait-output", params.pane, params.regex ? "--regex" : "--match", params.match];
					if (params.source) args.push("--source", params.source as WaitOutputSource);
					if (params.lines != null) args.push("--lines", String(params.lines));
					if (params.timeout != null) args.push("--timeout", String(params.timeout));
					if (params.raw) args.push("--raw");
					const response = await execHerdrJson<{
						result: { pane_id: string; matched_line: string; read?: { text?: string } };
					}>(args, signal);
					const matched = response.result;
					const output = matched.read?.text || matched.matched_line;
					return {
						content: [{ type: "text", text: `Matched: ${matched.matched_line}\n\n${formatOutput(output)}` }],
						details: {
							action: "wait_output",
							pane: params.pane,
							matchedLine: matched.matched_line,
							elapsedMs: Date.now() - startedAt,
						},
					};
				}
				case "send_text": {
					if (!params.text) throw new Error("'text' is required for send_text");
					await execHerdrJson(["pane", "send-text", params.pane, params.text], signal);
					return {
						content: [{ type: "text", text: `Sent literal text to pane ${params.pane}` }],
						details: { action: "send_text", pane: params.pane },
					};
				}
				case "send_keys": {
					if (!params.keys?.length) throw new Error("'keys' is required for send_keys");
					await execHerdrJson(["pane", "send-keys", params.pane, ...params.keys], signal);
					return {
						content: [{ type: "text", text: `Sent ${params.keys.join(" ")} to pane ${params.pane}` }],
						details: { action: "send_keys", pane: params.pane, keys: params.keys },
					};
				}
				case "close": {
					const current = await getCurrentPane(signal);
					if (params.pane === current.pane_id) throw new Error("Refusing to close the pane pi is running in.");
					await execHerdrJson(["pane", "close", params.pane], signal);
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
		renderResult(result, options, theme) {
			return renderToolResult(result, options, theme);
		},
	});

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
					const response = await execHerdrJson<{ result: { agents: AgentInfo[] } }>(["agent", "list"], signal);
					const agents = response.result.agents || [];
					return {
						content: [{ type: "text", text: agents.length ? agents.map(summarizeAgent).join("\n") : "No agents." }],
						details: { action: "list", agents },
					};
				}
				case "get": {
					if (!params.target) throw new Error("'target' is required for get");
					const response = await execHerdrJson<{ result: { agent: AgentInfo } }>(["agent", "get", params.target], signal);
					return {
						content: [{ type: "text", text: summarizeAgent(response.result.agent) }],
						details: { action: "get", agent: response.result.agent },
					};
				}
				case "start": {
					if (!params.name) throw new Error("'name' is required for start");
					if (!params.kind) throw new Error("'kind' is required for start");
					if (!params.pane) throw new Error("'pane' is required for start");
					if (params.timeout != null && (params.timeout <= 3000 || params.timeout > 300000)) {
						throw new Error("start timeout must be greater than 3000ms and at most 300000ms");
					}
					const args = ["agent", "start", params.name, "--kind", params.kind, "--pane", params.pane];
					if (params.timeout != null) args.push("--timeout", String(params.timeout));
					if (params.agentArgs?.length) args.push("--", ...params.agentArgs);
					onUpdate?.({
						content: [{ type: "text", text: `Starting ${params.kind} as ${params.name} in ${params.pane}...` }],
						details: { action: "start", waiting: true },
					});
					const response = await execHerdrJson<{ result: { agent: AgentInfo } }>(args, signal);
					return {
						content: [{ type: "text", text: `Started ${summarizeAgent(response.result.agent)}` }],
						details: { action: "start", agent: response.result.agent },
					};
				}
				case "prompt": {
					if (!params.target) throw new Error("'target' is required for prompt");
					if (!params.prompt) throw new Error("'prompt' is required for prompt");
					const shouldWait = params.wait !== false;
					if (!shouldWait && params.until?.length) throw new Error("'until' requires wait for prompt");
					if (!shouldWait && params.timeout != null) throw new Error("'timeout' requires wait for prompt");
					const args = ["agent", "prompt", params.target, params.prompt];
					if (shouldWait) args.push("--wait");
					for (const status of params.until || []) args.push("--until", status);
					if (params.timeout != null) args.push("--timeout", String(params.timeout));
					if (shouldWait) {
						onUpdate?.({
							content: [{ type: "text", text: `Prompted ${params.target}; waiting for lifecycle settlement...` }],
							details: { action: "prompt", target: params.target, waiting: true },
						});
					}
					const response = await execHerdrJson<{ result: { agent: AgentInfo } }>(args, signal);
					return {
						content: [{ type: "text", text: `${shouldWait ? "Prompt settled" : "Prompt submitted"}: ${summarizeAgent(response.result.agent)}` }],
						details: { action: "prompt", agent: response.result.agent },
					};
				}
				case "wait": {
					if (!params.target) throw new Error("'target' is required for wait");
					const args = ["agent", "wait", params.target];
					for (const status of params.until || []) args.push("--until", status);
					if (params.timeout != null) args.push("--timeout", String(params.timeout));
					onUpdate?.({
						content: [{ type: "text", text: `Waiting for agent ${params.target}...` }],
						details: { action: "wait", target: params.target, waiting: true },
					});
					const response = await execHerdrJson<{ result: { agent: AgentInfo } }>(args, signal);
					return {
						content: [{ type: "text", text: `Agent settled: ${summarizeAgent(response.result.agent)}` }],
						details: { action: "wait", agent: response.result.agent },
					};
				}
				case "read": {
					if (!params.target) throw new Error("'target' is required for read");
					const args = ["agent", "read", params.target, "--source", params.source || "recent-unwrapped"];
					if (params.lines != null) args.push("--lines", String(params.lines));
					if (params.format) args.push("--format", params.format as OutputFormat);
					const output = await execHerdrText(args, signal);
					return {
						content: [{ type: "text", text: formatOutput(output) }],
						details: { action: "read", target: params.target, read: true, source: params.source || "recent-unwrapped" },
					};
				}
				case "send_keys": {
					if (!params.target) throw new Error("'target' is required for send_keys");
					if (!params.keys?.length) throw new Error("'keys' is required for send_keys");
					await execHerdrJson(["agent", "send-keys", params.target, ...params.keys], signal);
					return {
						content: [{ type: "text", text: `Sent ${params.keys.join(" ")} to ${params.target}` }],
						details: { action: "send_keys", target: params.target, keys: params.keys },
					};
				}
				case "focus": {
					if (!params.target) throw new Error("'target' is required for focus");
					const response = await execHerdrJson<{ result: { agent: AgentInfo } }>(["agent", "focus", params.target], signal);
					return {
						content: [{ type: "text", text: `Focused ${agentDisplayName(response.result.agent)}` }],
						details: { action: "focus", agent: response.result.agent },
					};
				}
				case "rename": {
					if (!params.target) throw new Error("'target' is required for rename");
					if (!params.clearName && !params.name) throw new Error("'name' or 'clearName' is required for rename");
					const args = ["agent", "rename", params.target];
					args.push(params.clearName ? "--clear" : params.name!);
					const response = await execHerdrJson<{ result: { agent: AgentInfo } }>(args, signal);
					return {
						content: [{ type: "text", text: params.clearName ? `Cleared agent name for ${params.target}` : `Renamed agent to ${params.name}` }],
						details: { action: "rename", agent: response.result.agent },
					};
				}
			}
		},
		renderCall(args, theme, context) {
			return renderToolCall("herdr_agent", args, theme, context);
		},
		renderResult(result, options, theme) {
			return renderToolResult(result, options, theme);
		},
	});
}
