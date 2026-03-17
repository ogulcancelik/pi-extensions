/**
 * Spar Extension - Agent-to-agent sparring
 * 
 * Provides a `spar` tool for back-and-forth dialogue with peer AI models,
 * plus /peek and /peek-all commands for viewing spar sessions.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Text, Container, Spacer, SelectList, Input, matchesKey, type SelectItem, type SelectListTheme } from "@mariozechner/pi-tui";
import {
	sendMessage,
	listSessions,
	getSession,
	getSessionHistory,
	getConfiguredModelsDescription,
	loadSparConfig,
	saveSparConfig,
	type SparModelConfig,
	DEFAULT_TIMEOUT,
} from "./core.js";
import {
	SparPeekOverlay,
	listPeekableSessions,
	sessionExists,
	isSessionActive,
	findRecentSession,
	findActiveSession,
	formatAge,
} from "./peek.js";

/** Suggest a short alias for a provider/model combo */
function suggestAlias(provider: string, modelId: string): string {
	const id = modelId.toLowerCase();
	if (id.includes("opus")) return "opus";
	if (id.includes("sonnet")) return "sonnet";
	if (id.includes("haiku")) return "haiku";
	if (id.includes("gpt-5")) return "gpt5";
	if (id.includes("gpt-4")) return "gpt4";
	if (id.includes("o3")) return "o3";
	if (id.includes("o4")) return "o4";
	if (id.includes("gemini")) return "gemini";
	if (id.includes("deepseek")) return "deepseek";
	// Fallback: first meaningful chunk of model id
	return id.replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").slice(0, 12);
}

