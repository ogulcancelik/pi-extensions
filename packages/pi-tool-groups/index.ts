import {
	AssistantMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text, type TuiMouseEvent, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Theme = Parameters<NonNullable<ToolRenderers["renderCall"]>>[1];
type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

type Row = {
	id: string;
	toolName: string;
	theme?: Theme;
	selfShell: boolean;
	outputPad: number;
	call?: Component;
	result?: Component;
	hasResult: boolean;
	expanded: boolean;
	isPartial: boolean;
	isError: boolean;
	durationMs?: number;
	invalidate?: () => void;
	view?: Component;
	box?: Box;
	hideCall?: boolean;
	/** Leader output for one width; cleared whenever anything in the group changes. */
	cache?: { width: number; lines: string[] };
};

type Group = { ids: string[] };

const LIST_KEY = "alt+o";
const EMPTY: Component = { render: () => [], invalidate() {} };

const rows = new Map<string, Row>();
let groups = new Map<string, Group>();
let committed: any[] = [];
let streaming: any | undefined;
let streamingSig = "";
let listMode = true;
const openGroups = new Set<string>();
const openCalls = new Set<string>();
const HEADER = "\0header";

function isExport(ctx: ToolRenderContext): boolean {
	return /^\(\)\s*=>\s*\{\s*\}$/.test(String(ctx.invalidate));
}

function computeGroups(messages: any[]): Map<string, Group> {
	const map = new Map<string, Group>();
	let current: Group | undefined;
	for (const message of messages) {
		if (!message) continue;
		if (message.role === "assistant") {
			for (const block of message.content ?? []) {
				if (block.type === "text" && block.text?.trim()) current = undefined;
				else if (block.type === "toolCall") {
					current ??= { ids: [] };
					current.ids.push(block.id);
					map.set(block.id, current);
				}
			}
		} else if (message.role !== "toolResult") {
			current = undefined;
		}
	}
	return map;
}

// Recompute grouping, then refresh only the calls whose group actually changed.
function regroup() {
	const previous = groups;
	groups = computeGroups(streaming ? [...committed, streaming] : committed);
	const keys = new Map<Group, string>();
	const key = (group: Group | undefined) => {
		if (!group) return "";
		let value = keys.get(group);
		if (value === undefined) keys.set(group, (value = group.ids.join(",")));
		return value;
	};
	const changed = new Set<string>();
	for (const [id, group] of groups) if (key(group) !== key(previous.get(id))) changed.add(id);
	for (const id of previous.keys()) if (!groups.has(id)) changed.add(id);
	if (changed.size === 0) return;

	const views = new Set<any>();
	for (const id of changed) {
		const row = rows.get(id);
		if (row) {
			row.cache = undefined;
			row.invalidate?.();
		}
		const view = viewsByCall.get(id)?.deref();
		if (view) views.add(view);
	}
	for (const view of views) view.invalidate();
}

function markDirty(row: Row) {
	row.cache = undefined;
	const leaderId = groups.get(row.id)?.ids[0];
	const leader = leaderId && rows.get(leaderId);
	if (leader) leader.cache = undefined;
}

function rebuild(ctx: ExtensionContext) {
	committed = [];
	streaming = undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message") committed.push(entry.message);
		else if (entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary") {
			committed.push({ role: "break" });
		}
	}
	regroup();
}

// Hidden thinking renders one "Thinking..." line per model step. Inside a tool group, keep only the
// line before the group's first call so a long run reads as one thought, not a stack of them.
const viewsByCall = new Map<string, WeakRef<any>>();
const ORIGINAL = Symbol.for("pi-tool-groups.updateContent");

function foldsThinking(view: any, message: any): boolean {
	if (!view.hideThinkingBlock) return false;
	const content: any[] = message?.content ?? [];
	if (content.some((b) => b.type === "text" && b.text?.trim())) return false;
	const call = content.find((b) => b.type === "toolCall");
	const group = call && groups.get(call.id);
	return !!group && group.ids.length > 1 && group.ids[0] !== call.id;
}

function patchThinking() {
	const proto = AssistantMessageComponent.prototype as any;
	const original = proto[ORIGINAL] ?? proto.updateContent;
	proto[ORIGINAL] = original;
	proto.updateContent = function (this: any, message: any, ...rest: unknown[]) {
		for (const block of message?.content ?? []) {
			if (block.type === "toolCall" && viewsByCall.get(block.id)?.deref() !== this) viewsByCall.set(block.id, new WeakRef(this));
		}
		if (!foldsThinking(this, message)) return original.call(this, message, ...rest);
		const stripped = { ...message, content: message.content.filter((b: any) => b.type !== "thinking") };
		const result = original.call(this, stripped, ...rest);
		this.lastMessage = message;
		return result;
	};
}

function signature(message: any): string {
	return (message?.content ?? [])
		.map((b: any) => (b.type === "toolCall" ? `c${b.id}` : b.type === "text" && b.text?.trim() ? "t" : ""))
		.join(",");
}

