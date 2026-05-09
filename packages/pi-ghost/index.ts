import {
	AssistantMessageComponent,
	createAgentSession,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Input, Key, matchesKey, truncateToWidth, visibleWidth, type Focusable, type KeybindingsManager, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";

const OSC133_PROMPT_MARKER_RE = /\x1b\]133;[ABC]\x07/g;

function stripPromptMarkers(lines: string[]): string[] {
	return lines.map((line) => line.replace(OSC133_PROMPT_MARKER_RE, ""));
}

class GhostOverlayComponent implements Focusable {
	private readonly transcriptContainer = new Container();
	private readonly input = new Input();
	private readonly tui: TUI;
	private readonly theme: ExtensionCommandContext["ui"]["theme"];
	private readonly sessionCwd: string;
	private readonly modelLabel: string;
	private readonly onSubmitMessage: (text: string) => void;
	private readonly onHideOverlay: () => void;
	private readonly onCloseOverlay: () => void;
	private streamingComponent?: AssistantMessageComponent;
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private statusText = "Ask something quick.";
	private scrollOffset = Number.MAX_SAFE_INTEGER;
	private followMode = true;
	private cachedTranscriptLines?: string[];
	private cachedTranscriptWidth?: number;
	private lastInnerWidth = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		theme: ExtensionCommandContext["ui"]["theme"],
		keybindings: KeybindingsManager,
		sessionCwd: string,
		modelLabel: string,
		onSubmitMessage: (text: string) => void,
		onHideOverlay: () => void,
		onCloseOverlay: () => void,
	) {
		void keybindings;
		this.tui = tui;
		this.theme = theme;
		this.sessionCwd = sessionCwd;
		this.modelLabel = modelLabel;
		this.onSubmitMessage = onSubmitMessage;
		this.onHideOverlay = onHideOverlay;
		this.onCloseOverlay = onCloseOverlay;

		this.input.onSubmit = (value) => {
			const text = value.trim();
			if (!text) return;
			this.input.setValue("");
			this.scrollToBottom();
			this.onSubmitMessage(text);
		};
		this.input.onEscape = () => {
			this.onCloseOverlay();
		};
	}

	private invalidateTranscriptCache(): void {
		this.cachedTranscriptLines = undefined;
		this.cachedTranscriptWidth = undefined;
	}

	private scrollToBottom(): void {
		this.followMode = true;
		this.scrollOffset = Number.MAX_SAFE_INTEGER;
	}

	private getOverlayHeight(): number {
		return Math.max(14, Math.min(Math.floor(this.tui.terminal.rows * 0.55), this.tui.terminal.rows - 2));
	}

	private getFallbackInnerWidth(): number {
		return Math.max(20, Math.floor(this.tui.terminal.columns * 0.85) - 2);
	}

	private getTranscriptLines(width: number): string[] {
		if (this.cachedTranscriptLines && this.cachedTranscriptWidth === width) {
			return this.cachedTranscriptLines;
		}

		const lines = stripPromptMarkers(this.transcriptContainer.render(width));
		this.cachedTranscriptLines = lines;
		this.cachedTranscriptWidth = width;
		return lines;
	}

	private getCurrentMaxScroll(): number {
		const innerWidth = this.lastInnerWidth || this.getFallbackInnerWidth();
		const inputLines = this.input.render(innerWidth);
		const totalHeight = this.getOverlayHeight();
		const chromeRows = 5 + inputLines.length;
		const viewportRows = Math.max(4, totalHeight - chromeRows);
		const transcriptLines = this.getTranscriptLines(innerWidth);
		return Math.max(0, transcriptLines.length - viewportRows);
	}

	setStatus(text: string): void {
		this.statusText = text;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("s"))) {
			this.onHideOverlay();
			return;
		}

		if (matchesKey(data, Key.up)) {
			const maxScroll = this.getCurrentMaxScroll();
			this.followMode = false;
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll) - 1);
			if (this.scrollOffset >= maxScroll) this.scrollOffset = Math.max(0, maxScroll - 1);
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.down)) {
			const maxScroll = this.getCurrentMaxScroll();
			if (this.followMode) {
				this.scrollToBottom();
			} else {
				this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
				if (this.scrollOffset >= maxScroll) this.scrollToBottom();
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.pageUp)) {
			const maxScroll = this.getCurrentMaxScroll();
			this.followMode = false;
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll) - 10);
			if (this.scrollOffset >= maxScroll) this.scrollOffset = Math.max(0, maxScroll - 10);
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.pageDown)) {
			const maxScroll = this.getCurrentMaxScroll();
			if (this.followMode) {
				this.scrollToBottom();
			} else {
				this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 10);
				if (this.scrollOffset >= maxScroll) this.scrollToBottom();
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.home)) {
			this.followMode = false;
			this.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.end)) {
			this.scrollToBottom();
			this.tui.requestRender();
			return;
		}

		this.input.handleInput(data);
		this.tui.requestRender();
	}

	handleSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start": {
				if (event.message.role === "user") {
					const text = extractMessageText(event.message);
					this.transcriptContainer.addChild(new UserMessageComponent(text, getMarkdownTheme()));
					this.setStatus("Thinking...");
					break;
				}

				if (event.message.role === "assistant") {
					this.streamingComponent = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
					this.transcriptContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(event.message);
					this.setStatus("Streaming response...");
				}
				break;
			}

			case "message_update": {
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingComponent.updateContent(event.message);
				}
				break;
			}

			case "message_end": {
				if (event.message.role !== "assistant") break;
				if (this.streamingComponent) {
					this.streamingComponent.updateContent(event.message);

					if (event.message.stopReason === "aborted" || event.message.stopReason === "error") {
						const errorMessage = event.message.errorMessage || "Error";
						for (const component of this.pendingTools.values()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.pendingTools.clear();
					} else {
						for (const component of this.pendingTools.values()) {
							component.setArgsComplete();
						}
					}
					this.streamingComponent = undefined;
				}
				this.setStatus("Ask something quick.");
				break;
			}

			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						{ showImages: true },
						undefined,
						this.tui,
						this.sessionCwd,
					);
					this.transcriptContainer.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				this.setStatus(`Running ${event.toolName}...`);
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
				}
				break;
			}

			case "agent_end": {
				this.streamingComponent = undefined;
				this.pendingTools.clear();
				this.setStatus("Ask something quick.");
				break;
			}
		}

		this.invalidateTranscriptCache();
		if (this.followMode) this.scrollToBottom();
		this.tui.requestRender();
	}

	invalidate(): void {
		this.transcriptContainer.invalidate();
		this.input.invalidate();
		this.invalidateTranscriptCache();
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(20, width - 2);
		const totalHeight = this.getOverlayHeight();
		const inputLines = this.input.render(innerW);
		const chromeRows = 5 + inputLines.length;
		const viewportRows = Math.max(4, totalHeight - chromeRows);
		const transcriptLines = this.getTranscriptLines(innerW);
		const maxScroll = Math.max(0, transcriptLines.length - viewportRows);

		this.lastInnerWidth = innerW;

		if (this.followMode) {
			this.scrollOffset = maxScroll;
		} else {
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
			if (this.scrollOffset >= maxScroll) this.scrollToBottom();
		}

		const visibleTranscript = transcriptLines.slice(this.scrollOffset, this.scrollOffset + viewportRows);
		const scrollInfo = transcriptLines.length > viewportRows
			? `${this.scrollOffset + 1}-${Math.min(this.scrollOffset + viewportRows, transcriptLines.length)}/${transcriptLines.length}`
			: `${transcriptLines.length}L`;
		const followIcon = this.followMode ? th.fg("success", "●") : th.fg("dim", "○");
		const footer = truncateToWidth(
			`${th.fg("dim", this.statusText)} ${th.fg("border", "│")} ${th.fg("accent", this.modelLabel)} ${th.fg("border", "│")} ${th.fg("dim", formatGhostCwd(this.sessionCwd))} ${th.fg("border", "│")} ${th.fg("dim", scrollInfo)} ${followIcon}`,
			innerW,
		);
		const headerContent = truncateToWidth(
			th.fg("accent", ` ${th.bold("ghost pi")} `) + th.fg("dim", "same model • ephemeral session • ↑↓ scroll • ctrl+s hide • esc close"),
			innerW,
		);
		const headerPad = Math.max(0, innerW - visibleWidth(headerContent));
		const lines: string[] = [];

		lines.push(
			th.fg("border", "╭") +
			headerContent +
			th.fg("border", "─".repeat(headerPad)) +
			th.fg("border", "╮"),
		);
		lines.push(th.fg("border", "├" + "─".repeat(innerW) + "┤"));

		for (const line of visibleTranscript) {
			const padded = line + " ".repeat(Math.max(0, innerW - visibleWidth(line)));
			lines.push(th.fg("border", "│") + padded + th.fg("border", "│"));
		}
		for (let i = visibleTranscript.length; i < viewportRows; i++) {
			lines.push(th.fg("border", "│") + " ".repeat(innerW) + th.fg("border", "│"));
		}

		lines.push(th.fg("border", "├" + "─".repeat(innerW) + "┤"));
		lines.push(th.fg("border", "│") + footer + " ".repeat(Math.max(0, innerW - visibleWidth(footer))) + th.fg("border", "│"));
		for (const line of inputLines) {
			const padded = line + " ".repeat(Math.max(0, innerW - visibleWidth(line)));
			lines.push(th.fg("border", "│") + padded + th.fg("border", "│"));
		}
		lines.push(th.fg("border", "╰" + "─".repeat(innerW) + "╯"));

		return lines;
	}
}