export default function (pi: ExtensionAPI) {
	// ==========================================================================
	// Tool Registration
	// ==========================================================================

	pi.registerTool({
		name: "spar",
		label: "Spar",
		get description() {
			const modelsDesc = getConfiguredModelsDescription();
			return `Spar with another AI model — this is a **conversation**, not a lookup.

Use for debugging, design, architecture review, or challenging your own thinking.
Sessions persist, so follow up, push back, disagree. If they raise a point you hadn't
considered, dig into it. If you disagree with something, counter it. Don't just take the
first response and run — that's querying, not sparring.

**Peer limitations:** The peer can ONLY explore the codebase: read files, grep, find, ls.
No bash, no web access, no network, no file writes. Don't ask them to look things up online
or run commands — they can't. Give them file paths and let them dig through code.

**Model selection:** Prefer sparring with a different model family than yourself.
Different architectures have different biases and blindspots — that's the value.

**Configured models:**
${modelsDesc}

**Actions:**
- \`send\` - Send a message to a spar session (creates session if needed)
- \`list\` - List existing spar sessions
- \`history\` - View past exchanges from a session (default: last 5)

**Tips:**
- Give file paths and pointers, not full content — let them explore
- Ask for ranked hypotheses, not just "what do you think"
- Request critique: "What's the strongest case against my approach?"
- State your current position so they have something to push against

**Multi-party facilitation:** For big design questions, create multiple specialized sessions
with different models/roles. Name them \`{topic}-{role}\` (e.g., \`auth-design\`, \`auth-security\`).
Give each a focused persona in the first message. Then facilitate: forward interesting points
between them, let them argue through you, decide who to ask next based on the conversation.
You're the switchboard operator — each expert is in their own room, you relay selectively.

**Example:**
\`\`\`
spar({
  action: "send",
  session: "flow-field-debug",
  model: "opus",
  message: "I'm debugging flow field pathfinding. Enemies walk away from player instead of toward. Check scripts/HordeManagerCS.cs line 358-430 for the BFS implementation. I think the gradient is inverted in the BFS neighbor loop — what do you see?"
})
// ... read their response, then follow up:
spar({
  action: "send",
  session: "flow-field-debug",
  message: "Interesting point about the cost function, but I don't think that's it because the distances look correct in the debug output. What about the direction vector calculation at line 415?"
})
\`\`\``;
		},

		parameters: Type.Object({
			action: StringEnum(["send", "list", "history"] as const, {
				description: "Action to perform",
			}),
			session: Type.Optional(Type.String({
				description: "Session name (required for send/history). Use descriptive names like 'flow-field-debug'.",
			})),
			message: Type.Optional(Type.String({
				description: "Message to send (required for send)",
			})),
			model: Type.Optional(Type.String({
				description: "Model alias (from /spar-models) or provider:model. Required for first message in a session.",
			})),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high"] as const, {
				description: "Thinking level (default: high)",
			})),
			timeout: Type.Optional(Type.Number({
				description: `Timeout in ms (default: ${DEFAULT_TIMEOUT / 60000} min). Resets on activity.`,
			})),
			count: Type.Optional(Type.Number({
				description: "Number of exchanges to show (for history action, default: 5)",
			})),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { action, session, message, model, thinking, timeout, count } = params as {
				action: "send" | "list" | "history";
				session?: string;
				message?: string;
				model?: string;
				thinking?: string;
				timeout?: number;
				count?: number;
			};

			// Handle list action
			if (action === "list") {
				const sessions = listSessions();
				
				if (sessions.length === 0) {
					return {
						content: [{ type: "text", text: "No spar sessions found." }],
						details: { sessions: [] },
					};
				}

				const lines = ["Sessions:", ""];
				for (const s of sessions) {
					const age = formatAge(s.lastActivity);
					const modelDisplay = s.modelAlias || s.model.split(":").pop() || s.model;
					const status = s.status === "failed" ? " ❌" : "";
					lines.push(`  ${s.name.padEnd(24)} ${modelDisplay.padEnd(8)} ${String(s.messageCount).padStart(3)} msgs   ${age}${status}`);
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { sessions },
				};
			}

			// Handle history action
			if (action === "history") {
				if (!session) {
					return {
						content: [{ type: "text", text: "Error: session name is required for history action." }],
						details: { error: "missing_session" },
						isError: true,
					};
				}

				const info = getSession(session);
				if (!info) {
					return {
						content: [{ type: "text", text: `Error: session "${session}" not found.` }],
						details: { error: "session_not_found" },
						isError: true,
					};
				}

				const exchanges = getSessionHistory(session, count ?? 5);
				
				if (exchanges.length === 0) {
					return {
						content: [{ type: "text", text: `No exchanges in session "${session}" yet.` }],
						details: { session, exchanges: [] },
					};
				}

				const lines: string[] = [];
				lines.push(`Session: ${session} (${info.modelId})`);
				lines.push(`Showing last ${exchanges.length} exchange(s):\n`);
				
				for (let i = 0; i < exchanges.length; i++) {
					const ex = exchanges[i];
					lines.push(`--- Exchange ${i + 1} ---`);
					lines.push(`You: ${ex.user}`);
					lines.push(`${info.modelId}: ${ex.assistant}`);
					lines.push("");
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { session, exchanges, modelId: info.modelId },
				};
			}

			// Handle send action
			if (action === "send") {
				// Validate required params
				if (!session) {
					return {
						content: [{ type: "text", text: "Error: session name is required for send action." }],
						details: { error: "missing_session" },
						isError: true,
					};
				}

				if (!message) {
					return {
						content: [{ type: "text", text: "Error: message is required for send action." }],
						details: { error: "missing_message" },
						isError: true,
					};
				}

				// Check if session exists and if model is required
				const existingSession = getSession(session);
				if (!existingSession && !model) {
					return {
						content: [{ type: "text", text: `Error: session "${session}" doesn't exist. Provide a model to create it.` }],
						details: { error: "session_not_found" },
						isError: true,
					};
				}

				// Setup progress tracking
				const modelName = model || existingSession?.modelId || "agent";
				const startTime = Date.now();

				// Stream initial progress
				onUpdate?.({
					content: [{ type: "text", text: `Consulting ${modelName}...` }],
					details: { status: "starting", progress: { status: "thinking", elapsed: 0, model: modelName } },
				});

				try {
					const result = await sendMessage(session, message, {
						model,
						thinking: thinking ?? "high",
						timeout: timeout ?? DEFAULT_TIMEOUT,
						signal,
						onProgress: (progress) => {
							const elapsed = Math.floor((Date.now() - startTime) / 1000);
							onUpdate?.({
								content: [{ type: "text", text: `${progress.status}...` }],
								details: { 
									progress: { 
										status: progress.status, 
										elapsed,
										toolName: progress.toolName,
										model: modelName,
									} 
								},
							});
						},
					});

					// Format usage info
					let usageText = "";
					if (result.usage) {
						usageText = `\n\n---\n_${result.usage.input} in / ${result.usage.output} out, $${result.usage.cost.toFixed(4)}_`;
					}

					return {
						content: [{ type: "text", text: result.response + usageText }],
						details: { 
							session,
							message,  // Store original message for expanded view
							model: model || existingSession?.model,
							usage: result.usage,
						},
					};
				} catch (err: any) {
					return {
						content: [{ type: "text", text: `Spar failed: ${err.message}` }],
						details: { error: err.message, session },
						isError: true,
					};
				}
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${action}` }],
				details: { error: "unknown_action" },
				isError: true,
			};
		},

		// Custom rendering for cleaner display
		renderCall(args: any, theme: Theme) {
			const { action, session, model, count } = args;
			
			if (action === "list") {
				return new Text(theme.fg("toolTitle", theme.bold("spar ")) + theme.fg("muted", "list"), 0, 0);
			}
			
			if (action === "history") {
				let text = theme.fg("toolTitle", theme.bold("spar "));
				text += theme.fg("accent", session || "?");
				text += theme.fg("dim", ` (history${count ? `, last ${count}` : ""})`);
				return new Text(text, 0, 0);
			}
			
			// For send action, show session + model (question shown in expanded result)
			let text = theme.fg("toolTitle", theme.bold("spar "));
			text += theme.fg("accent", session || "?");
			if (model) {
				text += theme.fg("dim", ` (${model})`);
			}
			
			return new Text(text, 0, 0);
		},

		renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: Theme) {
			const { expanded, isPartial } = options;
			const details = result.details || {};
			
			// Handle streaming/partial state
			if (isPartial) {
				const progress = details.progress || {};
				const status = progress.status || details.status || "working";
				const elapsed = progress.elapsed || 0;
				const toolName = progress.toolName;
				
				let statusText = status;
				if (status === "tool" && toolName) {
					statusText = `→ ${toolName}`;
				}
				
				return new Text(theme.fg("warning", `● ${statusText}`) + theme.fg("dim", ` (${elapsed}s)`), 0, 0);
			}
			
			// Handle errors
			if (result.isError || details.error) {
				return new Text(theme.fg("error", `✗ ${details.error || "Failed"}`), 0, 0);
			}
			
			// Handle list action
			if (details.sessions !== undefined) {
				const count = details.sessions.length;
				if (count === 0) {
					return new Text(theme.fg("dim", "No sessions"), 0, 0);
				}
				if (!expanded) {
					return new Text(theme.fg("success", `✓ ${count} session${count > 1 ? "s" : ""}`), 0, 0);
				}
				// Expanded: show full list
				const text = result.content?.[0]?.text || "";
				return new Text(text, 0, 0);
			}
			
			// Handle history action
			if (details.exchanges !== undefined) {
				const exchanges = details.exchanges as Array<{ user: string; assistant: string }>;
				const count = exchanges.length;
				const modelId = details.modelId || "assistant";
				
				if (count === 0) {
					return new Text(theme.fg("dim", "No exchanges yet"), 0, 0);
				}
				
				if (!expanded) {
					// Collapsed: show summary like read tool
					return new Text(
						theme.fg("success", `✓ ${count} exchange${count > 1 ? "s" : ""}`) + 
						theme.fg("dim", " (ctrl+o to expand)"), 
						0, 0
					);
				}
				
				// Expanded: show full history from details (not truncated content)
				const lines: string[] = [];
				lines.push(theme.fg("accent", `Session: ${details.session}`) + theme.fg("dim", ` (${modelId})`));
				lines.push("");
				
				for (let i = 0; i < exchanges.length; i++) {
					const ex = exchanges[i];
					lines.push(theme.fg("muted", `--- Exchange ${i + 1} ---`));
					lines.push(theme.fg("dim", "You: ") + ex.user);
					lines.push(theme.fg("dim", `${modelId}: `) + ex.assistant);
					lines.push("");
				}
				
				return new Text(lines.join("\n"), 0, 0);
			}
			
			// Handle send action - show response
			const responseText = result.content?.[0]?.text || "";
			const usage = details.usage;
			
			if (!expanded) {
				// Collapsed: just show success + cost (response hidden until expanded)
				let text = theme.fg("success", "✓");
				if (usage) {
					text += theme.fg("dim", ` [${usage.input} in / ${usage.output} out, $${usage.cost.toFixed(4)}]`);
				}
				return new Text(text, 0, 0);
			}
			
			// Expanded: show question + full response
			let text = "";
			
			// Show the original question
			if (details.message) {
				text += theme.fg("muted", "Q: ") + details.message + "\n\n";
			}
			
			// Show response
			let response = responseText;
			// Remove the usage line we added (it's in details now)
			response = response.replace(/\n\n---\n_.*_$/, "");
			text += theme.fg("muted", "A: ") + response;
			
			if (usage) {
				text += "\n\n" + theme.fg("dim", `[${usage.input} in / ${usage.output} out, $${usage.cost.toFixed(4)}]`);
			}
			return new Text(text, 0, 0);
		},
	});

	// ==========================================================================
	// Command: /spar-models — configure available sparring models
	// ==========================================================================

	pi.registerCommand("spar-models", {
		description: "Configure models available for sparring",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive mode required for /spar-models", "warning");
				return;
			}

			const available = ctx.modelRegistry.getAvailable();
			if (available.length === 0) {
				ctx.ui.notify("No models available. Configure API keys first.", "warning");
				return;
			}

			const config = loadSparConfig();
			const configuredAliases = new Map(config.models.map(m => [`${m.provider}/${m.id}`, m.alias]));

			// Build items: configured models marked, unconfigured available
			const items: SelectItem[] = available.map(m => {
				const key = `${m.provider}/${m.id}`;
				const alias = configuredAliases.get(key);
				return {
					value: key,
					label: alias ? `${key} (${alias})` : key,
					description: alias ? "configured" : undefined,
				};
			});

			const result = await ctx.ui.custom<{ action: "add" | "remove"; model: string } | undefined>(
				(tui, theme, _kb, done) => {
					const selectTheme: SelectListTheme = {
						selectedPrefix: (t: string) => theme.fg("accent", t),
						selectedText: (t: string) => theme.fg("accent", t),
						description: (t: string) => theme.fg("success", t),
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					};

					const container = new Container();
					container.addChild(new Text(
						theme.bold(theme.fg("accent", "Spar Models")) +
						theme.fg("muted", "  (enter to add/edit alias, backspace to remove)"),
						0, 0,
					));
					container.addChild(new Spacer(1));

					// Show current config
					if (config.models.length > 0) {
						const configText = config.models
							.map(m => theme.fg("dim", "  ") + theme.fg("accent", m.alias) + theme.fg("dim", ` → ${m.provider}/${m.id}`))
							.join("\n");
						container.addChild(new Text(theme.fg("muted", "  Current:") + "\n" + configText, 0, 0));
						container.addChild(new Spacer(1));
					}

					const input = new Input();
					container.addChild(input);
					container.addChild(new Spacer(1));

					let list = buildList(items);
					container.addChild(list);
					container.addChild(new Spacer(1));
					container.addChild(new Text(
						theme.fg("dim", "  ↑/↓ navigate · type to filter · enter add/edit · backspace remove · esc close"),
						0, 0,
					));

					function buildList(filtered: SelectItem[]): SelectList {
						const sl = new SelectList(filtered, Math.min(filtered.length, 12), selectTheme);
						sl.onSelect = (item) => done({ action: "add", model: item.value });
						sl.onCancel = () => done(undefined);
						return sl;
					}

					function rebuildList() {
						const query = input.getValue();
						const filtered = query
							? items.filter(i => i.label.toLowerCase().includes(query.toLowerCase()))
							: items;
						container.removeChild(list);
						list = buildList(filtered);
						// Insert after the spacer that follows input
						const children = container.children;
						const inputIdx = children.indexOf(input);
						children.splice(inputIdx + 2, 0, list);
						tui.requestRender();
					}

					input.onSubmit = () => {
						const selected = list.getSelectedItem();
						if (selected) done({ action: "add", model: selected.value });
					};
					input.onEscape = () => done(undefined);

					container.handleInput = (data: string) => {
						if (data === "\x1b[A" || data === "\x1b[B" || data === "\r" || data === "\n") {
							list.handleInput(data);
						} else if (data === "\x1b" || data === "\x03") {
							done(undefined);
						} else if (data === "\x7f" || data === "\b") {
							// Backspace: if input empty, remove selected model's config
							if (input.getValue() === "") {
								const selected = list.getSelectedItem();
								if (selected && configuredAliases.has(selected.value)) {
									done({ action: "remove", model: selected.value });
								}
							} else {
								input.handleInput(data);
								rebuildList();
							}
						} else {
							input.handleInput(data);
							rebuildList();
						}
					};

					return container;
				},
			);

			if (!result) return;

			if (result.action === "remove") {
				const [provider, ...idParts] = result.model.split("/");
				const id = idParts.join("/");
				config.models = config.models.filter(m => !(m.provider === provider && m.id === id));
				saveSparConfig(config);
				ctx.ui.notify(`Removed ${result.model} from spar models`, "info");
				return;
			}

			// action === "add" — prompt for alias
			const [provider, ...idParts] = result.model.split("/");
			const id = idParts.join("/");

			// Check if already configured
			const existing = config.models.find(m => m.provider === provider && m.id === id);
			const defaultAlias = existing?.alias || suggestAlias(provider, id);

			const alias = await ctx.ui.input(
				`Alias for ${result.model}:`,
				defaultAlias,
			);

			if (!alias?.trim()) return;

			const cleanAlias = alias.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
			if (!cleanAlias) {
				ctx.ui.notify("Invalid alias — use letters, numbers, hyphens, underscores", "error");
				return;
			}

			// Remove any existing entry for this model or alias
			config.models = config.models.filter(m =>
				!(m.provider === provider && m.id === id) && m.alias !== cleanAlias
			);
			config.models.push({ alias: cleanAlias, provider, id });
			saveSparConfig(config);
			ctx.ui.notify(`Configured ${cleanAlias} → ${result.model}`, "info");
		},
	});

	// ==========================================================================
	// Commands: /peek and /peek-all
	// ==========================================================================

	pi.registerCommand("peek", {
		description: "Peek at a spar session. Usage: /peek [session-name]",
		getArgumentCompletions: (prefix: string) => {
			const sessions = listPeekableSessions();
			const items = sessions.map((s) => ({
				value: s.name,
				label: s.active ? `${s.name} (active)` : s.name,
			}));
			return prefix ? items.filter((i) => i.value.startsWith(prefix)) : items;
		},
		handler: async (args, ctx) => {
			let sessionId = args?.trim();

			// If no session specified, find the last spar tool call
			if (!sessionId) {
				sessionId = findRecentSession(ctx.sessionManager) ?? undefined;
			}

			// Still no session? Check for active socket
			if (!sessionId) {
				sessionId = findActiveSession() ?? undefined;
			}

			if (!sessionId) {
				const available = listPeekableSessions();
				if (available.length > 0) {
					ctx.ui.notify(`No recent spar. Try: /peek ${available[0].name}`, "info");
				} else {
					ctx.ui.notify("No spar sessions found", "info");
				}
				return;
			}

			if (!sessionExists(sessionId) && !isSessionActive(sessionId)) {
				ctx.ui.notify(`Session "${sessionId}" not found`, "error");
				return;
			}

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new SparPeekOverlay(tui, theme, sessionId!, done),
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: "45%",
						minWidth: 50,
						maxHeight: 60,
						margin: { right: 2, top: 2, bottom: 2 },
					},
				}
			);
		},
	});

	pi.registerCommand("peek-all", {
		description: "List all spar sessions and pick one to peek",
		handler: async (_args, ctx) => {
			const sessions = listPeekableSessions();

			if (sessions.length === 0) {
				ctx.ui.notify("No spar sessions found", "info");
				return;
			}

			// Use custom component with SelectList for proper filtering/pagination
			const selected = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const items: SelectItem[] = sessions.map((s) => {
					const status = s.active ? "●" : "○";
					const model = s.model ? `[${s.model}]` : "";
					const age = s.lastActivity ? formatAge(s.lastActivity) : "";
					const msgs = s.messageCount > 0 ? `${s.messageCount}msg` : "";
					// Format: "● session-name [gpt5] 3msg 2h"
					const desc = [model, msgs, age].filter(Boolean).join(" ");
					return {
						value: s.name,
						label: `${status} ${s.name}`,
						description: desc,
					};
				});

				const selectList = new SelectList(items, 15, {
					selectedPrefix: (t: string) => theme.bg("selectedBg", theme.fg("accent", t)),
					selectedText: (t: string) => theme.bg("selectedBg", t),
					description: (t: string) => theme.fg("muted", t),
					scrollInfo: (t: string) => theme.fg("dim", t),
					noMatch: (t: string) => theme.fg("warning", t),
				});

				selectList.onSelect = (item) => done(item.value);
				selectList.onCancel = () => done(null);

				// Wrapper with filter display
				let filter = "";
				const filterText = new Text("", 0, 0);
				
				const updateFilterDisplay = () => {
					if (filter) {
						filterText.text = theme.fg("dim", "Filter: ") + theme.fg("accent", filter) + theme.fg("dim", "▏");
					} else {
						filterText.text = theme.fg("dim", "Type to filter...");
					}
				};
				updateFilterDisplay();

				const container = new Container();
				container.addChild(new Text(theme.fg("accent", "Spar Sessions") + theme.fg("dim", " (↑↓ navigate, enter select, esc cancel)"), 0, 1));
				container.addChild(filterText);
				container.addChild(selectList);

				(container as any).handleInput = (data: string) => {
					if (matchesKey(data, "escape")) {
						done(null);
					} else if (matchesKey(data, "return")) {
						selectList.handleInput(data);
					} else if (matchesKey(data, "up") || matchesKey(data, "down")) {
						selectList.handleInput(data);
						tui.requestRender();
					} else if (matchesKey(data, "backspace")) {
						filter = filter.slice(0, -1);
						selectList.setFilter(filter);
						updateFilterDisplay();
						tui.requestRender();
					} else if (data.length === 1 && data >= " ") {
						filter += data;
						selectList.setFilter(filter);
						updateFilterDisplay();
						tui.requestRender();
					}
				};

				return container;
			});

			if (!selected) return;

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new SparPeekOverlay(tui, theme, selected, done),
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: "45%",
						minWidth: 50,
						maxHeight: 60,
						margin: { right: 2, top: 2, bottom: 2 },
					},
				}
			);
		},
	});
}

