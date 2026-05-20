/**
 * Spar Extension - Agent-to-agent sparring
 *
 * Provides a `spar` tool for back-and-forth dialogue with peer AI models,
 * plus /spar and /spview commands for viewing spar sessions.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { Text, Container, Spacer, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	sendMessage,
	listSessions,
	getSession,
	getSessionHistory,
	getConfiguredModelsDescription,
	deleteSession,
	DEFAULT_TIMEOUT,
	DEFAULT_THINKING,
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

export default function (pi: ExtensionAPI) {
	// ==========================================================================
	// Tool Registration — models are configured in ~/.pi/agent/spar/config.json
	// ==========================================================================

	pi.registerTool({
		name: "spar",
		label: "Spar",
		get description() {
			return `Spar with another AI model — a conversation, not a lookup.

Use this only when the user explicitly asks you to spar, or when you are blocked and cannot move forward without another model's opinion.

Do not use this for routine review, simple confirmation, or because a second opinion would merely be nice to have. This should be uncommon.

When you do use it, prefer a different model family when possible.

**Peer limitations:** read files, grep, find, and ls only. No bash, web, network, or file writes.

**Important:**
- if they raise a point you hadn't considered, dig into it. If you disagree, counter it. Don't take the first response and run.
- Give file paths and pointers, not full content.

**This is a back-and-forth discussion tool, not one-shot Q&A.**
If the peer's answer raises side questions, you disagree, or you want to push deeper, reuse the same \`session\` name and call \`send\` again. The conversation persists. Keep the thread going until the point is actually resolved.

**Configured models:**
${getConfiguredModelsDescription()}

**Actions:**
- \`send\` - Send a message to a spar session (creates session if needed)
- \`list\` - List existing spar sessions
- \`history\` - View past exchanges from a session (default: last 5)`;
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
				description: "Model alias (from config) or provider:model. Required for first message in a session.",
			})),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
				description: `Thinking level. Explicit value overrides model config; default is ${DEFAULT_THINKING}.`,
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
						thinking,
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
	// Commands: /spar and /spview
	// ==========================================================================

	pi.registerCommand("spar", {
		description: "Peek at a spar session. Usage: /spar [session-name]",
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
					ctx.ui.notify(`No recent spar. Try: /spar ${available[0].name}`, "info");
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

	pi.registerCommand("spview", {
		description: "Browse spar sessions — view, peek, or delete",
		handler: async (_args, ctx) => {
			const result = await ctx.ui.custom<{ action: "peek"; name: string } | undefined>(
				(tui, theme, _kb, done) => {
					let selectedIndex = 0;
					let cachedLines: string[] | undefined;

					const fg = theme.fg.bind(theme);

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					return {
						render(width: number): string[] {
							if (cachedLines) return cachedLines;

							const sessions = listPeekableSessions();
							if (selectedIndex >= sessions.length) selectedIndex = Math.max(0, sessions.length - 1);

							const lines: string[] = [];

							lines.push(fg("accent", "─".repeat(width)));
							lines.push(fg("accent", theme.bold(" Spar Sessions")) + fg("dim", ` (${sessions.length})`));
							lines.push("");

							if (sessions.length === 0) {
								lines.push(fg("dim", "  No spar sessions found"));
							} else {
								// Table header
								const header = [
									"name".padEnd(30),
									"model".padEnd(8),
									"msgs".padStart(5),
									"age".padStart(6),
								].join(" ");
								lines.push(fg("dim", `    ${header}`));

								// Paginated viewport — show PAGE_SIZE rows around selection
								const PAGE_SIZE = 15;
								let viewStart = 0;
								if (sessions.length > PAGE_SIZE) {
									// Keep selection centered in viewport
									viewStart = Math.max(0, Math.min(
										selectedIndex - Math.floor(PAGE_SIZE / 2),
										sessions.length - PAGE_SIZE,
									));
								}
								const viewEnd = Math.min(viewStart + PAGE_SIZE, sessions.length);

								if (viewStart > 0) {
									lines.push(fg("dim", `    ↑ ${viewStart} more`));
								}

								for (let i = viewStart; i < viewEnd; i++) {
									const s = sessions[i];
									const isSelected = i === selectedIndex;
									const prefix = isSelected ? fg("accent", "→ ") : "  ";
									const icon = s.active ? fg("success", "●") : fg("dim", "○");

									const row = [
										s.name.slice(0, 30).padEnd(30),
										(s.model || "—").padEnd(8),
										String(s.messageCount || 0).padStart(5),
										(s.lastActivity ? formatAge(s.lastActivity) : "—").padStart(6),
									].join(" ");

									const color = isSelected ? "accent" : s.active ? "text" : "muted";
									lines.push(truncateToWidth(`${prefix}${icon} ${fg(color, row)}`, width));
								}

								if (viewEnd < sessions.length) {
									lines.push(fg("dim", `    ↓ ${sessions.length - viewEnd} more`));
								}
							}

							lines.push("");

							// Contextual help
							const helpParts = ["↑↓ navigate"];
							if (sessions.length > 0) {
								helpParts.push("enter peek");
								helpParts.push("d delete");
								helpParts.push("D delete all");
							}
							helpParts.push("esc close");
							lines.push(fg("dim", ` ${helpParts.join(" · ")}`));

							lines.push(fg("accent", "─".repeat(width)));

							cachedLines = lines;
							return lines;
						},

						handleInput(data: string): void {
							const sessions = listPeekableSessions();

							if (matchesKey(data, "escape") || data === "q") {
								done(undefined);
								return;
							}
							if (matchesKey(data, "up") || data === "k") {
								selectedIndex = selectedIndex <= 0 ? sessions.length - 1 : selectedIndex - 1;
								refresh();
								return;
							}
							if (matchesKey(data, "down") || data === "j") {
								selectedIndex = selectedIndex >= sessions.length - 1 ? 0 : selectedIndex + 1;
								refresh();
								return;
							}
							if (matchesKey(data, "return")) {
								if (sessions.length > 0 && sessions[selectedIndex]) {
									done({ action: "peek", name: sessions[selectedIndex].name });
								}
								return;
							}
							if (data === "d") {
								if (sessions.length > 0 && sessions[selectedIndex]) {
									deleteSession(sessions[selectedIndex].name);
									refresh();
								}
								return;
							}
							if (data === "D") {
								for (const s of sessions) {
									if (!s.active) deleteSession(s.name);
								}
								refresh();
								return;
							}
						},

						invalidate(): void {
							cachedLines = undefined;
						},
					};
				},
			);

			// Open peek if selected
			if (result?.action === "peek") {
				await ctx.ui.custom<void>(
					(tui, theme, _kb, done) => new SparPeekOverlay(tui, theme, result.name, done),
					{
						overlay: true,
						overlayOptions: {
							anchor: "right-center",
							width: "45%",
							minWidth: 50,
							maxHeight: 60,
							margin: { right: 2, top: 2, bottom: 2 },
						},
					},
				);
			}
		},
	});
}