function extractMessageText(message: { content: string | Array<{ type: string; text?: string }> }): string {
	if (typeof message.content === "string") return message.content.trim();

	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function formatGhostCwd(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}` || "~";
	}
	return cwd;
}

export default function (pi: ExtensionAPI) {
	let ghostSession: AgentSession | null = null;
	let ghostSessionCwd: string | null = null;
	let ghostModelLabel: string | null = null;
	let overlayHandle: OverlayHandle | null = null;
	let overlayClosed = false;

	const cleanupGhost = (ctx?: ExtensionCommandContext) => {
		overlayClosed = true;
		if (overlayHandle) {
			try {
				overlayHandle.hide();
			} catch {
				// ignore
			}
			overlayHandle = null;
		}
		if (ghostSession) {
			ghostSession.dispose();
			ghostSession = null;
		}
		ghostSessionCwd = null;
		ghostModelLabel = null;
		ctx?.ui.setWidget("pi-ghost", undefined);
	};

	const setHiddenState = (ctx: ExtensionCommandContext, hidden: boolean) => {
		if (!overlayHandle) return;
		overlayHandle.setHidden(hidden);
		if (hidden) {
			overlayHandle.unfocus();
			ctx.ui.setWidget(
				"pi-ghost",
				(_tui, theme) => ({
					render: () => [theme.fg("accent", "/gpi ") + theme.fg("dim", "is running • run /gpi to bring it back")],
					invalidate: () => {},
				}),
				{ placement: "aboveEditor" },
			);
		} else {
			ctx.ui.setWidget("pi-ghost", undefined);
			overlayHandle.focus();
		}
	};

	const ensureGhostSession = async (ctx: ExtensionCommandContext): Promise<AgentSession> => {
		if (ghostSession) return ghostSession;
		if (!ctx.model) throw new Error("No model selected");

		const result = await createAgentSession({
			cwd: ctx.cwd,
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			sessionManager: SessionManager.inMemory(ctx.cwd),
		});
		ghostSession = result.session;
		ghostSessionCwd = ctx.cwd;
		ghostModelLabel = ctx.model.id;
		return ghostSession;
	};

	const openGhostOverlay = async (ctx: ExtensionCommandContext, initialPrompt?: string) => {
		const session = await ensureGhostSession(ctx);
		overlayClosed = false;

		void ctx.ui
			.custom<void>(
				(tui, theme, keybindings, done) => {
					const overlay = new GhostOverlayComponent(
						tui,
						theme,
						keybindings,
						ghostSessionCwd ?? ctx.cwd,
						ghostModelLabel ?? ctx.model?.id ?? "unknown-model",
						(text) => {
							void session.prompt(text, { images: [] });
						},
						() => {
							setHiddenState(ctx, true);
						},
						() => {
							done();
						},
					);

					const unsubscribe = session.subscribe((event) => {
						overlay.handleSessionEvent(event);
					});

					if (initialPrompt?.trim()) {
						void session.prompt(initialPrompt.trim(), { images: [] });
					}

					return {
						render: (width: number) => overlay.render(width),
						invalidate: () => overlay.invalidate(),
						handleInput: (data: string) => overlay.handleInput(data),
						get focused() {
							return overlay.focused;
						},
						set focused(value: boolean) {
							overlay.focused = value;
						},
						dispose: () => {
							unsubscribe();
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "bottom-center",
						width: "85%",
						maxHeight: "55%",
						margin: { bottom: 1, left: 2, right: 2 },
					},
					onHandle: (handle) => {
						overlayHandle = handle;
					},
				},
			)
			.finally(() => {
				overlayHandle = null;
				if (!overlayClosed) {
					cleanupGhost(ctx);
				}
			});
	};

	pi.registerCommand("gpi", {
		description: "Open ghost pi overlay",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/gpi requires interactive mode", "error");
				return;
			}

			const prompt = args.trim();

			if (overlayHandle) {
				if (overlayHandle.isHidden()) {
					setHiddenState(ctx, false);
				}
				if (prompt) {
					const session = await ensureGhostSession(ctx);
					void session.prompt(prompt, { images: [] });
				}
				return;
			}

			await openGhostOverlay(ctx, prompt || undefined);
		},
	});


	pi.on("session_shutdown", async (_event, ctx) => {
		cleanupGhost(ctx as ExtensionCommandContext);
	});
}
