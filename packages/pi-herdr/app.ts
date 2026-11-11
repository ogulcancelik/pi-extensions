import {
	type AgentInfo,
	type AgentStart,
	type AgentStatus,
	type Exec,
	type Herdr,
	HerdrUnsupported,
	mostUrgent,
	type OutputMatch,
	type PaneInfo,
	type PaneLayoutSnapshot,
	type PaneSize,
	type ReadOptions,
	type Settlement,
	type SplitDirection,
	type TabInfo,
	type WaitOutputOptions,
	type WorkspaceInfo,
} from "./herdr";

const BACKEND = "the Herdr app";

/** The label naming an agent; herdr-core sets a terminal's own name only when it starts one. */
const NAME_LABEL = "pi-herdr.name";

/** Rows of history a "recent" read takes when no line count is given. */
const RECENT_LINES = 1000;

/** How often output and agent starts are checked while waiting. */
const POLL_MS = 500;

/** How long a started agent has to report itself when no timeout is given. */
const START_TIMEOUT_MS = 30_000;

// --- What the two CLIs print (parsed at the edge, not trusted further) ---

interface AppTerminal {
	terminal: string;
	pane: string | null;
	status: string | null;
	app: string | null;
	name: string | null;
}

interface AppTab {
	id: string;
	name: string;
	active: boolean;
	terminals: AppTerminal[];
}

interface AppSpace {
	id: string;
	name: string;
	folder: string | null;
	active: boolean;
	tabs: AppTab[];
}

interface AppStatus {
	space: string | null;
	tab: string | null;
	focused_pane: string | null;
}

interface CoreTerminal {
	address: string;
	name: string | null;
	cwd: string | null;
	cols: number;
	rows: number;
	/** The program's own report (OSC 7501); `hc ls` gives only its `state` word. */
	status: { state: string; app?: string } | null;
	reported: boolean;
	labels: Record<string, string>;
	foreground: { name: string; cwd: string | null } | null;
}

interface CoreRead {
	text: string;
	complete: boolean;
	why?: string | null;
}

interface CoreWait {
	ended: boolean;
	reason: "status" | "exit" | "output" | "timeout" | "not_started" | string;
	status: string | null;
}

/** A pane in the window: where it is, and the terminal showing it. */
interface Placement {
	space: AppSpace;
	tab: AppTab;
	terminal: AppTerminal & { pane: string };
}

function agentStatus(status: string | null | undefined): AgentStatus {
	switch (status) {
		case "idle":
		case "working":
		case "blocked":
		case "done":
			return status;
		default:
			return "unknown";
	}
}

function settled(settle: Settlement, status: AgentStatus): boolean {
	return settle.until.length ? settle.until.includes(status) : status === "idle" || status === "done" || status === "blocked";
}