const ANSI = /\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function firstLine(row: Row | undefined, width: number): string {
	const lines = row?.call?.render(width) ?? [];
	const line = lines.find((l) => l.replace(ANSI, "").trim());
	if (!line) return row?.toolName ?? "?";
	// Self-framed tools (edit) paint their own background; keep only the text.
	if (row?.selfShell && row.theme) return truncateToWidth(row.theme.fg("toolTitle", line.replace(ANSI, "").trim()), width);
	return truncateToWidth(line.trim(), width);
}

function status(row: Row | undefined, theme: Theme): string {
	if (!row || !row.hasResult || row.isPartial) return theme.fg("muted", "⋯");
	return row.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

const LABELS: Record<string, [string, string]> = {
	read: ["read", "file"],
	grep: ["searched", "pattern"],
	find: ["found", "glob"],
	ls: ["listed", "dir"],
	bash: ["ran", "command"],
	edit: ["edited", "file"],
	write: ["wrote", "file"],
};

function summary(group: Group, theme: Theme): string {
	const counts = new Map<string, number>();
	let failed = 0;
	let ms = 0;
	for (const id of group.ids) {
		const row = rows.get(id);
		const name = row?.toolName ?? "tool";
		counts.set(name, (counts.get(name) ?? 0) + 1);
		if (row?.hasResult && !row.isPartial && row.isError) failed++;
		ms += row?.durationMs ?? 0;
	}
	const parts = [...counts].map(([name, n]) => {
		const label = LABELS[name];
		return label ? `${label[0]} ${n} ${label[1]}${n === 1 ? "" : "s"}` : `${name} ×${n}`;
	});
	let text = theme.fg("toolTitle", parts.join(" · "));
	if (failed) text += theme.fg("error", ` · ${failed} failed`);
	if (ms) text += theme.fg("dim", `  ${(ms / 1000).toFixed(1)}s`);
	return text;
}

function renderFull(row: Row, width: number): string[] {
	if (row.selfShell) return [...(row.call?.render(width) ?? []), ...(row.result?.render(width) ?? [])];
	if (!row.box) {
		const theme = row.theme!;
		row.box = new Box(row.outputPad, 1, (text) =>
			theme.bg(row.isPartial ? "toolPendingBg" : row.isError ? "toolErrorBg" : "toolSuccessBg", text),
		);
		row.box.addChild({ render: (w) => (row.hideCall ? [] : (row.call?.render(w) ?? [])), invalidate: () => row.call?.invalidate?.() });
		row.box.addChild({ render: (w) => row.result?.render(w) ?? [], invalidate: () => row.result?.invalidate?.() });
	}
	row.box.setPaddingX(row.outputPad);
	return row.box.render(width);
}

// Leader view layout: which call (or the summary header) each rendered line belongs to, for clicks.
const layouts = new WeakMap<Row, Array<string | undefined>>();

function renderGroup(row: Row, group: Group, width: number): string[] {
	const theme = row.theme!;
	const pad = " ".repeat(row.outputPad);
	const inner = Math.max(10, width - row.outputPad - 4);
	if (row.cache?.width === width) return row.cache.lines;
	const lines: string[] = [];
	const layout: Array<string | undefined> = [];
	layouts.set(row, layout);
	row.cache = { width, lines };

	const summarized = !listMode && group.ids.length > 1;
	if (summarized) {
		const open = openGroups.has(row.id);
		const hint = theme.fg("dim", open ? "" : `  (${LIST_KEY} to list)`);
		lines.push(truncateToWidth(`${pad}${theme.fg("accent", open ? "▾" : "▸")} ${summary(group, theme)}${hint}`, width));
		layout.push(HEADER);
		if (!open) {
			const running = group.ids.map((id) => rows.get(id)).findLast((r) => r && (!r.hasResult || r.isPartial));
			if (running) {
				lines.push(`${pad}  ${theme.fg("dim", "└")} ${firstLine(running, inner)}`);
				layout.push(HEADER);
			}
			return lines;
		}
	}

	const indent = summarized ? `${pad}  ` : pad;
	for (const id of group.ids) {
		const member = rows.get(id);
		if (member && member !== row && member.expanded) continue; // ctrl+o: the row draws itself in full
		const open = member && (openCalls.has(id) || (member === row && row.expanded));
		const mark = open ? theme.fg("accent", "▾") : status(member, theme);
		lines.push(truncateToWidth(`${indent}${mark} ${firstLine(member, inner)}`, width));
		layout.push(id);
		if (open) {
			// The list line already shows the call; repeat it only when that line had to cut it short.
			member.hideCall = !member.selfShell && member.hasResult && callFits(member, inner);
			const body = renderFull(member, width - indent.length - 2);
			member.hideCall = false;
			for (const line of body) {
				lines.push(`${indent}  ${line}`);
				layout.push(id);
			}
		}
	}
	return lines;
}

function callFits(row: Row, width: number): boolean {
	const lines = (row.call?.render(width) ?? []).filter((l) => l.replace(ANSI, "").trim());
	return lines.length <= 1 && visibleWidth((lines[0] ?? "").trim()) <= width;
}

function clickGroup(row: Row, y: number): boolean {
	const target = layouts.get(row)?.[y];
	if (!target) return false;
	const set = target === HEADER ? openGroups : openCalls;
	const key = target === HEADER ? row.id : target;
	if (set.has(key)) set.delete(key);
	else set.add(key);
	row.cache = undefined;
	row.invalidate?.();
	return true;
}

function renderRow(row: Row, width: number): string[] {
	const group = groups.get(row.id);
	if (!group) return renderFull(row, width);
	if (group.ids[0] === row.id) return row.expanded && group.ids.length === 1 ? renderFull(row, width) : renderGroup(row, group, width);
	return row.expanded ? renderFull(row, width) : [];
}

function touch(ctx: ToolRenderContext, toolName: string, inner: ToolRenderers | undefined, theme: Theme): Row {
	let row = rows.get(ctx.toolCallId);
	if (!row) {
		row = { id: ctx.toolCallId, toolName, selfShell: false, outputPad: 1, hasResult: false, expanded: false, isPartial: true, isError: false };
		rows.set(ctx.toolCallId, row);
	}
	row.theme = theme;
	row.selfShell = inner?.renderShell === "self";
	row.outputPad = ctx.outputPad;
	row.expanded = ctx.expanded;
	row.isPartial = ctx.isPartial;
	row.isError = ctx.isError;
	row.durationMs = ctx.durationMs;
	row.invalidate = ctx.invalidate;
	markDirty(row);
	return row;
}

function fallbackCall(toolName: string, args: unknown, theme: Theme): Component {
	let text = "";
	try {
		text = JSON.stringify(args) ?? "";
	} catch {}
	return new Text(`${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("muted", text.slice(0, 200))}`, 0, 0);
}

function fallbackResult(result: { content: any[] }, expanded: boolean, theme: Theme): Component {
	const text = result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
	const lines = text.split("\n");
	const shown = expanded ? lines : lines.slice(0, 10);
	const more = lines.length - shown.length;
	return new Text(
		shown.map((l) => theme.fg("toolOutput", l)).join("\n") + (more > 0 ? theme.fg("muted", `\n... (${more} more lines)`) : ""),
		0,
		0,
	);
}

export default function (pi: ExtensionAPI) {
	patchThinking();

	pi.registerToolRenderer((toolName, next) => {
		const inner = next();
		return {
			renderShell: "self",
			renderCall(args, theme, ctx) {
				if (isExport(ctx)) return inner?.renderCall?.(args, theme, ctx) ?? fallbackCall(toolName, args, theme);
				const row = touch(ctx, toolName, inner, theme);
				try {
					row.call = inner?.renderCall
						? inner.renderCall(args, theme, { ...ctx, lastComponent: row.call })
						: fallbackCall(toolName, args, theme);
				} catch {
					row.call = fallbackCall(toolName, args, theme);
				}
				row.view ??= {
					render: (w) => renderRow(row, w),
					invalidate: () => {
						row.cache = undefined;
					},
					handleMouse: (event: TuiMouseEvent) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						const group = groups.get(row.id);
						if (!group || group.ids[0] !== row.id) return undefined;
						return clickGroup(row, event.y) ? { handled: true } : undefined;
					},
				} as Component;
				return row.view;
			},
			renderResult(result, options, theme, ctx) {
				if (isExport(ctx)) return inner?.renderResult?.(result, options, theme, ctx) ?? fallbackResult(result, options.expanded, theme);
				const row = touch(ctx, toolName, inner, theme);
				row.hasResult = true;
				try {
					row.result = inner?.renderResult
						? inner.renderResult(result, options, theme, { ...ctx, lastComponent: row.result })
						: fallbackResult(result, options.expanded, theme);
				} catch {
					row.result = fallbackResult(result, options.expanded, theme);
				}
				return EMPTY;
			},
		};
	});

	pi.on("session_start", (_event, ctx) => rebuild(ctx));
	pi.on("session_tree", (_event, ctx) => rebuild(ctx));
	pi.on("session_compact", (_event, ctx) => rebuild(ctx));

	pi.on("message_update", (event) => {
		const sig = signature(event.message);
		streaming = event.message;
		if (sig !== streamingSig) {
			streamingSig = sig;
			regroup();
		}
	});

	pi.on("message_end", (event) => {
		committed.push(event.message);
		streaming = undefined;
		streamingSig = "";
		regroup();
	});

	pi.registerShortcut(LIST_KEY, {
		description: "Toggle tool call list / summary",
		handler: () => {
			listMode = !listMode;
			for (const row of rows.values()) {
				if (groups.get(row.id)?.ids[0] !== row.id) continue;
				row.cache = undefined;
				row.invalidate?.();
			}
		},
	});
}
