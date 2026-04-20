import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
type ReadSource = "visible" | "recent" | "recent-unwrapped";

interface WorkspaceInfo {
	workspace_id: string;
	number: number;
	label: string;
	focused: boolean;
	pane_count: number;
	tab_count: number;
	active_tab_id: string;
	agent_status: AgentStatus;
}

interface TabInfo {
	tab_id: string;
	workspace_id: string;
	number: number;
	label: string;
	focused: boolean;
	pane_count: number;
	agent_status: AgentStatus;
}

interface PaneInfo {
	pane_id: string;
	workspace_id: string;
	tab_id: string;
	focused: boolean;
	cwd?: string;
	agent?: string;
	agent_status: AgentStatus;
	revision: number;
}

interface PaneReadResult {
	pane_id: string;
	workspace_id: string;
	tab_id: string;
	source: "visible" | "recent" | "recent_unwrapped";
	text: string;
	revision: number;
	truncated: boolean;
}

interface ManagedPane {
	paneId: string;
	workspaceId: string;
}

interface HerdrJsonEnvelope {
	id?: string;
	result?: any;
	error?: {
		code?: string;
		message?: string;
	};
}

interface HerdrToolDetails {
	action?: string;
	aliases: Record<string, ManagedPane>;
	aliasOrder: string[];
	[key: string]: unknown;
}

const ActionEnum = StringEnum(
	[
		"list",
		"workspace_list",
		"workspace_create",
		"workspace_focus",
		"tab_list",
		"tab_create",
		"tab_focus",
		"focus",
		"pane_split",
		"run",
		"read",
		"watch",
		"wait_agent",
		"send",
		"stop",
	] as const,
	{ description: "Action to perform" },
);

const StatusEnum = StringEnum(["idle", "working", "blocked", "done", "unknown"] as const, {
	description: "Agent status to wait for",
});

const SourceEnum = StringEnum(["visible", "recent", "recent-unwrapped"] as const, {
	description: "Read source for read/watch",
});

const DirectionEnum = StringEnum(["right", "down"] as const, {
	description: "Split direction for pane_split",
});

const WaitModeEnum = StringEnum(["all", "any"] as const, {
	description: "How multi-pane waits should resolve",
});