/** One word for a shell line that nushell and POSIX shells read the same way. */
function shellWord(word: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
	if (!word.includes("'")) return `'${word}'`;
	throw new Error(`Cannot pass ${JSON.stringify(word)} to the agent: arguments with single quotes are not supported.`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Aborted"));
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * The Herdr app: its window through `herdr-app` (spaces, tabs, panes) and its
 * terminals through herdr-core's `hc` (reading, typing, waiting, agent status).
 * Pi runs in one of its terminals (`HC_TERMINAL_ID`). Workspaces are spaces,
 * and IDs are the app's own (`sp…`, `tb…`, `p…`).
 */
export class AppHerdr implements Herdr {
	constructor(
		private readonly exec: Exec,
		private readonly self: string,
	) {}

	// --- CLI edges ---

	private async run(command: "herdr-app" | "hc", args: string[], signal?: AbortSignal): Promise<string> {
		const result = await this.exec(command, args, { signal });
		if (signal?.aborted || result.killed) throw new Error("Aborted");
		if (result.code !== 0) {
			throw new Error(this.errorMessage(result.stderr) || this.errorMessage(result.stdout) || `${command} ${args.join(" ")} failed with exit code ${result.code}`);
		}
		return result.stdout;
	}

	/** herdr-app says `{ "error": "…" }`; hc says `{ "error": { "message": "…" } }`. */
	private errorMessage(output: string): string | null {
		const trimmed = output.trim();
		if (!trimmed) return null;
		try {
			const error = JSON.parse(trimmed)?.error;
			if (typeof error === "string") return error;
			if (error?.message) return error.hint ? `${error.message} (${error.hint})` : error.message;
			return trimmed;
		} catch {
			return trimmed;
		}
	}

	private async json<T>(command: "herdr-app" | "hc", args: string[], signal?: AbortSignal): Promise<T> {
		const stdout = await this.run(command, args, signal);
		try {
			// SAFETY: the CLI's documented output for this command; only the fields declared above are read.
			return JSON.parse(stdout) as T;
		} catch {
			throw new Error(`Failed to parse JSON from ${command} ${args.join(" ")}`);
		}
	}

	private app<T>(command: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
		return this.json<T>("herdr-app", ["do", command, JSON.stringify(args)], signal);
	}

	private async spaces(signal?: AbortSignal): Promise<AppSpace[]> {
		return (await this.json<{ spaces: AppSpace[] }>("herdr-app", ["ls"], signal)).spaces;
	}

	private status(signal?: AbortSignal): Promise<AppStatus> {
		return this.json<AppStatus>("herdr-app", ["status"], signal);
	}

	private core(terminal: string, signal?: AbortSignal): Promise<CoreTerminal> {
		return this.json<CoreTerminal>("hc", ["get", terminal, "--json"], signal);
	}

	// --- Window model → tool types ---

	private placements(spaces: AppSpace[]): Placement[] {
		return spaces.flatMap((space) =>
			space.tabs.flatMap((tab) =>
				tab.terminals.flatMap((terminal) => (terminal.pane ? [{ space, tab, terminal: { ...terminal, pane: terminal.pane } }] : [])),
			),
		);
	}

	private async place(pane: string, signal?: AbortSignal): Promise<Placement> {
		const found = this.placements(await this.spaces(signal)).find((p) => p.terminal.pane === pane);
		if (!found) throw new Error(`No pane ${pane} in the Herdr app.`);
		return found;
	}

	/** `where`: the terminal's folder and its foreground program's, when known. */
	private paneInfo(p: Placement, status: AppStatus, where: { cwd?: string; foreground_cwd?: string }): PaneInfo {
		return {
			pane_id: p.terminal.pane,
			workspace_id: p.space.id,
			tab_id: p.tab.id,
			focused: status.focused_pane === p.terminal.pane,
			...where,
			label: p.terminal.name ?? undefined,
			agent: p.terminal.app ?? undefined,
			agent_status: agentStatus(p.terminal.status),
		};
	}

	private async describePane(p: Placement, signal?: AbortSignal): Promise<PaneInfo> {
		const [status, core] = await Promise.all([this.status(signal), this.core(p.terminal.terminal, signal)]);
		const cwd = core.cwd ?? undefined;
		return this.paneInfo(p, status, { cwd, foreground_cwd: core.foreground?.cwd ?? cwd });
	}

	private workspaceInfo(space: AppSpace): WorkspaceInfo {
		return {
			workspace_id: space.id,
			label: space.name,
			focused: space.active,
			agent_status: mostUrgent(space.tabs.flatMap((tab) => tab.terminals.map((t) => agentStatus(t.status)))),
		};
	}

	private tabInfo(space: AppSpace, tab: AppTab): TabInfo {
		return {
			tab_id: tab.id,
			workspace_id: space.id,
			label: tab.name,
			focused: space.active && tab.active,
			agent_status: mostUrgent(tab.terminals.map((t) => agentStatus(t.status))),
		};
	}

	private agentInfo(p: Placement, status: AppStatus, core: CoreTerminal): AgentInfo {
		return {
			name: core.labels[NAME_LABEL] || core.name || undefined,
			// The agent's own report names it first; pi's foreground process is only "node".
			agent: core.status?.app ?? p.terminal.app ?? core.foreground?.name ?? undefined,
			display_agent: core.status?.app ?? p.terminal.app ?? undefined,
			agent_status: agentStatus(core.status?.state ?? p.terminal.status),
			workspace_id: p.space.id,
			tab_id: p.tab.id,
			pane_id: p.terminal.pane,
			focused: status.focused_pane === p.terminal.pane,
			cwd: core.foreground?.cwd ?? core.cwd ?? undefined,
		};
	}

	/** Creating in the app shows what it made; `focus: false` gives the focus back. */
	private async keepFocus<T>(focus: boolean, create: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const before = focus ? null : (await this.status(signal)).focused_pane;
		const made = await create();
		if (before) await this.app("pane.focus", { pane: before }, signal);
		return made;
	}

	// --- HerdrLayout ---

	async current(signal?: AbortSignal): Promise<PaneInfo> {
		const found = this.placements(await this.spaces(signal)).find((p) => p.terminal.terminal === this.self);
		if (!found) throw new Error(`Terminal ${this.self} is not in a Herdr app pane.`);
		return this.describePane(found, signal);
	}

	async listWorkspaces(signal?: AbortSignal): Promise<WorkspaceInfo[]> {
		return (await this.spaces(signal)).map((space) => this.workspaceInfo(space));
	}

	async createWorkspace(input: { cwd: string; label?: string; focus: boolean }, signal?: AbortSignal) {
		const made = await this.keepFocus(
			input.focus,
			() => this.app<{ space: string; tab: string; terminal: string }>("space.new", { folder: input.cwd, ...(input.label ? { name: input.label } : {}) }, signal),
			signal,
		);
		const spaces = await this.spaces(signal);
		const space = spaces.find((s) => s.id === made.space);
		const tab = space?.tabs.find((t) => t.id === made.tab);
		const p = this.placements(spaces).find((x) => x.terminal.terminal === made.terminal);
		if (!space || !tab || !p) throw new Error(`The new space ${made.space} is not in the Herdr app.`);
		return { workspace: this.workspaceInfo(space), tab: this.tabInfo(space, tab), pane: await this.describePane(p, signal) };
	}

	async focusWorkspace(workspace: string, signal?: AbortSignal): Promise<WorkspaceInfo> {
		await this.app("space.select", { id: workspace }, signal);
		const space = (await this.spaces(signal)).find((s) => s.id === workspace);
		if (!space) throw new Error(`No workspace ${workspace} in the Herdr app.`);
		return this.workspaceInfo(space);
	}

	async listTabs(workspace: string | undefined, signal?: AbortSignal): Promise<TabInfo[]> {
		return (await this.spaces(signal))
			.filter((space) => !workspace || space.id === workspace)
			.flatMap((space) => space.tabs.map((tab) => this.tabInfo(space, tab)));
	}

	async createTab(input: { workspace: string; cwd: string; label?: string; focus: boolean }, signal?: AbortSignal) {
		const made = await this.keepFocus(
			input.focus,
			() =>
				this.app<{ space: string; tab: string; terminal: string }>(
					"tab.new",
					{ space: input.workspace, folder: input.cwd, ...(input.label ? { name: input.label } : {}) },
					signal,
				),
			signal,
		);
		const spaces = await this.spaces(signal);
		const p = this.placements(spaces).find((x) => x.terminal.terminal === made.terminal);
		if (!p) throw new Error(`The new tab ${made.tab} is not in the Herdr app.`);
		return { tab: this.tabInfo(p.space, p.tab), pane: await this.describePane(p, signal) };
	}

	async focusTab(tab: string, signal?: AbortSignal): Promise<TabInfo> {
		await this.app("tab.select", { id: tab }, signal);
		for (const space of await this.spaces(signal)) {
			const found = space.tabs.find((t) => t.id === tab);
			if (found) return this.tabInfo(space, found);
		}
		throw new Error(`No tab ${tab} in the Herdr app.`);
	}

	async listPanes(workspace: string, signal?: AbortSignal): Promise<PaneInfo[]> {
		const [spaces, status, live] = await Promise.all([
			this.spaces(signal),
			this.status(signal),
			this.json<{ terminals: Array<{ address: string; cwd: string | null }> }>("hc", ["ls", "--json"], signal),
		]);
		const cwds = new Map(live.terminals.map((t) => [t.address, t.cwd]));
		return this.placements(spaces)
			.filter((p) => p.space.id === workspace)
			.map((p) => {
				// hc ls reports one folder per terminal: where its foreground program is.
				const cwd = cwds.get(p.terminal.terminal) ?? undefined;
				return this.paneInfo(p, status, { cwd, foreground_cwd: cwd });
			});
	}

	async paneLayout(_pane: string, _signal?: AbortSignal): Promise<PaneLayoutSnapshot> {
		throw new HerdrUnsupported("pane_layout", BACKEND, "The app does not report pane geometry; use pane_list for a tab's panes.");
	}

	async paneSize(pane: string, signal?: AbortSignal): Promise<PaneSize> {
		const core = await this.core((await this.place(pane, signal)).terminal.terminal, signal);
		return { width: core.cols, height: core.rows };
	}

	async splitPane(
		input: { pane: string; direction: SplitDirection; cwd: string; focus: boolean },
		signal?: AbortSignal,
	): Promise<PaneInfo> {
		const source = await this.place(input.pane, signal);
		const sourceCore = await this.core(source.terminal.terminal, signal);
		// A split starts where its source pane is; anywhere else, its shell starts there.
		const here = (sourceCore.foreground?.cwd ?? sourceCore.cwd) === input.cwd;
		const made = await this.keepFocus(
			input.focus,
			() =>
				this.app<{ pane: string; terminal: string }>(
					"pane.split",
					{
						pane: input.pane,
						direction: input.direction,
						...(here ? {} : { argv: ["/bin/sh", "-c", 'cd "$1" && exec "${SHELL:-/bin/sh}" -l', "sh", input.cwd] }),
					},
					signal,
				),
			signal,
		);
		return this.describePane(await this.place(made.pane, signal), signal);
	}

	// --- HerdrPanes ---

	async getPane(pane: string, signal?: AbortSignal): Promise<PaneInfo> {
		return this.describePane(await this.place(pane, signal), signal);
	}

	async runCommand(pane: string, command: string, signal?: AbortSignal): Promise<void> {
		await this.run("hc", ["send", (await this.place(pane, signal)).terminal.terminal, command, "--json"], signal);
	}

	private async readTerminal(terminal: string, options: ReadOptions, signal?: AbortSignal): Promise<string> {
		if (options.source === "detection") {
			throw new HerdrUnsupported("the detection source", BACKEND, "Read visible or recent output instead.");
		}
		if (options.format === "ansi") {
			throw new HerdrUnsupported("ansi output", BACKEND, "herdr-core reads plain text.");
		}
		const history = options.source === "visible" ? [] : ["--lines", String(options.lines ?? RECENT_LINES)];
		const read = await this.json<CoreRead>("hc", ["read", terminal, "--json", ...history], signal);
		const lines = options.lines != null ? read.text.split("\n").slice(-options.lines).join("\n") : read.text;
		return read.complete || !read.why ? lines : `${lines}\n[${read.why}]`;
	}

	async readPane(pane: string, options: ReadOptions, signal?: AbortSignal): Promise<string> {
		return this.readTerminal((await this.place(pane, signal)).terminal.terminal, options, signal);
	}

	async waitOutput(pane: string, options: WaitOutputOptions, signal?: AbortSignal): Promise<OutputMatch> {
		const terminal = (await this.place(pane, signal)).terminal.terminal;
		const pattern = options.mode === "regex" ? new RegExp(options.match) : null;
		const matches = (line: string) => (pattern ? pattern.test(line) : line.includes(options.match));
		const deadline = options.timeout != null ? Date.now() + options.timeout : null;
		// Existing output counts too, so the search starts before any wait.
		for (;;) {
			const text = await this.readTerminal(terminal, { source: options.source ?? "recent", lines: options.lines }, signal);
			const matchedLine = text.split("\n").find(matches);
			if (matchedLine !== undefined) return { matchedLine, text };
			if (deadline !== null && Date.now() >= deadline) throw new Error(`Timed out waiting for ${JSON.stringify(options.match)} in ${pane}.`);
			await sleep(POLL_MS, signal);
		}
	}

	async sendText(_pane: string, _text: string, _signal?: AbortSignal): Promise<void> {
		throw new HerdrUnsupported("send_text", BACKEND, "herdr-core types text only with Enter: use run, or send_keys for keys.");
	}

	async sendKeys(pane: string, keys: readonly string[], signal?: AbortSignal): Promise<void> {
		await this.run("hc", ["keys", (await this.place(pane, signal)).terminal.terminal, ...keys, "--json"], signal);
	}

	async closePane(pane: string, signal?: AbortSignal): Promise<void> {
		await this.app("pane.close", { pane }, signal);
	}

	// --- HerdrAgents ---

	/**
	 * Agents are terminals that report a status. herdr-core knows that first (the
	 * window's listing catches up later), so it decides; a target is a pane ID or
	 * an agent name.
	 */
	private async agents(signal?: AbortSignal): Promise<Array<{ p: Placement; core: CoreTerminal }>> {
		const [spaces, live] = await Promise.all([
			this.spaces(signal),
			this.json<{ terminals: Array<{ address: string; status?: string | null }> }>("hc", ["ls", "--json"], signal),
		]);
		const reporting = new Set(live.terminals.filter((t) => t.status).map((t) => t.address));
		const placed = this.placements(spaces).filter((p) => reporting.has(p.terminal.terminal));
		const described = await Promise.all(placed.map(async (p) => ({ p, core: await this.core(p.terminal.terminal, signal) })));
		return described.filter(({ core }) => core.reported);
	}

	private async resolve(target: string, signal?: AbortSignal): Promise<{ p: Placement; core: CoreTerminal }> {
		const agents = await this.agents(signal);
		const byPane = agents.find(({ p }) => p.terminal.pane === target);
		if (byPane) return byPane;
		const named = agents.filter(({ core }) => (core.labels[NAME_LABEL] || core.name) === target);
		if (named.length === 1 && named[0]) return named[0];
		if (named.length > 1) throw new Error(`More than one agent is named ${target}; use its pane ID.`);
		throw new Error(`No agent ${target} in the Herdr app.`);
	}

	private async describeAgent(target: string, signal?: AbortSignal): Promise<AgentInfo> {
		const [{ p, core }, status] = await Promise.all([this.resolve(target, signal), this.status(signal)]);
		return this.agentInfo(p, status, core);
	}

	async listAgents(signal?: AbortSignal): Promise<AgentInfo[]> {
		const [agents, status] = await Promise.all([this.agents(signal), this.status(signal)]);
		return agents.map(({ p, core }) => this.agentInfo(p, status, core));
	}

	async getAgent(target: string, signal?: AbortSignal): Promise<AgentInfo> {
		return this.describeAgent(target, signal);
	}

	async startAgent(input: AgentStart, signal?: AbortSignal): Promise<AgentInfo> {
		if ((await this.agents(signal)).some(({ core }) => (core.labels[NAME_LABEL] || core.name) === input.name)) {
			throw new Error(`An agent named ${input.name} already exists.`);
		}
		const terminal = (await this.place(input.pane, signal)).terminal.terminal;
		const shell = await this.core(terminal, signal);
		if (shell.reported) throw new Error(`Pane ${input.pane} already runs an agent.`);
		// Typed into the pane's own shell, as a person would start it.
		const line = [input.kind, ...input.agentArgs].map(shellWord).join(" ");
		await this.run("hc", ["send", terminal, line, "--json"], signal);
		await this.run("hc", ["label", terminal, `${NAME_LABEL}=${input.name}`, "--json"], signal);
		const deadline = Date.now() + (input.timeout ?? START_TIMEOUT_MS);
		for (;;) {
			if ((await this.core(terminal, signal)).reported) return this.describeAgent(input.pane, signal);
			if (Date.now() >= deadline) throw new Error(`${input.kind} did not report itself in ${input.pane} in time.`);
			await sleep(POLL_MS, signal);
		}
	}

	/** herdr-core waits in rounds; a round that ends unsettled waits again until the deadline. */
	private async settle(terminal: string, pane: string, settle: Settlement, signal?: AbortSignal): Promise<AgentInfo> {
		const deadline = settle.timeout != null ? Date.now() + settle.timeout : null;
		for (;;) {
			const agent = await this.describeAgent(pane, signal);
			if (settled(settle, agent.agent_status)) return agent;
			const left = deadline === null ? 180_000 : deadline - Date.now();
			if (left <= 0) throw new Error(`Timed out waiting for ${agent.name || pane}; it is ${agent.agent_status}.`);
			const wait = await this.json<CoreWait>("hc", ["wait", terminal, "--json", "--timeout", String(Math.max(1, Math.ceil(left / 1000)))], signal);
			if (wait.reason === "exit") throw new Error(`The agent in ${pane} exited.`);
		}
	}

	async promptAgent(target: string, prompt: string, settle: Settlement | null, signal?: AbortSignal): Promise<AgentInfo> {
		const { p } = await this.resolve(target, signal);
		const terminal = p.terminal.terminal;
		if (!settle) {
			await this.run("hc", ["send", terminal, prompt, "--json"], signal);
			return this.describeAgent(p.terminal.pane, signal);
		}
		const timeout = settle.timeout != null ? ["--timeout", String(Math.max(1, Math.ceil(settle.timeout / 1000)))] : [];
		const sent = await this.json<CoreWait>("hc", ["send", terminal, prompt, "--wait", "--json", ...timeout], signal);
		if (sent.reason === "not_started") throw new Error(`agent_prompt_stalled: ${target} did not start working on the prompt.`);
		return this.settle(terminal, p.terminal.pane, settle, signal);
	}

	async waitAgent(target: string, settle: Settlement, signal?: AbortSignal): Promise<AgentInfo> {
		const { p } = await this.resolve(target, signal);
		return this.settle(p.terminal.terminal, p.terminal.pane, settle, signal);
	}

	async readAgent(target: string, options: ReadOptions, signal?: AbortSignal): Promise<string> {
		return this.readTerminal((await this.resolve(target, signal)).p.terminal.terminal, options, signal);
	}

	async sendAgentKeys(target: string, keys: readonly string[], signal?: AbortSignal): Promise<void> {
		await this.run("hc", ["keys", (await this.resolve(target, signal)).p.terminal.terminal, ...keys, "--json"], signal);
	}

	async focusAgent(target: string, signal?: AbortSignal): Promise<AgentInfo> {
		const { p } = await this.resolve(target, signal);
		await this.app("agent.focus", { terminal: p.terminal.terminal }, signal);
		return this.describeAgent(p.terminal.pane, signal);
	}

	async renameAgent(target: string, name: string | null, signal?: AbortSignal): Promise<AgentInfo> {
		const { p } = await this.resolve(target, signal);
		if (name && (await this.agents(signal)).some(({ p: other, core }) => other.terminal.pane !== p.terminal.pane && (core.labels[NAME_LABEL] || core.name) === name)) {
			throw new Error(`An agent named ${name} already exists.`);
		}
		await this.run("hc", ["label", p.terminal.terminal, `${NAME_LABEL}=${name ?? ""}`, "--json"], signal);
		return this.describeAgent(p.terminal.pane, signal);
	}
}
