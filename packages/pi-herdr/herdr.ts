/**
 * The Herdr the tools drive, in terms of the tools' three primitives: layout,
 * raw panes, and coding agents. Each backend (the herdr TUI, the Herdr app)
 * implements it against its own CLI; the tools never see which one runs.
 *
 * IDs are opaque strings a backend hands out and takes back unchanged.
 * Expected failures reject with an `Error` whose message is shown to the
 * model, as Pi tools report them. A capability a backend cannot provide
 * rejects with `HerdrUnsupported`.
 */

/** An agent's lifecycle state, as Herdr classifies it. */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** Which part of a terminal to read. */
export type ReadSource = "visible" | "recent" | "recent-unwrapped" | "detection";

/** A read source that can be searched while waiting. */
export type WaitOutputSource = Exclude<ReadSource, "detection">;

/** Where a split puts the new pane. */
export type SplitDirection = "right" | "down";

/** Whether output keeps terminal styling. */
export type OutputFormat = "text" | "ansi";

/** A workspace: a place to work, holding tabs. */
export interface WorkspaceInfo {
	workspace_id: string;
	label: string;
	focused: boolean;
	agent_status: AgentStatus;
}

/** A tab: one arrangement of panes in a workspace. */
export interface TabInfo {
	tab_id: string;
	workspace_id: string;
	label: string;
	focused: boolean;
	agent_status: AgentStatus;
}

/** A pane: one terminal in a tab. */
export interface PaneInfo {
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

/** A recognized coding agent and the pane it occupies. */
export interface AgentInfo {
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

/** A rectangle in terminal cells. */
export interface PaneLayoutRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A tab's pane geometry. */
export interface PaneLayoutSnapshot {
	workspace_id: string;
	tab_id: string;
	zoomed: boolean;
	focused_pane_id: string;
	area: PaneLayoutRect;
	panes: Array<{ pane_id: string; focused: boolean; rect: PaneLayoutRect }>;
	splits: Array<{ id: string; direction: SplitDirection; ratio: number; rect: PaneLayoutRect }>;
}

/** A pane's size in terminal cells. */
export interface PaneSize {
	width: number;
	height: number;
}

/** How to read a terminal. */
export interface ReadOptions {
	source: ReadSource;
	/** Rendered rows; the backend's default when absent. */
	lines?: number;
	format?: OutputFormat;
}

/** What to wait for in a pane's output. */
export interface WaitOutputOptions {
	match: string;
	/** "regex": `match` is a regular expression; "literal": a substring. */
	mode: "literal" | "regex";
	source?: WaitOutputSource;
	lines?: number;
	/** Milliseconds; absent waits until aborted. */
	timeout?: number;
	/** Keep ANSI escapes while matching. */
	raw: boolean;
}

/** The line that matched, and the output around it. */
export interface OutputMatch {
	matchedLine: string;
	text: string;
}

/** Which lifecycle states end a wait, and for how long to wait. */
export interface Settlement {
	/** Empty: the first idle, done, or blocked state. */
	until: readonly AgentStatus[];
	/** Milliseconds; absent waits until aborted. */
	timeout?: number;
}

/** A coding agent to start in an existing shell pane. */
export interface AgentStart {
	name: string;
	kind: string;
	pane: string;
	agentArgs: readonly string[];
	/** Milliseconds to wait for the agent to be recognized. */
	timeout?: number;
}

/** A capability this Herdr does not have. */
export class HerdrUnsupported extends Error {
	readonly _tag = "HerdrUnsupported";