export default function (pi: ExtensionAPI) {
	const herdrEnv = process.env.HERDR_ENV;
	const currentPaneTargetEnv = process.env.HERDR_PANE_ID;
	if (!herdrEnv || !currentPaneTargetEnv) {
		return;
	}
	const currentPaneTarget = currentPaneTargetEnv;

	const managedPanes = new Map<string, ManagedPane>();
	const aliasOrder: string[] = [];

	function snapshotAliases(): Record<string, ManagedPane> {
		return Object.fromEntries(managedPanes.entries());
	}

	function withSnapshot(details: Omit<HerdrToolDetails, "aliases" | "aliasOrder">): HerdrToolDetails {
		return {
			...details,
			aliases: snapshotAliases(),
			aliasOrder: [...aliasOrder],
		};
	}

	function setAliases(aliases: Record<string, ManagedPane>, order: string[]) {
		managedPanes.clear();
		aliasOrder.length = 0;
		for (const [alias, managed] of Object.entries(aliases)) {
			managedPanes.set(alias, managed);
		}
		for (const alias of order) {
			if (managedPanes.has(alias)) aliasOrder.push(alias);
		}
		for (const alias of managedPanes.keys()) {
			if (!aliasOrder.includes(alias)) aliasOrder.push(alias);
		}
	}

	function reconstructState(ctx: ExtensionContext) {
		let aliases: Record<string, ManagedPane> = {};
		let order: string[] = [];

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult" || message.toolName !== "herdr") continue;
			const details = message.details as HerdrToolDetails | undefined;
			if (!details?.aliases) continue;
			aliases = details.aliases;
			order = Array.isArray(details.aliasOrder) ? details.aliasOrder : Object.keys(details.aliases);
		}

		setAliases(aliases, order);
	}

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	function recordAlias(alias: string, paneId: string, workspaceId: string) {
		managedPanes.set(alias, { paneId, workspaceId });
		const existingIndex = aliasOrder.indexOf(alias);
		if (existingIndex !== -1) aliasOrder.splice(existingIndex, 1);
		aliasOrder.push(alias);
	}

	function forgetAlias(alias: string) {
		managedPanes.delete(alias);
		const index = aliasOrder.indexOf(alias);
		if (index !== -1) aliasOrder.splice(index, 1);
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

	function isAbortError(error: unknown, signal?: AbortSignal): boolean {
		return signal?.aborted === true || (error instanceof Error && error.message === "Aborted");
	}

	async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error("Aborted");
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				clearTimeout(timeout);
				reject(new Error("Aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	async function execHerdr(args: string[], signal?: AbortSignal) {
		const result = await pi.exec("herdr", args, { signal });
		if (signal?.aborted || result.killed) {
			throw new Error("Aborted");
		}
		if (result.code !== 0) {
			const message =
				parseHerdrError(result.stderr) ||
				parseHerdrError(result.stdout) ||
				`herdr ${args.join(" ")} failed with exit code ${result.code}`;
			throw new Error(message);
		}
		return result;
	}

	async function execHerdrJson<T = any>(args: string[], signal?: AbortSignal): Promise<T> {
		const result = await execHerdr(args, signal);
		const stdout = result.stdout.trim();
		if (!stdout) {
			throw new Error(`Expected JSON output from herdr ${args.join(" ")}`);
		}
		let value: HerdrJsonEnvelope;
		try {
			value = JSON.parse(stdout) as HerdrJsonEnvelope;
		} catch {
			throw new Error(`Failed to parse JSON from herdr ${args.join(" ")}`);
		}
		if (value.error) {
			throw new Error(value.error.message || value.error.code || `herdr ${args.join(" ")} failed`);
		}
		return value as T;
	}

	async function execHerdrText(args: string[], signal?: AbortSignal): Promise<string> {
		const result = await execHerdr(args, signal);
		return result.stdout;
	}

	async function getCurrentPaneInfo(signal?: AbortSignal): Promise<PaneInfo> {
		const response = await execHerdrJson<{ result: { pane: PaneInfo } }>(["pane", "get", currentPaneTarget], signal);
		return response.result.pane;
	}

	async function getWorkspaceInfo(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceInfo> {
		const response = await execHerdrJson<{ result: { workspace: WorkspaceInfo } }>([
			"workspace",
			"get",
			workspaceId,
		], signal);
		return response.result.workspace;
	}

	async function getWorkspaceList(signal?: AbortSignal): Promise<WorkspaceInfo[]> {
		const response = await execHerdrJson<{ result: { workspaces: WorkspaceInfo[] } }>(["workspace", "list"], signal);
		return response.result.workspaces || [];
	}

	async function getWorkspacePanes(workspaceId: string, signal?: AbortSignal): Promise<PaneInfo[]> {
		const response = await execHerdrJson<{ result: { panes: PaneInfo[] } }>([
			"pane",
			"list",
			"--workspace",
			workspaceId,
		], signal);
		return response.result.panes || [];
	}

	async function getTabList(workspaceId?: string, signal?: AbortSignal): Promise<TabInfo[]> {
		const args = ["tab", "list"];
		if (workspaceId) args.push("--workspace", workspaceId);
		const response = await execHerdrJson<{ result: { tabs: TabInfo[] } }>(args, signal);
		return response.result.tabs || [];
	}

	async function getPaneInfo(paneId: string, signal?: AbortSignal): Promise<PaneInfo | null> {
		try {
			const response = await execHerdrJson<{ result: { pane: PaneInfo } }>(["pane", "get", paneId], signal);
			return response.result.pane;
		} catch (error) {
			if (isAbortError(error, signal)) throw error;
			return null;
		}
	}

	async function resolveManagedPane(alias: string, workspaceId: string, signal?: AbortSignal): Promise<ManagedPane | null> {
		const managed = managedPanes.get(alias);
		if (!managed) return null;
		if (managed.workspaceId !== workspaceId) return null;

		const pane = await getPaneInfo(managed.paneId, signal);
		if (!pane) {
			forgetAlias(alias);
			return null;
		}

		return managed;
	}

	async function resolvePaneRef(
		ref: string,
		workspaceId: string,
		signal?: AbortSignal,
	): Promise<{ pane: PaneInfo; alias?: string } | null> {
		const managed = await resolveManagedPane(ref, workspaceId, signal);
		if (managed) {
			const pane = await getPaneInfo(managed.paneId, signal);
			if (!pane) {
				forgetAlias(ref);
				return null;
			}
			return { pane, alias: ref };
		}

		const pane = await getPaneInfo(ref, signal);
		if (!pane) return null;
		const alias = [...managedPanes.entries()].find(([, managedPane]) => managedPane.paneId === pane.pane_id)?.[0];
		return { pane, alias };
	}

	async function requirePaneRef(
		ref: string,
		workspaceId: string,
		signal?: AbortSignal,
	): Promise<{ pane: PaneInfo; alias?: string }> {
		const hadAlias = managedPanes.has(ref);
		const resolved = await resolvePaneRef(ref, workspaceId, signal);
		if (resolved) return resolved;
		if (hadAlias) {
			throw new Error(`Pane alias '${ref}' no longer points to a live pane and was removed.`);
		}
		throw new Error(`Pane '${ref}' not found in the current workspace.`);
	}

	async function readPane(
		paneId: string,
		options: { source?: ReadSource; lines?: number; raw?: boolean },
		signal?: AbortSignal,
	): Promise<string> {
		const args = ["pane", "read", paneId];
		if (options.source) args.push("--source", options.source);
		if (options.lines != null) args.push("--lines", String(options.lines));
		if (options.raw) args.push("--raw");
		return execHerdrText(args, signal);
	}

	function formatReadOutput(output: string): string {
		const truncation = truncateTail(output, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		let text = truncation.content;
		if (truncation.truncated) {
			text = `[Showing last ${truncation.outputLines} of ${truncation.totalLines} lines]\n${text}`;
		}
		return text;
	}

	function summarizePane(pane: PaneInfo, alias?: string, currentPaneId?: string): string {
		const name = alias || pane.pane_id;
		const flags = [
			pane.pane_id === currentPaneId || pane.focused ? "current" : null,
			pane.agent ? pane.agent : null,
			pane.agent_status !== "unknown" ? pane.agent_status : null,
		]
			.filter(Boolean)
			.join(", ");
		const cwd = pane.cwd ? ` ${pane.cwd}` : "";
		return `${name}: [${pane.pane_id}]${flags ? ` (${flags})` : ""}${cwd}`;
	}

	function summarizeTab(tab: TabInfo): string {
		const flags = [tab.focused ? "focused" : null, tab.agent_status !== "unknown" ? tab.agent_status : null]
			.filter(Boolean)
			.join(", ");
		return `${tab.label}: [${tab.tab_id}]${flags ? ` (${flags})` : ""}`;
	}

	function summarizeWorkspace(workspace: WorkspaceInfo): string {
		const flags = [workspace.focused ? "focused" : null, workspace.agent_status !== "unknown" ? workspace.agent_status : null]
			.filter(Boolean)
			.join(", ");
		return `${workspace.label}: [${workspace.workspace_id}]${flags ? ` (${flags})` : ""}`;
	}

	function rejectUnexpectedParams(
		action: string,
		params: { workspace?: string; tab?: string },
		unexpected: Array<"workspace" | "tab">,
	) {
		const present = unexpected.filter((key) => params[key] != null);
		if (!present.length) return;
		throw new Error(
			`${action} targets panes, not ${present.join(" or ")}. Use a pane alias or pane id from list, or the root pane returned by tab_create/workspace_create.`,
		);
	}

	function formatStatusList(statuses: AgentStatus[]): string {
		return statuses.join("|");
	}

	function throwIfAborted(signal: AbortSignal | undefined, action: string) {
		if (signal?.aborted) {
			throw new Error(`${action} canceled.`);
		}
	}

	function sleepWithSignal(ms: number, signal: AbortSignal | undefined) {
		if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
		if (signal.aborted) return Promise.reject(new Error("wait_agent canceled."));
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				reject(new Error("wait_agent canceled."));
			};
			signal.addEventListener("abort", onAbort, { once: true });
		});
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

	pi.registerTool({
		name: "herdr",
		label: "herdr",
		description:
			"Herdr-native pane orchestration for long-running workflows. " +
			"Actions: list panes, manage workspaces and tabs, split existing panes, submit lines atomically in existing panes, read output, watch readiness, wait for one or more agent panes to reach target statuses, send raw text or keys, focus contexts, and stop panes.",
		promptGuidelines: [
			"Use `herdr` run for long-running processes in other panes instead of `bash`.",
			"When you want to submit a line or prompt to a pane, prefer `run` over `send` + `Enter` so text and Enter happen atomically.",
			"Use `send` only for low-level literal text or key injection when you do not want command-style submission semantics.",
			"Preserve the current UI focus by default. Do not change workspace or tab focus unless the user explicitly asks or the workflow truly requires visible interaction there.",
			"Pane actions like pane_split, run, read, watch, wait_agent, send, and stop must target pane aliases or pane ids, not tab ids.",
			"Use `herdr` workspace, tab, and pane_split actions to organize parallel work instead of piling everything into one pane stack.",
			"Use `herdr` watch for log/output conditions like server readiness, test completion, or regex matches.",
			"Use `herdr` wait_agent with agent statuses. It can wait on one pane or a set of panes, and background finished panes usually become `done` while focused finished panes usually become `idle`.",
			"Use `recent-unwrapped` when you need log matching or reads that ignore soft wrapping.",
			"Pane references can be either friendly aliases you created earlier or real herdr pane ids from `list`.",
			"Use `pane_split`, `tab_create`, or `workspace_create` to establish new pane targets. `run` only works with an existing pane alias or pane id.",
			"Use friendly pane aliases like `server`, `reviewer`, or `tests` so later reads, watches, and sends can reuse them across the session.",
			"When starting a fresh pi instance in another pane and the model matters, either specify `--model` explicitly or ask the user which model/provider they want.",
		],
		parameters: Type.Object({
			action: ActionEnum,
			pane: Type.Optional(Type.String({ description: "Friendly pane alias or explicit pane id" })),
			panes: Type.Optional(Type.Array(Type.String(), { description: "Pane aliases or pane ids for multi-pane waits" })),
			workspace: Type.Optional(Type.String({ description: "Workspace id for workspace or tab actions" })),
			tab: Type.Optional(Type.String({ description: "Tab id for tab actions or focus(tab) only. Pane actions must use pane ids or aliases." })),
			label: Type.Optional(Type.String({ description: "Workspace or tab label for create actions" })),
			newPane: Type.Optional(Type.String({ description: "Alias to remember for the pane created by pane_split" })),
			direction: Type.Optional(DirectionEnum),
			command: Type.Optional(Type.String({ description: "Line to submit atomically with Enter (for run action)" })),
			match: Type.Optional(Type.String({ description: "Text or regex to wait for (for watch action)" })),
			regex: Type.Optional(Type.Boolean({ description: "Treat match as a regex (for watch action)" })),
			status: Type.Optional(StatusEnum),
			statuses: Type.Optional(Type.Array(StatusEnum, { description: "Accepted statuses for wait_agent" })),
			mode: Type.Optional(WaitModeEnum),
			timeout: Type.Optional(Type.Number({ description: "Timeout in ms (for watch or wait_agent action)" })),
			lines: Type.Optional(Type.Number({ description: "Scrollback lines to capture or inspect" })),
			source: Type.Optional(SourceEnum),
			raw: Type.Optional(Type.Boolean({ description: "Disable ANSI stripping for read/watch" })),
			text: Type.Optional(Type.String({ description: "Literal text to send without Enter (for send action). Use run if you want text plus Enter atomically." })),
			keys: Type.Optional(
				Type.String({
					description: "Keys to send, space-separated (for send action). Examples: C-c, Enter, q, y",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for workspace/tab create where supported" })),
			focus: Type.Optional(Type.Boolean({ description: "Explicitly change focus for create/focus actions. Defaults should preserve current focus." })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const currentPane = await getCurrentPaneInfo(signal);
			const currentPaneId = currentPane.pane_id;
			const currentWorkspaceId = currentPane.workspace_id;

			switch (params.action) {
				case "list": {
					const panes = await getWorkspacePanes(currentWorkspaceId, signal);
					const aliasByPaneId = new Map<string, string>();
					for (const [alias, managed] of managedPanes.entries()) {
						if (managed.workspaceId === currentWorkspaceId) aliasByPaneId.set(managed.paneId, alias);
					}

					const text = panes.length
						? panes.map((pane) => summarizePane(pane, aliasByPaneId.get(pane.pane_id), currentPaneId)).join("\n")
						: "No panes in current workspace.";

					return {
						content: [{ type: "text", text }],
						details: withSnapshot({
							action: "list",
							panes,
							currentPaneId,
							workspaceId: currentWorkspaceId,
							paneAliases: Object.fromEntries(aliasByPaneId),
						}),
					};
				}

				case "workspace_list": {
					const workspaces = await getWorkspaceList(signal);
					const text = workspaces.length
						? workspaces.map(summarizeWorkspace).join("\n")
						: "No workspaces.";
					return {
						content: [{ type: "text", text }],
						details: withSnapshot({ action: "workspace_list", workspaces }),
					};
				}

				case "workspace_create": {
					const args = ["workspace", "create"];
					if (params.cwd) args.push("--cwd", params.cwd);
					if (params.label) args.push("--label", params.label);
					if (params.focus !== true) args.push("--no-focus");
					const response = await execHerdrJson<{
						result: { workspace: WorkspaceInfo; root_pane?: PaneInfo };
					}>(args, signal);
					const workspace = response.result.workspace;
					const rootPane =
						response.result.root_pane ?? (await getWorkspacePanes(workspace.workspace_id, signal))[0] ?? null;
					if (params.pane && rootPane) {
						recordAlias(params.pane, rootPane.pane_id, workspace.workspace_id);
					}
					const aliasText = params.pane && rootPane ? `, aliased as '${params.pane}'` : "";
					const rootPaneText = rootPane ? `, root pane ${rootPane.pane_id}${aliasText}` : "";
					return {
						content: [{
							type: "text",
							text: `Created workspace '${workspace.label}' (${workspace.workspace_id})${rootPaneText}`,
						}],
						details: withSnapshot({
							action: "workspace_create",
							workspace,
							rootPaneId: rootPane?.pane_id,
							pane: params.pane,
						}),
					};
				}

				case "workspace_focus": {
					const workspaceId = params.workspace;
					if (!workspaceId) throw new Error("'workspace' is required for workspace_focus");
					const response = await execHerdrJson<{ result: { workspace: WorkspaceInfo } }>([
						"workspace",
						"focus",
						workspaceId,
					], signal);
					return {
						content: [{ type: "text", text: `Focused workspace '${response.result.workspace.label}'` }],
						details: withSnapshot({ action: "workspace_focus", workspace: response.result.workspace }),
					};
				}

				case "tab_list": {
					const workspaceId = params.workspace ?? currentWorkspaceId;
					const tabs = await getTabList(workspaceId, signal);
					const text = tabs.length ? tabs.map(summarizeTab).join("\n") : "No tabs.";
					return {
						content: [{ type: "text", text }],
						details: withSnapshot({ action: "tab_list", tabs, workspaceId }),
					};
				}

				case "tab_create": {
					const workspaceId = params.workspace ?? currentWorkspaceId;
					const args = ["tab", "create", "--workspace", workspaceId];
					if (params.cwd) args.push("--cwd", params.cwd);
					if (params.label) args.push("--label", params.label);
					if (params.focus !== true) args.push("--no-focus");
					const response = await execHerdrJson<{ result: { tab: TabInfo; root_pane?: PaneInfo } }>(args, signal);
					const tab = response.result.tab;
					const rootPane =
						response.result.root_pane ??
						(await getWorkspacePanes(tab.workspace_id, signal)).find((pane) => pane.tab_id === tab.tab_id) ??
						null;
					if (params.pane && rootPane) {
						recordAlias(params.pane, rootPane.pane_id, tab.workspace_id);
					}
					const aliasText = params.pane && rootPane ? `, aliased as '${params.pane}'` : "";
					const rootPaneText = rootPane ? `, root pane ${rootPane.pane_id}${aliasText}` : "";
					return {
						content: [{ type: "text", text: `Created tab '${tab.label}' (${tab.tab_id})${rootPaneText}` }],
						details: withSnapshot({
							action: "tab_create",
							tab,
							rootPaneId: rootPane?.pane_id,
							pane: params.pane,
						}),
					};
				}

				case "tab_focus": {
					const tabId = params.tab;
					if (!tabId) throw new Error("'tab' is required for tab_focus");
					const response = await execHerdrJson<{ result: { tab: TabInfo } }>(["tab", "focus", tabId], signal);
					return {
						content: [{ type: "text", text: `Focused tab '${response.result.tab.label}'` }],
						details: withSnapshot({ action: "tab_focus", tab: response.result.tab }),
					};
				}

				case "focus": {
					if (params.tab) {
						const response = await execHerdrJson<{ result: { tab: TabInfo } }>(["tab", "focus", params.tab], signal);
						return {
							content: [{ type: "text", text: `Focused tab '${response.result.tab.label}'` }],
							details: withSnapshot({ action: "focus", target: "tab", tab: response.result.tab }),
						};
					}
					if (params.workspace) {
						const response = await execHerdrJson<{ result: { workspace: WorkspaceInfo } }>([
							"workspace",
							"focus",
							params.workspace,
						], signal);
						return {
							content: [{ type: "text", text: `Focused workspace '${response.result.workspace.label}'` }],
							details: withSnapshot({ action: "focus", target: "workspace", workspace: response.result.workspace }),
						};
					}
					if (params.pane) {
						const resolved = await requirePaneRef(params.pane, currentWorkspaceId, signal);
						const response = await execHerdrJson<{ result: { tab: TabInfo } }>(["tab", "focus", resolved.pane.tab_id], signal);
						return {
							content: [{
								type: "text",
								text: `Focused tab '${response.result.tab.label}' for pane '${resolved.pane.pane_id}'. Herdr does not expose direct pane focus yet.`,
							}],
							details: withSnapshot({ action: "focus", target: "pane", paneId: resolved.pane.pane_id, tab: response.result.tab }),
						};
					}
					throw new Error("'workspace', 'tab', or 'pane' is required for focus");
				}

				case "pane_split": {
					rejectUnexpectedParams("pane_split", params, ["workspace", "tab"]);
					const paneRef = params.pane;
					const direction = params.direction;
					if (!paneRef) throw new Error("'pane' is required for pane_split");
					if (!direction) throw new Error("'direction' is required for pane_split");

					const sourcePane = await requirePaneRef(paneRef, currentWorkspaceId, signal);
					const args = ["pane", "split", sourcePane.pane.pane_id, "--direction", direction];
					if (params.cwd) args.push("--cwd", params.cwd);
					if (params.focus !== true) args.push("--no-focus");

					const response = await execHerdrJson<{ result: { pane: PaneInfo } }>(args, signal);
					const splitPane = response.result.pane;
					if (params.newPane) {
						recordAlias(params.newPane, splitPane.pane_id, splitPane.workspace_id);
					}

					const sourceLabel = sourcePane.alias || paneRef;
					const aliasText = params.newPane ? `, aliased as '${params.newPane}'` : "";
					return {
						content: [{
							type: "text",
							text: `Created pane '${splitPane.pane_id}' by splitting '${sourceLabel}' ${direction}${aliasText}`,
						}],
						details: withSnapshot({
							action: "pane_split",
							pane: sourceLabel,
							paneId: sourcePane.pane.pane_id,
							newPane: params.newPane || splitPane.pane_id,
							newPaneId: splitPane.pane_id,
							direction,
							workspaceId: splitPane.workspace_id,
						}),
					};
				}

				case "run": {
					rejectUnexpectedParams("run", params, ["workspace", "tab"]);
					const paneRef = params.pane;
					const command = params.command;
					if (!paneRef) throw new Error("'pane' is required for run");
					if (!command) throw new Error("'command' is required for run");

					const targetPane = await requirePaneRef(paneRef, currentWorkspaceId, signal);
					await execHerdr(["pane", "run", targetPane.pane.pane_id, command], signal);

					await sleep(800, signal);
					const initialOutput = await readPane(
						targetPane.pane.pane_id,
						{
							source: params.source ?? "recent",
							lines: params.lines ?? 20,
							raw: params.raw,
						},
						signal,
					);

					const paneLabel = targetPane.alias || paneRef;
					return {
						content: [
							{
								type: "text",
								text: `Started '${command}' in pane '${paneLabel}' (${targetPane.pane.pane_id})\n\n${formatReadOutput(initialOutput)}`,
							},
						],
						details: withSnapshot({
							action: "run",
							pane: paneLabel,
							paneId: targetPane.pane.pane_id,
							command,
							workspaceId: currentWorkspaceId,
						}),
					};
				}

				case "read": {
					rejectUnexpectedParams("read", params, ["workspace", "tab"]);
					const paneRef = params.pane;
					if (!paneRef) throw new Error("'pane' is required for read");

					const resolved = await requirePaneRef(paneRef, currentWorkspaceId, signal);

					const output = await readPane(
						resolved.pane.pane_id,
						{
							source: params.source ?? "recent",
							lines: params.lines ?? 20,
							raw: params.raw,
						},
						signal,
					);

					return {
						content: [{ type: "text", text: formatReadOutput(output) }],
						details: withSnapshot({
							action: "read",
							pane: resolved.alias || paneRef,
							paneId: resolved.pane.pane_id,
							source: params.source ?? "recent",
						}),
					};
				}

				case "watch": {
					rejectUnexpectedParams("watch", params, ["workspace", "tab"]);
					const paneRef = params.pane;
					const match = params.match;
					if (!paneRef) throw new Error("'pane' is required for watch");
					if (!match) throw new Error("'match' is required for watch");

					const resolved = await requirePaneRef(paneRef, currentWorkspaceId, signal);
					const paneLabel = resolved.alias || paneRef;
					const startTime = Date.now();

					const publishWatchUpdate = () => {
						onUpdate?.({
							content: [{ type: "text", text: `Watching ${paneLabel}...` }],
							details: withSnapshot({
								action: "watch",
								pane: paneLabel,
								paneId: resolved.pane.pane_id,
								match,
								elapsed: Math.floor((Date.now() - startTime) / 1000),
							}),
						});
					};

					publishWatchUpdate();
					const updateTimer = onUpdate ? setInterval(publishWatchUpdate, 1000) : null;

					try {
						const args = ["wait", "output", resolved.pane.pane_id, "--match", match];
						if (params.source) args.push("--source", params.source);
						if (params.lines != null) args.push("--lines", String(params.lines));
						if (params.timeout != null) args.push("--timeout", String(params.timeout));
						if (params.regex) args.push("--regex");
						if (params.raw) args.push("--raw");

						const response = await execHerdrJson<{
							result: {
								type: string;
								pane_id: string;
								revision: number;
								matched_line: string;
								read: PaneReadResult;
							};
						}>(args, signal);
						const matched = response.result;
						const text = matched.read?.text ? formatReadOutput(matched.read.text) : matched.matched_line;

						return {
							content: [{ type: "text", text: `Matched: ${matched.matched_line}\n\n${text}` }],
							details: withSnapshot({
								action: "watch",
								pane: paneLabel,
								paneId: resolved.pane.pane_id,
								matchedLine: matched.matched_line,
								elapsed: Math.floor((Date.now() - startTime) / 1000),
							}),
						};
					} finally {
						if (updateTimer) clearInterval(updateTimer);
					}
				}

				case "wait_agent": {
					rejectUnexpectedParams("wait_agent", params, ["workspace", "tab"]);
					throwIfAborted(signal, "wait_agent");
					const paneRefs = params.panes?.length ? params.panes : params.pane ? [params.pane] : [];
					const statuses = params.statuses?.length ? params.statuses : params.status ? [params.status] : [];
					const mode = params.mode ?? "all";
					if (!paneRefs.length) throw new Error("'pane' or 'panes' is required for wait_agent");
					if (!statuses.length) throw new Error("'status' or 'statuses' is required for wait_agent");

					const resolvedPanes: Array<{ pane: PaneInfo; aliasOrRef: string }> = [];
					for (const paneRef of paneRefs) {
						throwIfAborted(signal, "wait_agent");
						const resolved = await requirePaneRef(paneRef, currentWorkspaceId, signal);
						resolvedPanes.push({
							pane: resolved.pane,
							aliasOrRef: resolved.alias || paneRef,
						});
					}

					const deadline = params.timeout != null ? Date.now() + params.timeout : null;
					let snapshot: Array<{
						pane: string;
						paneId: string;
						status: AgentStatus;
						agent?: string;
					}> = [];

					while (true) {
						throwIfAborted(signal, "wait_agent");
						snapshot = [];
						for (const resolved of resolvedPanes) {
							throwIfAborted(signal, "wait_agent");
							const pane = await getPaneInfo(resolved.pane.pane_id, signal);
							if (!pane) throw new Error(`Pane '${resolved.aliasOrRef}' no longer exists.`);
							snapshot.push({
								pane: resolved.aliasOrRef,
								paneId: pane.pane_id,
								status: pane.agent_status,
								agent: pane.agent,
							});
						}

						const satisfied =
							mode === "all"
								? snapshot.every((item) => statuses.includes(item.status))
								: snapshot.some((item) => statuses.includes(item.status));
						if (satisfied) break;
						if (deadline != null && Date.now() >= deadline) {
							throw new Error(
								`Timed out waiting for panes [${snapshot.map((item) => item.pane).join(", ")}] to reach ${mode} of statuses '${formatStatusList(statuses)}'. Last statuses: ${snapshot.map((item) => `${item.pane}=${item.status}`).join(", ")}`,
							);
						}
						await sleepWithSignal(250, signal);
					}

					const summary = snapshot.map((item) => `${item.pane}=${item.status}`).join(", ");
					return {
						content: [{
							type: "text",
							text: `wait_agent satisfied (${mode}: ${formatStatusList(statuses)})\n\n${summary}`,
						}],
						details: withSnapshot({
							action: "wait_agent",
							pane: paneRefs.length === 1 ? resolvedPanes[0]?.aliasOrRef : undefined,
							panes: snapshot.map((item) => item.pane),
							paneIds: snapshot.map((item) => item.paneId),
							status: paneRefs.length === 1 && statuses.length === 1 ? snapshot[0]?.status : undefined,
							statuses,
							mode,
							agents: snapshot.map((item) => item.agent).filter(Boolean),
							snapshot,
						}),
					};
				}

				case "send": {
					rejectUnexpectedParams("send", params, ["workspace", "tab"]);
					const paneRef = params.pane;
					if (!paneRef) throw new Error("'pane' is required for send");
					if (!params.text && !params.keys) throw new Error("'text' or 'keys' is required for send");

					const resolved = await requirePaneRef(paneRef, currentWorkspaceId, signal);

					if (params.text) {
						await execHerdr(["pane", "send-text", resolved.pane.pane_id, params.text], signal);
					}
					if (params.keys) {
						const keys = params.keys.split(/\s+/).filter(Boolean);
						await execHerdr(["pane", "send-keys", resolved.pane.pane_id, ...keys], signal);
					}

					const desc = [params.text && `"${params.text}"`, params.keys].filter(Boolean).join(" + ");
					return {
						content: [{ type: "text", text: `Sent ${desc} to pane '${resolved.alias || paneRef}'` }],
						details: withSnapshot({
							action: "send",
							pane: resolved.alias || paneRef,
							paneId: resolved.pane.pane_id,
							text: params.text,
							keys: params.keys,
						}),
					};
				}

				case "stop": {
					rejectUnexpectedParams("stop", params, ["workspace", "tab"]);
					const paneRef = params.pane;
					if (!paneRef) throw new Error("'pane' is required for stop");

					const resolved = await requirePaneRef(paneRef, currentWorkspaceId, signal);
					if (resolved.pane.pane_id === currentPaneId) {
						throw new Error("Refusing to close the pane pi is running in.");
					}

					await execHerdr(["pane", "close", resolved.pane.pane_id], signal);
					if (resolved.alias) forgetAlias(resolved.alias);

					return {
						content: [{ type: "text", text: `Closed pane '${resolved.alias || paneRef}'` }],
						details: withSnapshot({
							action: "stop",
							pane: resolved.alias || paneRef,
							paneId: resolved.pane.pane_id,
						}),
					};
				}

				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},

		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

			let text = theme.fg("toolTitle", theme.bold("herdr "));
			text += theme.fg("accent", args.action || "?");
			if (args.workspace) text += theme.fg("muted", ` ${args.workspace}`);
			if (args.tab) text += theme.fg("muted", ` ${args.tab}`);
			if (args.pane) text += theme.fg("muted", ` ${args.pane}`);
			if (Array.isArray(args.panes) && args.panes.length) text += theme.fg("muted", ` ${args.panes.join(",")}`);
			if (args.direction) text += theme.fg("dim", ` › ${args.direction}`);
			if (args.command) text += theme.fg("dim", ` › ${args.command}`);
			if (args.newPane) text += theme.fg("muted", ` ${args.newPane}`);
			if (args.match) text += theme.fg("dim", ` › ${args.match}`);
			if (args.status) text += theme.fg("dim", ` › ${args.status}`);
			if (Array.isArray(args.statuses) && args.statuses.length) text += theme.fg("dim", ` › ${args.statuses.join("|")}`);
			if (args.mode) text += theme.fg("dim", ` ${args.mode}`);
			if (args.text) text += theme.fg("dim", ` › \"${args.text}\"`);
			if (args.keys) text += theme.fg("dim", ` › ${args.keys}`);

			component.setText(text);
			return component;
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const details = result.details as Record<string, any> | undefined;
			const state = context.state as { watchElapsed?: number };
			if (context.args?.action === "watch") {
				if (isPartial) {
					state.watchElapsed = typeof details?.elapsed === "number" ? details.elapsed : 0;
					const pane = details?.pane || context.args?.pane || "?";
					return new Text(
						theme.fg("warning", `◌ watching ${pane}`) + theme.fg("dim", ` (${state.watchElapsed}s)`),
						0,
						0,
					);
				}
				delete state.watchElapsed;
			}
			if (!details) {
				const content = result.content?.[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}

			switch (details.action) {
				case "pane_split": {
					let text = theme.fg("accent", `▥ ${details.newPane || details.newPaneId}`);
					text += theme.fg("dim", ` ‹ ${details.direction} from ${details.pane}`);
					return new Text(text, 0, 0);
				}
				case "run": {
					let text = theme.fg("success", `▶ ${details.pane}`);
					text += theme.fg("dim", ` › ${details.command}`);
					return new Text(text, 0, 0);
				}
				case "read": {
					let text = theme.fg("accent", `📄 ${details.pane}`);
					if (expanded) {
						const content = result.content?.[0];
						if (content?.type === "text") {
							const outputLines = content.text.split("\n").slice(0, 40);
							text += "\n" + outputLines.map((line: string) => theme.fg("dim", line)).join("\n");
						}
					}
					return new Text(text, 0, 0);
				}
				case "watch": {
					let text = theme.fg("success", `✓ ${details.pane}`);
					text += theme.fg("dim", ` › ${details.matchedLine}`);
					if (typeof details.elapsed === "number") text += theme.fg("muted", ` (took ${details.elapsed}s)`);
					return new Text(text, 0, 0);
				}
				case "wait_agent": {
					const panes = Array.isArray(details.panes) && details.panes.length ? details.panes : details.pane ? [details.pane] : [];
					const statuses = Array.isArray(details.statuses) && details.statuses.length
						? details.statuses
						: details.status
							? [details.status]
							: [];
						let text = theme.fg("success", `◎ ${panes.join(", ")}`);
						if (statuses.length) text += theme.fg("dim", ` › ${statuses.join("|")}`);
						if (details.mode) text += theme.fg("muted", ` (${details.mode})`);
						return new Text(text, 0, 0);
				}
				case "send": {
					const desc = [details.text && `"${details.text}"`, details.keys].filter(Boolean).join(" + ");
					return new Text(theme.fg("accent", `⏎ ${details.pane} › ${desc}`), 0, 0);
				}
				case "stop": {
					return new Text(theme.fg("warning", `■ ${details.pane}`), 0, 0);
				}
				case "workspace_create":
				case "workspace_focus": {
					return new Text(theme.fg("accent", `▣ ${details.workspace?.label || details.workspace?.workspace_id}`), 0, 0);
				}
				case "tab_create":
				case "tab_focus": {
					return new Text(theme.fg("accent", `▤ ${details.tab?.label || details.tab?.tab_id}`), 0, 0);
				}
				case "focus": {
					return new Text(theme.fg("accent", `◎ ${details.target}`), 0, 0);
				}
				case "workspace_list": {
					const workspaces = details.workspaces as WorkspaceInfo[];
					if (!workspaces?.length) return new Text(theme.fg("dim", "no workspaces"), 0, 0);
					const lines = workspaces.map((workspace) => {
						const dot = statusDot(theme, workspace.agent_status);
						const label = theme.fg(workspace.focused ? "accent" : "muted", workspace.label || workspace.workspace_id);
						const extra = [workspace.workspace_id, workspace.agent_status !== "unknown" ? workspace.agent_status : null]
							.filter(Boolean)
							.join(" ");
						return `${dot} ${label}${extra ? ` ${theme.fg("dim", extra)}` : ""}`;
					});
					return new Text(lines.join("\n"), 0, 0);
				}
				case "tab_list": {
					const tabs = details.tabs as TabInfo[];
					if (!tabs?.length) return new Text(theme.fg("dim", "no tabs"), 0, 0);
					const lines = tabs.map((tab) => {
						const dot = statusDot(theme, tab.agent_status);
						const label = theme.fg(tab.focused ? "accent" : "muted", tab.label || tab.tab_id);
						const extra = [tab.tab_id, tab.agent_status !== "unknown" ? tab.agent_status : null].filter(Boolean).join(" ");
						return `${dot} ${label}${extra ? ` ${theme.fg("dim", extra)}` : ""}`;
					});
					return new Text(lines.join("\n"), 0, 0);
				}
				case "list": {
					const panes = details.panes as PaneInfo[];
					if (!panes?.length) return new Text(theme.fg("dim", "no panes"), 0, 0);
					const paneAliases = (details.paneAliases || {}) as Record<string, string>;
					const lines = panes.map((pane) => {
						const dot = statusDot(theme, pane.agent_status);
						const label = paneAliases[pane.pane_id]
							? theme.fg("accent", paneAliases[pane.pane_id])
							: theme.fg("muted", pane.pane_id);
						const extra = [pane.agent, pane.agent_status !== "unknown" ? pane.agent_status : null].filter(Boolean).join(" ");
						return `${dot} ${label}${extra ? ` ${theme.fg("dim", extra)}` : ""}`;
					});
					return new Text(lines.join("\n"), 0, 0);
				}
				default: {
					const content = result.content?.[0];
					return new Text(content?.type === "text" ? content.text : "", 0, 0);
				}
			}
		},
	});
}
