/**
 * Spar Peek - Overlay component for viewing spar sessions
 *
 * Renders spar conversations using the same components as pi's interactive mode,
 * so peek looks like "pi inside pi" — same message styling, same tool rendering,
 * same everything.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import {
	SessionManager,
	getMarkdownTheme,
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@mariozechner/pi-coding-agent";
import { getModelAlias } from "./core.js";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
	Container,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type TUI,
} from "@mariozechner/pi-tui";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

// =============================================================================
// Constants
// =============================================================================

const SESSION_DIR = path.join(os.homedir(), ".pi", "agent", "spar", "sessions");

function getSocketPath(sessionId: string): string {
	return `/tmp/pi-spar-${sessionId}.sock`;
}

function getSessionFile(sessionId: string): string {
	return path.join(SESSION_DIR, `${sessionId}.jsonl`);
}

// =============================================================================
// Session Helpers
// =============================================================================

export interface PeekableSession {
	name: string;
	active: boolean;
	messageCount: number;
	model: string;
	lastActivity: number;
}

export function listPeekableSessions(): PeekableSession[] {
	if (!fs.existsSync(SESSION_DIR)) return [];

	const sessions: PeekableSession[] = [];

	for (const f of fs.readdirSync(SESSION_DIR)) {
		if (!f.endsWith(".jsonl")) continue;
		const name = f.replace(".jsonl", "");
		const active = fs.existsSync(getSocketPath(name));

		let messageCount = 0;
		let model = "";
		let lastActivity = 0;

		try {
			const infoPath = path.join(SESSION_DIR, `${name}.info.json`);
			if (fs.existsSync(infoPath)) {
				const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
				messageCount = info.messageCount ?? 0;
				lastActivity = info.lastActivity ?? info.createdAt ?? 0;
				const fullModel = info.model || info.modelId || "";
				model = getModelAlias(fullModel) || fullModel.split(":").pop()?.slice(0, 8) || "?";
			}
		} catch {}

		sessions.push({ name, active, messageCount, model, lastActivity });
	}

	sessions.sort((a, b) => {
		if (a.active !== b.active) return a.active ? -1 : 1;
		return b.lastActivity - a.lastActivity;
	});

	return sessions;
}

export function formatAge(timestamp: number): string {
	if (!timestamp) return "";
	const seconds = Math.floor((Date.now() - timestamp) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

export function sessionExists(name: string): boolean {
	return fs.existsSync(getSessionFile(name));
}

export function isSessionActive(name: string): boolean {
	return fs.existsSync(getSocketPath(name));
}

export function findRecentSession(sessionManager: any): string | null {
	try {
		const entries = sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "message") {
				const msg = (entry as any).message;
				if (msg?.role === "assistant" && Array.isArray(msg.content)) {
					for (const c of msg.content) {
						if (c.type === "toolCall" && c.name === "spar" && c.arguments?.session) {
							return c.arguments.session;
						}
					}
				}
			}
		}
	} catch {}
	return null;
}

export function findActiveSession(): string | null {
	try {
		const sockets = fs.readdirSync("/tmp").filter(f => f.startsWith("pi-spar-") && f.endsWith(".sock"));
		if (sockets.length > 0) {
			return sockets[0].replace("pi-spar-", "").replace(".sock", "");
		}
	} catch {}
	return null;
}

// =============================================================================
// Peek Overlay — "pi inside pi"
//
// Uses the same UserMessageComponent, AssistantMessageComponent, and
// ToolExecutionComponent that pi's interactive mode uses, wrapped in a
// scrollable bordered overlay.
// =============================================================================

export class SparPeekOverlay {
	private tui: TUI;
	private theme: Theme;
	private done: () => void;
	private sessionId: string;
	private sessionFile: string;
	private modelName: string = "";

	// Session state
	private sm: SessionManager | null = null;
	private lastFileSize: number = 0;

	// UI state — the inner chat container holds the real pi components
	private chatContainer: Container;
	private scrollOffset = 0;
	private followMode = true;

	// Streaming state (from socket)
	private socket: net.Socket | null = null;
	private socketBuffer: string = "";
	private status: "thinking" | "streaming" | "tool" | "done" = "done";
	private toolName?: string;

	// Streaming components — mirrors interactive-mode's approach
	private streamingComponent: AssistantMessageComponent | null = null;
	private streamingMessage: AssistantMessage | null = null;
	private pendingTools = new Map<string, ToolExecutionComponent>();

	// Polling
	private pollInterval: ReturnType<typeof setInterval> | null = null;

	// Render cache
	private cachedLines: string[] | null = null;
	private cachedWidth: number | null = null;

	constructor(tui: TUI, theme: Theme, sessionId: string, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.sessionId = sessionId;
		this.sessionFile = getSessionFile(sessionId);
		this.done = done;

		this.chatContainer = new Container();

		this.loadModelName();
		this.loadSession();
		this.rebuildChat();
		this.connectSocket();
		this.pollInterval = setInterval(() => this.poll(), 200);
	}

	// =========================================================================
	// Session loading
	// =========================================================================

	private loadModelName(): void {
		try {
			const infoPath = path.join(SESSION_DIR, `${this.sessionId}.info.json`);
			if (fs.existsSync(infoPath)) {
				const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
				const fullModel = info.model || info.modelId || "";
				this.modelName = getModelAlias(fullModel) || fullModel.split(":").pop()?.slice(0, 12) || "";
			}
		} catch {}
	}

	private loadSession(): void {
		try {
			if (fs.existsSync(this.sessionFile)) {
				this.sm = SessionManager.open(this.sessionFile);
				const stats = fs.statSync(this.sessionFile);
				this.lastFileSize = stats.size;
			}
		} catch {
			this.sm = null;
		}
	}

	// =========================================================================
	// Chat rebuild — uses real pi components
	// =========================================================================

	private rebuildChat(): void {
		this.cachedLines = null;
		this.cachedWidth = null;
		this.chatContainer.clear();
		this.pendingTools.clear();

		if (!this.sm) return;

		const context = this.sm.buildSessionContext();

		for (const message of context.messages) {
			if (message.role === "user") {
				const text = this.getUserText(message);
				if (text) {
					this.chatContainer.addChild(
						new UserMessageComponent(text, getMarkdownTheme()),
					);
				}
			} else if (message.role === "assistant") {
				this.chatContainer.addChild(
					new AssistantMessageComponent(message, false, getMarkdownTheme()),
				);
				// Render tool call components (same pattern as interactive-mode)
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.arguments,
							{},
							undefined, // no custom tool definitions for spar peers
							this.tui,
						);
						this.chatContainer.addChild(component);

						// Handle aborted/error assistant messages — mark tools as failed
						// instead of leaving them pending (same as interactive-mode)
						if (message.stopReason === "aborted" || message.stopReason === "error") {
							const errorMessage = message.errorMessage || (
								message.stopReason === "aborted" ? "Operation aborted" : "Error"
							);
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						} else {
							this.pendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				const component = this.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					this.pendingTools.delete(message.toolCallId);
				}
			}
		}

		this.pendingTools.clear();
	}

	private getUserText(message: any): string {
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c: any) => c.type === "text" && c.text)
				.map((c: any) => c.text)
				.join("\n");
		}
		return "";
	}

	// =========================================================================
	// Socket connection — live streaming from active spar
	// =========================================================================

	private connectSocket(): void {
		const socketPath = getSocketPath(this.sessionId);
		if (!fs.existsSync(socketPath)) return;

		try {
			this.socket = net.connect(socketPath);
			this.socketBuffer = "";
			this.status = "thinking";

			this.socket.on("error", () => {
				this.socket = null;
			});

			this.socket.on("close", () => {
				this.socket = null;
				this.status = "done";
				this.cleanupStreaming();
				this.loadSession();
				this.rebuildChat();
				this.tui.requestRender();
			});

			this.socket.on("data", (data) => {
				this.socketBuffer += data.toString();
				const lines = this.socketBuffer.split("\n");
				// Last element is either empty (if data ended with \n) or an incomplete line
				this.socketBuffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						this.handleEvent(event);
					} catch {}
				}
			});
		} catch {
			this.socket = null;
		}
	}

	private handleEvent(event: any): void {
		if (event.type === "sync") {
			// Sync event on connect — rebuild from file, then apply streaming state
			this.loadSession();
			this.rebuildChat();
			this.status = event.status || "thinking";
			this.toolName = event.toolName;

			// If there's a partial message, use it directly (faithful reconstruction)
			if (event.partialMessage) {
				this.streamingMessage = event.partialMessage;
				this.streamingComponent = new AssistantMessageComponent(
					undefined, false, getMarkdownTheme(),
				);
				this.chatContainer.addChild(this.streamingComponent);
				this.streamingComponent.updateContent(this.streamingMessage);
				// Restore any tool components from the partial message
				this.syncToolComponentsFromMessage();
			} else if (event.thinking || event.text) {
				// Fallback for older core.ts that doesn't send partialMessage
				this.ensureStreamingComponent();
				if (this.streamingMessage) {
					if (event.thinking) {
						this.streamingMessage.content.push({
							type: "thinking", thinking: event.thinking,
						} as any);
					}
					if (event.text) {
						this.streamingMessage.content.push({
							type: "text", text: event.text,
						} as any);
					}
					this.streamingComponent?.updateContent(this.streamingMessage);
				}
			}
		} else if (event.type === "message_start") {
			// New assistant message — create streaming component (same as interactive-mode)
			if (event.message?.role === "assistant") {
				this.cleanupStreaming();
				this.streamingMessage = event.message;
				this.streamingComponent = new AssistantMessageComponent(
					undefined, false, getMarkdownTheme(),
				);
				this.chatContainer.addChild(this.streamingComponent);
				this.streamingComponent.updateContent(this.streamingMessage);
				this.status = "thinking";
			}
		} else if (event.type === "message_update") {
			if (event.message?.role === "assistant") {
				// Use the full partial message from the event — same as interactive-mode
				this.ensureStreamingComponent();
				this.streamingMessage = event.message;
				this.streamingComponent!.updateContent(this.streamingMessage);

				// Update status from the delta type
				const delta = event.assistantMessageEvent;
				if (delta?.type === "thinking_delta") {
					this.status = "thinking";
				} else if (delta?.type === "text_delta") {
					this.status = "streaming";
				}

				// Create/update tool components from the message content
				// (same pattern as interactive-mode lines 2163-2179)
				this.syncToolComponentsFromMessage();
			}
		} else if (event.type === "message_end") {
			if (this.streamingComponent && this.streamingMessage) {
				if (event.message?.role === "assistant") {
					this.streamingMessage = event.message;
					this.streamingComponent.updateContent(this.streamingMessage);

					// Handle aborted/error — mark pending tools as failed
					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						const errorMessage = this.streamingMessage.errorMessage || "Error";
						for (const [, component] of this.pendingTools) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.pendingTools.clear();
					} else {
						// Args are complete — trigger diff computation for edit tools
						for (const [, component] of this.pendingTools) {
							component.setArgsComplete();
						}
					}
				}
				this.streamingComponent = null;
				this.streamingMessage = null;
			}
		} else if (event.type === "tool_execution_start") {
			this.status = "tool";
			this.toolName = event.toolName;
			if (event.toolCallId && !this.pendingTools.has(event.toolCallId)) {
				const component = new ToolExecutionComponent(
					event.toolName, event.args, {}, undefined, this.tui,
				);
				this.chatContainer.addChild(component);
				this.pendingTools.set(event.toolCallId, component);
			}
		} else if (event.type === "tool_execution_update") {
			if (event.toolCallId) {
				const component = this.pendingTools.get(event.toolCallId);
				if (component && event.partialResult) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
				}
			}
		} else if (event.type === "tool_execution_end") {
			if (event.toolCallId) {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError ?? false });
					this.pendingTools.delete(event.toolCallId);
				}
			}
		} else if (event.type === "agent_end") {
			this.cleanupStreaming();
			this.loadSession();
			this.rebuildChat();
			this.status = "done";
		}

		this.invalidateCache();
		if (this.followMode) this.scrollOffset = 999999;
		this.tui.requestRender();
	}

	/**
	 * Walk streamingMessage.content and create/update ToolExecutionComponents
	 * for any tool calls. Same pattern as interactive-mode lines 2163-2179.
	 */
	private syncToolComponentsFromMessage(): void {
		if (!this.streamingMessage) return;
		for (const content of this.streamingMessage.content) {
			if (content.type === "toolCall") {
				if (!this.pendingTools.has(content.id)) {
					const component = new ToolExecutionComponent(
						content.name, content.arguments, {}, undefined, this.tui,
					);
					this.chatContainer.addChild(component);
					this.pendingTools.set(content.id, component);
				} else {
					const component = this.pendingTools.get(content.id)!;
					component.updateArgs(content.arguments);
				}
			}
		}
	}

	// =========================================================================
	// Streaming helpers — mirrors interactive-mode's streaming approach
	// =========================================================================

	private ensureStreamingComponent(): void {
		if (this.streamingComponent) return;

		this.streamingMessage = {
			role: "assistant",
			content: [],
			api: "" as any,
			provider: "" as any,
			model: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop" as any,
			timestamp: Date.now(),
		};
		this.streamingComponent = new AssistantMessageComponent(
			undefined,
			false,
			getMarkdownTheme(),
		);
		this.chatContainer.addChild(this.streamingComponent);
		this.streamingComponent.updateContent(this.streamingMessage);
	}

	private cleanupStreaming(): void {
		if (this.streamingComponent) {
			this.chatContainer.removeChild(this.streamingComponent);
			this.streamingComponent = null;
			this.streamingMessage = null;
		}
		this.pendingTools.clear();
	}

	// =========================================================================
	// Polling
	// =========================================================================

	private poll(): void {
		if (!this.socket && isSessionActive(this.sessionId)) {
			this.connectSocket();
		}

		try {
			const stats = fs.statSync(this.sessionFile);
			if (stats.size !== this.lastFileSize) {
				this.loadSession();
				// Only rebuild if we're not actively streaming
				if (!this.streamingComponent) {
					this.rebuildChat();
				}
				this.invalidateCache();
				if (this.followMode) this.scrollOffset = 999999;
				this.tui.requestRender();
			}
		} catch {}
	}

	// =========================================================================
	// Input handling
	// =========================================================================

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.dispose();
			this.done();
		} else if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.followMode = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.scrollOffset++;
			this.tui.requestRender();
		} else if (matchesKey(data, "pageup") || matchesKey(data, "ctrl+u")) {
			this.followMode = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - 15);
			this.tui.requestRender();
		} else if (matchesKey(data, "pagedown") || matchesKey(data, "ctrl+d")) {
			this.scrollOffset += 15;
			this.tui.requestRender();
		} else if (data === "g") {
			this.followMode = false;
			this.scrollOffset = 0;
			this.tui.requestRender();
		} else if (data === "G") {
			this.followMode = true;
			this.scrollOffset = 999999;
			this.tui.requestRender();
		}
	}

	// =========================================================================
	// Rendering — bordered chrome around the real pi chat container
	// =========================================================================

	private invalidateCache(): void {
		this.cachedLines = null;
		this.cachedWidth = null;
	}

	invalidate(): void {
		this.chatContainer.invalidate();
		this.invalidateCache();
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(20, width - 2);

		// ── Header ──
		const title = ` ${this.sessionId} `;
		const modelTag = this.modelName ? `[${this.modelName}] ` : "";
		const statusIcon = { thinking: "◐", streaming: "●", tool: "◑", done: "✓" }[this.status] || "○";
		const statusColor = { thinking: "warning", streaming: "success", tool: "accent", done: "success" }[this.status] || "muted";
		const statusText = ` ${statusIcon} ${this.status} `;
		const headerContent = title + modelTag;
		const headerPad = Math.max(0, innerW - visibleWidth(headerContent) - visibleWidth(statusText));

		const lines: string[] = [];
		lines.push(
			th.fg("border", "╭") +
			th.fg("accent", title) +
			th.fg("dim", modelTag) +
			th.fg("border", "─".repeat(headerPad)) +
			th.fg(statusColor as any, statusText) +
			th.fg("border", "╮"),
		);

		// ── Content — rendered by the real pi components ──
		let contentLines: string[];
		if (this.cachedLines && this.cachedWidth === innerW) {
			contentLines = this.cachedLines;
		} else {
			contentLines = this.chatContainer.render(innerW);
			this.cachedLines = contentLines;
			this.cachedWidth = innerW;
		}

		// ── Scrolling ──
		const termRows = this.tui.terminal.rows;
		const maxHeight = Math.min(60, termRows - 4);
		const chromeLines = 4; // header + separator + footer + bottom border
		const maxVisible = Math.max(10, maxHeight - chromeLines);
		const maxScroll = Math.max(0, contentLines.length - maxVisible);
		this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

		const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + maxVisible);
		for (const line of visible) {
			const padded = line + " ".repeat(Math.max(0, innerW - visibleWidth(line)));
			lines.push(th.fg("border", "│") + truncateToWidth(padded, innerW) + th.fg("border", "│"));
		}

		// ── Footer ──
		const scrollInfo = contentLines.length > maxVisible
			? `${this.scrollOffset + 1}-${Math.min(this.scrollOffset + maxVisible, contentLines.length)}/${contentLines.length}`
			: `${contentLines.length}L`;
		const followIcon = this.followMode ? th.fg("success", "●") : th.fg("dim", "○");

		lines.push(th.fg("border", "├" + "─".repeat(innerW) + "┤"));
		const footer = ` ${scrollInfo} ${followIcon} │ j/k scroll │ g/G top/end │ q close `;
		const footerPad = " ".repeat(Math.max(0, innerW - visibleWidth(footer)));
		lines.push(th.fg("border", "│") + th.fg("dim", footer) + footerPad + th.fg("border", "│"));
		lines.push(th.fg("border", "╰" + "─".repeat(innerW) + "╯"));

		return lines;
	}

	// =========================================================================
	// Cleanup
	// =========================================================================

	dispose(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
		if (this.socket) {
			this.socket.end();
			this.socket = null;
		}
	}
}
