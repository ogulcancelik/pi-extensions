import type {
	AgentInfo,
	AgentStart,
	Exec,
	Herdr,
	OutputMatch,
	PaneInfo,
	PaneLayoutSnapshot,
	PaneSize,
	ReadOptions,
	Settlement,
	SplitDirection,
	TabInfo,
	WaitOutputOptions,
	WorkspaceInfo,
} from "./herdr";

interface HerdrJsonEnvelope {
	result?: unknown;
	error?: {
		code?: string;
		message?: string;
	};
}

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

/**
 * The herdr TUI, through its `herdr` CLI. Pi runs inside one of its panes
 * (`HERDR_PANE_ID`), and the CLI answers in `{ result }` / `{ error }` envelopes.
 */
export class TuiHerdr implements Herdr {
	constructor(private readonly exec: Exec) {}

	private async run(args: string[], signal?: AbortSignal) {
		const result = await this.exec("herdr", args, { signal });
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

	private async json<T>(args: string[], signal?: AbortSignal): Promise<T> {
		const result = await this.run(args, signal);
		const stdout = result.stdout.trim();
		if (!stdout) throw new Error(`Expected JSON output from herdr ${args.join(" ")}`);
		let value: HerdrJsonEnvelope;
		try {
			value = JSON.parse(stdout) as HerdrJsonEnvelope;
		} catch {
			throw new Error(`Failed to parse JSON from herdr ${args.join(" ")}`);
		}
		if (value.error) throw new Error(value.error.message || value.error.code || `herdr ${args.join(" ")} failed`);
		// SAFETY: the herdr CLI's documented result shape for this command; the tools only read the fields it names.
		return value.result as T;
	}

	private async text(args: string[], signal?: AbortSignal): Promise<string> {
		return (await this.run(args, signal)).stdout;
	}

	private focusFlag(focus: boolean): string {
		return focus ? "--focus" : "--no-focus";
	}

	private readArgs(options: ReadOptions): string[] {
		const args = ["--source", options.source];
		if (options.lines != null) args.push("--lines", String(options.lines));
		if (options.format) args.push("--format", options.format);
		return args;
	}

	private settleArgs(settle: Settlement): string[] {
		const args: string[] = [];
		for (const status of settle.until) args.push("--until", status);
		if (settle.timeout != null) args.push("--timeout", String(settle.timeout));
		return args;
	}

	async current(signal?: AbortSignal): Promise<PaneInfo> {
		return (await this.json<{ pane: PaneInfo }>(["pane", "current", "--current"], signal)).pane;
	}

	async listWorkspaces(signal?: AbortSignal): Promise<WorkspaceInfo[]> {
		return (await this.json<{ workspaces?: WorkspaceInfo[] }>(["workspace", "list"], signal)).workspaces || [];
	}

	async createWorkspace(input: { cwd: string; label?: string; focus: boolean }, signal?: AbortSignal) {
		const args = ["workspace", "create", "--cwd", input.cwd];
		if (input.label) args.push("--label", input.label);
		args.push(this.focusFlag(input.focus));
		const result = await this.json<{ workspace: WorkspaceInfo; tab: TabInfo; root_pane: PaneInfo }>(args, signal);
		return { workspace: result.workspace, tab: result.tab, pane: result.root_pane };
	}

	async focusWorkspace(workspace: string, signal?: AbortSignal): Promise<WorkspaceInfo> {
		return (await this.json<{ workspace: WorkspaceInfo }>(["workspace", "focus", workspace], signal)).workspace;
	}

	async listTabs(workspace: string | undefined, signal?: AbortSignal): Promise<TabInfo[]> {
		const args = ["tab", "list"];
		if (workspace) args.push("--workspace", workspace);
		return (await this.json<{ tabs?: TabInfo[] }>(args, signal)).tabs || [];
	}

	async createTab(input: { workspace: string; cwd: string; label?: string; focus: boolean }, signal?: AbortSignal) {
		const args = ["tab", "create", "--workspace", input.workspace, "--cwd", input.cwd];
		if (input.label) args.push("--label", input.label);
		args.push(this.focusFlag(input.focus));
		const result = await this.json<{ tab: TabInfo; root_pane: PaneInfo }>(args, signal);
		return { tab: result.tab, pane: result.root_pane };
	}

	async focusTab(tab: string, signal?: AbortSignal): Promise<TabInfo> {
		return (await this.json<{ tab: TabInfo }>(["tab", "focus", tab], signal)).tab;
	}

	async listPanes(workspace: string, signal?: AbortSignal): Promise<PaneInfo[]> {
		return (await this.json<{ panes?: PaneInfo[] }>(["pane", "list", "--workspace", workspace], signal)).panes || [];
	}

	async paneLayout(pane: string, signal?: AbortSignal): Promise<PaneLayoutSnapshot> {
		return (await this.json<{ layout: PaneLayoutSnapshot }>(["pane", "layout", "--pane", pane], signal)).layout;
	}

	async paneSize(pane: string, signal?: AbortSignal): Promise<PaneSize> {
		const layout = await this.paneLayout(pane, signal);
		const rect = layout.panes.find((candidate) => candidate.pane_id === pane)?.rect;
		// No rect for the pane: a size the split heuristic reads as wide, its old default.
		return rect ? { width: rect.width, height: rect.height } : { width: 80, height: 0 };
	}

	async splitPane(
		input: { pane: string; direction: SplitDirection; cwd: string; focus: boolean },
		signal?: AbortSignal,
	): Promise<PaneInfo> {
		const args = ["pane", "split", input.pane, "--direction", input.direction, "--cwd", input.cwd, this.focusFlag(input.focus)];
		return (await this.json<{ pane: PaneInfo }>(args, signal)).pane;
	}

	async getPane(pane: string, signal?: AbortSignal): Promise<PaneInfo> {
		return (await this.json<{ pane: PaneInfo }>(["pane", "get", pane], signal)).pane;
	}

	async runCommand(pane: string, command: string, signal?: AbortSignal): Promise<void> {
		await this.run(["pane", "run", pane, command], signal);
	}

	async readPane(pane: string, options: ReadOptions, signal?: AbortSignal): Promise<string> {
		return this.text(["pane", "read", pane, ...this.readArgs(options)], signal);
	}

	async waitOutput(pane: string, options: WaitOutputOptions, signal?: AbortSignal): Promise<OutputMatch> {
		const args = ["pane", "wait-output", pane, options.mode === "regex" ? "--regex" : "--match", options.match];
		if (options.source) args.push("--source", options.source);
		if (options.lines != null) args.push("--lines", String(options.lines));
		if (options.timeout != null) args.push("--timeout", String(options.timeout));
		if (options.raw) args.push("--raw");
		const result = await this.json<{ matched_line: string; read?: { text?: string } }>(args, signal);
		return { matchedLine: result.matched_line, text: result.read?.text || result.matched_line };
	}

	async sendText(pane: string, text: string, signal?: AbortSignal): Promise<void> {
		await this.run(["pane", "send-text", pane, text], signal);
	}

	async sendKeys(pane: string, keys: readonly string[], signal?: AbortSignal): Promise<void> {
		await this.run(["pane", "send-keys", pane, ...keys], signal);
	}

	async closePane(pane: string, signal?: AbortSignal): Promise<void> {
		await this.run(["pane", "close", pane], signal);
	}

	async listAgents(signal?: AbortSignal): Promise<AgentInfo[]> {
		return (await this.json<{ agents?: AgentInfo[] }>(["agent", "list"], signal)).agents || [];
	}

	async getAgent(target: string, signal?: AbortSignal): Promise<AgentInfo> {
		return (await this.json<{ agent: AgentInfo }>(["agent", "get", target], signal)).agent;
	}

	async startAgent(input: AgentStart, signal?: AbortSignal): Promise<AgentInfo> {
		const args = ["agent", "start", input.name, "--kind", input.kind, "--pane", input.pane];
		if (input.timeout != null) args.push("--timeout", String(input.timeout));
		if (input.agentArgs.length) args.push("--", ...input.agentArgs);
		return (await this.json<{ agent: AgentInfo }>(args, signal)).agent;
	}

	async promptAgent(target: string, prompt: string, settle: Settlement | null, signal?: AbortSignal): Promise<AgentInfo> {
		const args = ["agent", "prompt", target, prompt];
		if (settle) args.push("--wait", ...this.settleArgs(settle));
		return (await this.json<{ agent: AgentInfo }>(args, signal)).agent;
	}

	async waitAgent(target: string, settle: Settlement, signal?: AbortSignal): Promise<AgentInfo> {
		return (await this.json<{ agent: AgentInfo }>(["agent", "wait", target, ...this.settleArgs(settle)], signal)).agent;
	}

	async readAgent(target: string, options: ReadOptions, signal?: AbortSignal): Promise<string> {
		return this.text(["agent", "read", target, ...this.readArgs(options)], signal);
	}

	async sendAgentKeys(target: string, keys: readonly string[], signal?: AbortSignal): Promise<void> {
		await this.run(["agent", "send-keys", target, ...keys], signal);
	}

	async focusAgent(target: string, signal?: AbortSignal): Promise<AgentInfo> {
		return (await this.json<{ agent: AgentInfo }>(["agent", "focus", target], signal)).agent;
	}

	async renameAgent(target: string, name: string | null, signal?: AbortSignal): Promise<AgentInfo> {
		return (await this.json<{ agent: AgentInfo }>(["agent", "rename", target, name ?? "--clear"], signal)).agent;
	}
}