	constructor(
		readonly capability: string,
		readonly backend: string,
		readonly hint: string,
	) {
		super(`${capability} is not available in ${backend}. ${hint}`);
	}
}

/** Workspaces, tabs, and pane topology. */
export interface HerdrLayout {
	/** The pane running this Pi process. */
	current(signal?: AbortSignal): Promise<PaneInfo>;
	/** A split's source pane. */
	getPane(pane: string, signal?: AbortSignal): Promise<PaneInfo>;
	listWorkspaces(signal?: AbortSignal): Promise<WorkspaceInfo[]>;
	createWorkspace(
		input: { cwd: string; label?: string; focus: boolean },
		signal?: AbortSignal,
	): Promise<{ workspace: WorkspaceInfo; tab: TabInfo; pane: PaneInfo }>;
	focusWorkspace(workspace: string, signal?: AbortSignal): Promise<WorkspaceInfo>;
	/** Every tab, or those of one workspace. */
	listTabs(workspace: string | undefined, signal?: AbortSignal): Promise<TabInfo[]>;
	createTab(
		input: { workspace: string; cwd: string; label?: string; focus: boolean },
		signal?: AbortSignal,
	): Promise<{ tab: TabInfo; pane: PaneInfo }>;
	focusTab(tab: string, signal?: AbortSignal): Promise<TabInfo>;
	listPanes(workspace: string, signal?: AbortSignal): Promise<PaneInfo[]>;
	paneLayout(pane: string, signal?: AbortSignal): Promise<PaneLayoutSnapshot>;
	/** What the split direction is chosen from. */
	paneSize(pane: string, signal?: AbortSignal): Promise<PaneSize>;
	splitPane(
		input: { pane: string; direction: SplitDirection; cwd: string; focus: boolean },
		signal?: AbortSignal,
	): Promise<PaneInfo>;
}

/** Raw terminal control of a pane. */
export interface HerdrPanes {
	current(signal?: AbortSignal): Promise<PaneInfo>;
	getPane(pane: string, signal?: AbortSignal): Promise<PaneInfo>;
	/** Submits a shell command with Enter. */
	runCommand(pane: string, command: string, signal?: AbortSignal): Promise<void>;
	readPane(pane: string, options: ReadOptions, signal?: AbortSignal): Promise<string>;
	/** Searches existing output first, then waits for new output. */
	waitOutput(pane: string, options: WaitOutputOptions, signal?: AbortSignal): Promise<OutputMatch>;
	sendText(pane: string, text: string, signal?: AbortSignal): Promise<void>;
	sendKeys(pane: string, keys: readonly string[], signal?: AbortSignal): Promise<void>;
	closePane(pane: string, signal?: AbortSignal): Promise<void>;
}

/** Coding agents, addressed by unique live name or hosting pane ID. */
export interface HerdrAgents {
	listAgents(signal?: AbortSignal): Promise<AgentInfo[]>;
	getAgent(target: string, signal?: AbortSignal): Promise<AgentInfo>;
	startAgent(input: AgentStart, signal?: AbortSignal): Promise<AgentInfo>;
	/** Submits a prompt; with `settle`, resolves once the agent settles. */
	promptAgent(target: string, prompt: string, settle: Settlement | null, signal?: AbortSignal): Promise<AgentInfo>;
	waitAgent(target: string, settle: Settlement, signal?: AbortSignal): Promise<AgentInfo>;
	readAgent(target: string, options: ReadOptions, signal?: AbortSignal): Promise<string>;
	sendAgentKeys(target: string, keys: readonly string[], signal?: AbortSignal): Promise<void>;
	focusAgent(target: string, signal?: AbortSignal): Promise<AgentInfo>;
	/** A null name clears it. */
	renameAgent(target: string, name: string | null, signal?: AbortSignal): Promise<AgentInfo>;
}

/** Everything the tools drive. */
export type Herdr = HerdrLayout & HerdrPanes & HerdrAgents;

/** A Pi-provided way to run a program, as `pi.exec`. */
export type Exec = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>;

/** The most urgent of several states: blocked, done, working, idle, then unknown. */
export function mostUrgent(statuses: readonly AgentStatus[]): AgentStatus {
	for (const status of ["blocked", "done", "working", "idle"] as const) {
		if (statuses.includes(status)) return status;
	}
	return "unknown";
}
