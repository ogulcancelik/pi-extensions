/**
 * Goal Extension — Autonomous goal pursuit with sub-agent workers
 *
 * Provides a `goal` tool that lets the facilitator agent:
 *   - Create structured goals with task breakdowns
 *   - Spawn isolated worker agents per task (in parallel)
 *   - Track progress via files on disk (survives compaction/restart)
 *   - Stay grounded via system prompt injection of active goal state
 *
 * UI layers (information hierarchy):
 *   Status line  → "is there an active goal?"
 *   Widget       → "what's happening right now?" (running tasks only)
 *   /goal-view   → "full state + deep inspection" (list + detail overlay)
 *   Tool result  → "what changed because of this command?"
 *
 * File layout:
 *   .pi/goals/ACTIVE              — slug of active goal
 *   .pi/goals/<slug>/GOAL.md      — goal description
 *   .pi/goals/<slug>/STATE.json   — machine-readable state
 *   .pi/goals/<slug>/LEARNINGS.md — cross-task knowledge
 *   .pi/goals/<slug>/tasks/NN-<name>.md   — task specs
 *   .pi/goals/<slug>/results/NN.md        — worker results
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, matchesKey, type SelectItem, SelectList } from "@mariozechner/pi-tui";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

interface TaskState {
	id: string;
	name: string; // slug (filesystem-safe)
	title: string; // human-readable display title
	status: "pending" | "in-progress" | "done" | "failed";
	file: string;
	resultFile?: string;
	summary?: string;
	durationSeconds?: number;
	cost?: number;
	tokens?: { input: number; output: number };
	turns?: number;
}

interface GoalState {
	name: string;
	slug: string;
	description: string;
	created: string;
	status: "active" | "completed" | "paused";
	workerModel?: string;
	tasks: TaskState[];
}

interface WorkerResult {
	taskId: string;
	taskName: string;
	exitCode: number;
	output: string;
	stderr: string;
	usage: { input: number; output: number; cost: number; turns: number };
	model?: string;
	durationSeconds?: number;
}

interface RunningTask {
	id: string;
	name: string;
	title: string;
	items: DisplayItem[];
	startedAt: number;
}

interface GoalDetails {
	action: string;
	goalSlug?: string;
	state?: GoalState;
	results?: WorkerResult[];
	runningTasks?: RunningTask[];
}

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

// ─────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_MAX_WORKERS = 4;

// ─────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────

let spinnerInterval: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;
let goalWidgetExpanded = true; // expanded by default during runs
let lastExtCtx: any = null;
let overlayTui: { requestRender: () => void } | null = null;

// Active run data — shared between actionRun, widget, and overlay
let activeRunData: {
	runningTasks: Map<string, RunningTask>;
	results: WorkerResult[];
} | null = null;

// ─────────────────────────────────────────────────────
// File helpers
// ─────────────────────────────────────────────────────

function goalsDir(cwd: string) {
	return path.join(cwd, ".pi", "goals");
}
function activeFile(cwd: string) {
	return path.join(goalsDir(cwd), "ACTIVE");
}
function goalDir(cwd: string, slug: string) {
	return path.join(goalsDir(cwd), slug);
}

function getActiveSlug(cwd: string): string | null {
	try {
		const content = fs.readFileSync(activeFile(cwd), "utf-8").trim();
		return content || null;
	} catch {
		return null;
	}
}

function setActiveSlug(cwd: string, slug: string | null) {
	fs.mkdirSync(goalsDir(cwd), { recursive: true });
	fs.writeFileSync(activeFile(cwd), slug || "");
}

function readState(cwd: string, slug: string): GoalState | null {
	try {
		const state = JSON.parse(fs.readFileSync(path.join(goalDir(cwd, slug), "STATE.json"), "utf-8"));
		// Backward compat: ensure title exists on all tasks
		for (const task of state.tasks) {
			if (!task.title) task.title = task.name;
		}
		return state;
	} catch {
		return null;
	}
}

function writeState(cwd: string, slug: string, state: GoalState) {
	fs.writeFileSync(path.join(goalDir(cwd, slug), "STATE.json"), JSON.stringify(state, null, 2));
}

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 50);
}

function nextTaskId(tasks: TaskState[]): string {
	const maxId = tasks.reduce((max, t) => Math.max(max, parseInt(t.id, 10) || 0), 0);
	return String(maxId + 1).padStart(2, "0");
}

function readTaskSpec(cwd: string, slug: string, taskFile: string): string {
	try {
		return fs.readFileSync(path.join(goalDir(cwd, slug), taskFile), "utf-8");
	} catch {
		return "";
	}
}

function readResultFile(cwd: string, slug: string, resultFile: string): string {
	try {
		return fs.readFileSync(path.join(goalDir(cwd, slug), resultFile), "utf-8");
	} catch {
		return "";
	}
}

// ─────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	const sec = s % 60;
	return m > 0 ? `${m}m${String(sec).padStart(2, "0")}s` : `${sec}s`;
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const m = Math.floor(seconds / 60);
	const s = Math.round(seconds % 60);
	return `${m}m${String(s).padStart(2, "0")}s`;
}

function taskDisplayTitle(task: TaskState): string {
	return task.title || task.name;
}

// ─────────────────────────────────────────────────────
// Shared rendering helpers
// ─────────────────────────────────────────────────────

function formatToolCall(name: string, args: Record<string, any>, fg: (c: string, t: string) => string): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return typeof p === "string" && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (name) {
		case "bash":
			return fg("muted", "$ ") + fg("toolOutput", String(args.command || "...").slice(0, 60));
		case "read":
			return fg("muted", "read ") + fg("accent", shortenPath(String(args.path || args.file_path || "...")));
		case "write":
			return fg("muted", "write ") + fg("accent", shortenPath(String(args.path || args.file_path || "...")));
		case "edit":
			return fg("muted", "edit ") + fg("accent", shortenPath(String(args.path || args.file_path || "...")));
		case "grep":
			return fg("muted", "grep ") + fg("accent", `/${args.pattern || ""}/`);
		case "find":
			return fg("muted", "find ") + fg("accent", String(args.pattern || "*"));
		case "ls":
			return fg("muted", "ls ") + fg("accent", shortenPath(String(args.path || ".")));
		default:
			return fg("accent", name) + fg("dim", ` ${JSON.stringify(args).slice(0, 50)}`);
	}
}

/** Render a single task row (used by widget, overlay, tool result) */
function renderTaskRow(
	task: TaskState,
	rt: RunningTask | undefined,
	fg: (c: string, t: string) => string,
	opts?: { selected?: boolean; showActivity?: boolean },
): string[] {
	const lines: string[] = [];
	const prefix = opts?.selected ? "▸ " : "  ";

	// Icon
	const icon =
		task.status === "done"
			? fg("success", "✓")
			: task.status === "failed"
				? fg("error", "✗")
				: rt
					? fg("warning", SPINNER[spinnerFrame % SPINNER.length])
					: fg("dim", "○");

	// Main line: icon + title + metrics
	let line = `${prefix}${icon} ${fg("accent", `${task.id} ${taskDisplayTitle(task)}`)}`;

	if (rt) {
		line += fg("dim", `  ${formatElapsed(Date.now() - rt.startedAt)}`);
	} else if (task.status === "done" || task.status === "failed") {
		if (task.durationSeconds) line += fg("dim", `  ${formatDuration(task.durationSeconds)}`);
		if (task.cost && task.cost > 0) line += fg("dim", `  $${task.cost.toFixed(3)}`);
	}

	// Summary for completed tasks
	if (!rt && task.summary) {
		line += fg("muted", ` — ${task.summary.slice(0, 80)}`);
	}

	lines.push(line);

	// Activity line for running tasks
	if (opts?.showActivity && rt && rt.items.length > 0) {
		const lastToolCall = [...rt.items].reverse().find((i) => i.type === "toolCall");
		if (lastToolCall && lastToolCall.type === "toolCall") {
			lines.push(`    ${fg("muted", "→ ")}${formatToolCall(lastToolCall.name, lastToolCall.args, fg)}`);
		}
	}

	return lines;
}

// ─────────────────────────────────────────────────────
// Goal context for system prompt injection
// ─────────────────────────────────────────────────────

function buildGoalContext(cwd: string): string | null {
	const slug = getActiveSlug(cwd);
	if (!slug) return null;
	const state = readState(cwd, slug);
	if (!state || state.status !== "active") return null;

	const done = state.tasks.filter((t) => t.status === "done").length;
	const failed = state.tasks.filter((t) => t.status === "failed").length;
	const total = state.tasks.length;

	const lines: string[] = [];
	lines.push(`\n## Active Goal: ${state.name}`);
	lines.push(state.description);
	lines.push(`\nProgress: ${done}/${total} tasks done${failed > 0 ? ` (${failed} failed)` : ""}`);

	for (const task of state.tasks) {
		const icon =
			task.status === "done" ? "✓" : task.status === "failed" ? "✗" : task.status === "in-progress" ? "⏳" : "○";
		let line = `  ${icon} ${task.id}-${task.name}: ${task.status}`;
		if (task.summary) line += ` — ${task.summary}`;
		lines.push(line);
	}

	lines.push(`\nGoal files: .pi/goals/${slug}/`);
	lines.push("Use the `goal` tool to manage tasks and run workers.");
	lines.push("The goal files on disk are your external memory — trust them over conversation history.");

	const learningsPath = path.join(goalDir(cwd, slug), "LEARNINGS.md");
	try {
		const learnings = fs.readFileSync(learningsPath, "utf-8").trim();
		if (learnings) {
			lines.push("\nKey learnings so far:");
			const truncated = learnings.length > 800 ? "..." + learnings.slice(-800) : learnings;
			lines.push(truncated);
		}
	} catch {}

	return lines.join("\n");
}

// ─────────────────────────────────────────────────────
// Status line
// ─────────────────────────────────────────────────────

function updateStatusLine(ctx: any, cwd: string) {
	if (!ctx.hasUI) return;
	const slug = getActiveSlug(cwd);
	if (!slug) {
		ctx.ui.setStatus("goal", undefined);
		return;
	}
	const state = readState(cwd, slug);
	if (!state || state.status !== "active") {
		ctx.ui.setStatus("goal", undefined);
		return;
	}
	const done = state.tasks.filter((t: TaskState) => t.status === "done").length;
	const inProgress = state.tasks.filter((t: TaskState) => t.status === "in-progress").length;
	const failed = state.tasks.filter((t: TaskState) => t.status === "failed").length;
	const total = state.tasks.length;
	let status = `🎯 ${state.name}: ${done}/${total}`;
	if (inProgress > 0) status += ` · ${inProgress} running`;
	if (failed > 0) status += ` · ${failed} failed`;
	ctx.ui.setStatus("goal", status);
}

// ─────────────────────────────────────────────────────
// Widget — compact, running-tasks focused
// ─────────────────────────────────────────────────────

function updateGoalWidget(ctx: any, cwd: string) {
	if (!ctx.hasUI) return;
	lastExtCtx = ctx;

	const slug = getActiveSlug(cwd);
	if (!slug) {
		ctx.ui.setWidget("goal", undefined);
		return;
	}

	const isRunning = activeRunData !== null && activeRunData.runningTasks.size > 0;

	// Show widget when: active run, or explicitly expanded
	if (!isRunning && !goalWidgetExpanded) {
		ctx.ui.setWidget("goal", undefined);
		return;
	}

	ctx.ui.setWidget("goal", (_tui: any, theme: any) => {
		const width = process.stdout.columns || 120;
		const state = readState(cwd, slug);
		if (!state) return new Text("", 0, 0);

		const lines: string[] = [];
		const fg = theme.fg.bind(theme);

		const doneCount = state.tasks.filter((t: TaskState) => t.status === "done").length;
		const failedCount = state.tasks.filter((t: TaskState) => t.status === "failed").length;
		const pendingCount = state.tasks.filter((t: TaskState) => t.status === "pending").length;
		const total = state.tasks.length;
		const runningCount = activeRunData?.runningTasks.size ?? 0;

		// ── Header ──
		const label = `🎯 ${state.name}`;
		const statParts = [`${doneCount}/${total} done`];
		if (runningCount > 0) statParts.push(`${runningCount} running`);
		if (failedCount > 0) statParts.push(`${failedCount} failed`);
		const statsStr = statParts.join(" · ");
		const hint = goalWidgetExpanded ? " ctrl+x collapse" : " ctrl+x expand";
		const fillLen = Math.max(0, width - 3 - 1 - label.length - 1 - statsStr.length - 2 - hint.length);

		lines.push(
			truncateToWidth(
				fg("borderMuted", "───") +
					fg("accent", ` ${label} `) +
					fg("dim", statsStr) +
					fg("borderMuted", " " + "─".repeat(fillLen)) +
					fg("dim", hint),
				width,
			),
		);

		if (!goalWidgetExpanded) {
			return new Text(lines.join("\n"), 0, 0);
		}

		// ── Running tasks (always shown) ──
		if (activeRunData) {
			for (const task of state.tasks) {
				const rt = activeRunData.runningTasks.get(task.id);
				if (!rt) continue;
				for (const row of renderTaskRow(task, rt, fg, { showActivity: true })) {
					lines.push(truncateToWidth(row, width));
				}
			}
		}

		// ── Recent completions from this run (last 3) ──
		if (activeRunData && activeRunData.results.length > 0) {
			const recent = activeRunData.results.slice(-3);
			for (const r of recent) {
				const task = state.tasks.find((t: TaskState) => t.id === r.taskId);
				if (!task) continue;
				for (const row of renderTaskRow(task, undefined, fg)) {
					lines.push(truncateToWidth(row, width));
				}
			}
		}

		// ── Pending count (not individual rows) ──
		if (pendingCount > 0 && activeRunData) {
			lines.push(fg("dim", `  … ${pendingCount} pending`));
		}

		// ── Static view (no active run, user toggled widget) ──
		if (!activeRunData) {
			for (const task of state.tasks) {
				for (const row of renderTaskRow(task, undefined, fg)) {
					lines.push(truncateToWidth(row, width));
				}
			}
		}

		return new Text(lines.join("\n"), 0, 0);
	});
}

// ─────────────────────────────────────────────────────
// Worker spawning
// ─────────────────────────────────────────────────────

const WORKER_SYSTEM_PROMPT = `You are a focused implementation worker. Your job is to implement ONE specific task.

Instructions:
1. Read your task file FIRST — it has everything: what to do, key files, constraints, acceptance criteria
2. Read the learnings file for cross-task context
3. Start implementing immediately — don't explore the codebase broadly
4. Only read additional files if the task file doesn't give enough context
5. Focus ONLY on your assigned task — don't modify files outside scope

When you're done, provide a brief summary with:
- What you did (1-2 sentences)
- Files changed (list)
- Learnings for future tasks (bullet points of things you discovered)`;

function writeWorkerPrompt(): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-worker-"));
	const filePath = path.join(tmpDir, "worker-prompt.md");
	fs.writeFileSync(filePath, WORKER_SYSTEM_PROMPT, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

async function runWorker(
	cwd: string,
	taskFilePath: string,
	learningsFilePath: string,
	goalFilePath: string,
	model: string | undefined,
	sessionDir: string | undefined,
	signal: AbortSignal | undefined,
	onProgress: (messages: Message[], running: boolean) => void,
): Promise<{ exitCode: number; messages: Message[]; stderr: string; usage: WorkerResult["usage"]; model?: string }> {
	const args: string[] = ["--mode", "json", "-p"];
	args.push("--tools", "read,edit,write,grep,find,ls");

	if (sessionDir) {
		fs.mkdirSync(sessionDir, { recursive: true });
		args.push("--session-dir", sessionDir);
	} else {
		args.push("--no-session");
	}

	if (model) args.push("--model", model);

	const prompt = writeWorkerPrompt();
	args.push("--append-system-prompt", prompt.filePath);

	const taskPrompt = [
		`Implement the task described in: ${taskFilePath}`,
		`Cross-task learnings: ${learningsFilePath}`,
		`Goal overview: ${goalFilePath}`,
		"",
		"Read your task file first, then implement it.",
	].join("\n");
	args.push(taskPrompt);

	const messages: Message[] = [];
	let stderr = "";
	const usage = { input: 0, output: 0, cost: 0, turns: 0 };
	let workerModel: string | undefined;

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					messages.push(msg);
					if (msg.role === "assistant") {
						usage.turns++;
						const u = msg.usage;
						if (u) {
							usage.input += u.input || 0;
							usage.output += u.output || 0;
							usage.cost += u.cost?.total || 0;
						}
						if (!workerModel && msg.model) workerModel = msg.model;
					}
					onProgress(messages, true);
				}

				if (event.type === "tool_result_end" && event.message) {
					messages.push(event.message as Message);
					onProgress(messages, true);
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: Buffer) => {
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				onProgress(messages, false);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (signal) {
				const killProc = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		return { exitCode, messages, stderr, usage, model: workerModel };
	} finally {
		try {
			fs.unlinkSync(prompt.filePath);
		} catch {}
		try {
			fs.rmdirSync(prompt.dir);
		} catch {}
	}
}

// ─────────────────────────────────────────────────────
// Tool actions
// ─────────────────────────────────────────────────────

function actionCreate(
	cwd: string,
	name: string,
	description: string,
	workerModel?: string,
): { content: string; details: GoalDetails } {
	const slug = slugify(name);
	const dir = goalDir(cwd, slug);

	if (fs.existsSync(dir)) {
		return {
			content: `Goal "${slug}" already exists. Use goal status to check it, or choose a different name.`,
			details: { action: "create", goalSlug: slug },
		};
	}

	fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
	fs.mkdirSync(path.join(dir, "results"), { recursive: true });
	fs.writeFileSync(path.join(dir, "GOAL.md"), `# ${name}\n\n${description}\n`);
	fs.writeFileSync(path.join(dir, "LEARNINGS.md"), "");

	const state: GoalState = {
		name,
		slug,
		description,
		created: new Date().toISOString(),
		status: "active",
		workerModel,
		tasks: [],
	};
	writeState(cwd, slug, state);
	setActiveSlug(cwd, slug);

	return {
		content: [
			`Created goal: ${name}`,
			`Directory: .pi/goals/${slug}/`,
			"",
			"Next: use goal add_task to add tasks, then goal run to execute them.",
			"Write rich task docs with specific file paths, constraints, and acceptance criteria.",
			"Workers will read these docs and implement directly — good task docs = fast workers.",
		].join("\n"),
		details: { action: "create", goalSlug: slug, state },
	};
}

function actionAddTask(
	cwd: string,
	taskName: string,
	content: string,
): { content: string; details: GoalDetails } {
	const slug = getActiveSlug(cwd);
	if (!slug) {
		return {
			content: "No active goal. Create one first with goal create.",
			details: { action: "add_task" },
		};
	}

	const state = readState(cwd, slug);
	if (!state) {
		return {
			content: `Goal state not found for "${slug}".`,
			details: { action: "add_task", goalSlug: slug },
		};
	}

	const id = nextTaskId(state.tasks);
	const taskSlug = slugify(taskName);
	const fileName = `${id}-${taskSlug}.md`;
	const filePath = path.join(goalDir(cwd, slug), "tasks", fileName);

	fs.writeFileSync(filePath, content);

	// Extract first meaningful line as preview
	const firstLine = content
		.split("\n")
		.map((l) => l.replace(/^#+\s*/, "").trim())
		.find((l) => l.length > 0);

	state.tasks.push({
		id,
		name: taskSlug,
		title: taskName,
		status: "pending",
		file: `tasks/${fileName}`,
	});
	writeState(cwd, slug, state);

	const preview = firstLine ? `\n  "${firstLine.slice(0, 100)}"` : "";

	return {
		content: `Added task ${id} "${taskName}" to goal "${state.name}".${preview}`,
		details: { action: "add_task", goalSlug: slug, state },
	};
}

async function actionRun(
	cwd: string,
	model: string | undefined,
	maxWorkers: number,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: { content: any[]; details: GoalDetails }) => void) | undefined,
	ctx: any,
): Promise<{ content: string; details: GoalDetails; isError?: boolean }> {
	const slug = getActiveSlug(cwd);
	if (!slug) {
		return { content: "No active goal. Create one first.", details: { action: "run" } };
	}

	let currentState = readState(cwd, slug);
	if (!currentState) {
		return { content: `Goal state not found for "${slug}".`, details: { action: "run", goalSlug: slug } };
	}

	// Recover orphaned in-progress tasks (from crashed/cancelled runs)
	let hadOrphans = false;
	for (const task of currentState.tasks) {
		if (task.status === "in-progress") {
			task.status = "pending";
			hadOrphans = true;
		}
	}
	if (hadOrphans) writeState(cwd, slug, currentState);

	const pendingTasks = currentState.tasks.filter((t) => t.status === "pending");
	if (pendingTasks.length === 0) {
		return { content: "No pending tasks to run.", details: { action: "run", goalSlug: slug, state: currentState } };
	}

	const workerModel = currentState.workerModel || model;
	const results: WorkerResult[] = [];
	const runningTasks = new Map<string, RunningTask>();
	const gDir = goalDir(cwd, slug);

	// Set up shared run data for widget + overlay
	activeRunData = { runningTasks, results };

	const emitUpdate = () => {
		updateGoalWidget(ctx, cwd);
		updateStatusLine(ctx, cwd);
		overlayTui?.requestRender();
		onUpdate?.({
			content: [{ type: "text", text: "Working..." }],
			details: {
				action: "run",
				goalSlug: slug,
				state: currentState!,
				results: [...results],
				runningTasks: [...runningTasks.values()],
			},
		});
	};

	// Start spinner for elapsed time animation
	if (ctx.hasUI) {
		spinnerInterval = setInterval(() => {
			spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
			if (runningTasks.size > 0) emitUpdate();
		}, 1000);
	}

	const processTask = async (taskId: string, taskName: string, taskTitle: string, taskFile: string) => {
		const startedAt = Date.now();

		// Mark in-progress (synchronous read-modify-write)
		currentState = readState(cwd, slug)!;
		const taskToStart = currentState.tasks.find((t) => t.id === taskId);
		if (!taskToStart || taskToStart.status !== "pending") return;
		taskToStart.status = "in-progress";
		writeState(cwd, slug, currentState);

		runningTasks.set(taskId, { id: taskId, name: taskName, title: taskTitle, items: [], startedAt });
		emitUpdate();

		const taskFilePath = path.join(gDir, taskFile);
		const learningsPath = path.join(gDir, "LEARNINGS.md");
		const goalPath = path.join(gDir, "GOAL.md");
		const workerSessionDir = path.join(gDir, "sessions", `${taskId}-${taskName}`);

		const workerResult = await runWorker(
			cwd,
			taskFilePath,
			learningsPath,
			goalPath,
			workerModel,
			workerSessionDir,
			signal,
			(messages, running) => {
				const items = getDisplayItems(messages);
				const rt = runningTasks.get(taskId);
				if (rt) rt.items = items;
				if (!running) runningTasks.delete(taskId);
				emitUpdate();
			},
		);

		const durationSeconds = (Date.now() - startedAt) / 1000;
		const wasCancelled = signal?.aborted;
		const output = getFinalOutput(workerResult.messages);
		const isError = !wasCancelled && workerResult.exitCode !== 0;

		// Cancelled tasks go back to pending
		if (wasCancelled) {
			currentState = readState(cwd, slug)!;
			const cancelledTask = currentState.tasks.find((t) => t.id === taskId);
			if (cancelledTask) {
				cancelledTask.status = "pending";
				writeState(cwd, slug, currentState);
			}
			runningTasks.delete(taskId);
			return;
		}

		// Write result file
		const resultPath = path.join(gDir, "results", `${taskId}.md`);
		fs.writeFileSync(
			resultPath,
			[
				`# Result: ${taskId}-${taskName}`,
				"",
				`Status: ${isError ? "failed" : "done"}`,
				`Exit code: ${workerResult.exitCode}`,
				`Duration: ${formatDuration(durationSeconds)}`,
				"",
				"## Output",
				output || "(no output)",
				workerResult.stderr ? `\n## Stderr\n${workerResult.stderr.slice(-1000)}` : "",
			].join("\n"),
		);

		// Update task state with persisted metrics
		currentState = readState(cwd, slug)!;
		const completedTask = currentState.tasks.find((t) => t.id === taskId);
		if (completedTask) {
			completedTask.status = isError ? "failed" : "done";
			completedTask.resultFile = `results/${taskId}.md`;
			completedTask.summary = output.split("\n")[0]?.slice(0, 120) || (isError ? "failed" : "done");
			completedTask.durationSeconds = durationSeconds;
			completedTask.cost = workerResult.usage.cost;
			completedTask.tokens = { input: workerResult.usage.input, output: workerResult.usage.output };
			completedTask.turns = workerResult.usage.turns;
			writeState(cwd, slug, currentState);
		}

		// Auto-append learnings
		if (!isError && output) {
			const learningsMatch = output.match(/## ?Learnings?\s*\n([\s\S]*?)(?=\n## |\n# |$)/i);
			if (learningsMatch) {
				const newLearnings = learningsMatch[1].trim();
				if (newLearnings) {
					const existing = fs.readFileSync(path.join(gDir, "LEARNINGS.md"), "utf-8");
					fs.writeFileSync(
						path.join(gDir, "LEARNINGS.md"),
						existing + (existing ? "\n\n" : "") + `### From task ${taskId}-${taskName}\n${newLearnings}`,
					);
				}
			}
		}

		runningTasks.delete(taskId);

		results.push({
			taskId,
			taskName,
			exitCode: workerResult.exitCode,
			output,
			stderr: workerResult.stderr,
			usage: workerResult.usage,
			model: workerResult.model,
			durationSeconds,
		});

		emitUpdate();
	};

	try {
		// ── Concurrency pool ──
		const queue = pendingTasks.map((t) => ({ id: t.id, name: t.name, title: t.title, file: t.file }));
		const executing = new Set<Promise<void>>();

		while (queue.length > 0 || executing.size > 0) {
			while (!signal?.aborted && executing.size < maxWorkers && queue.length > 0) {
				const task = queue.shift()!;
				const p = processTask(task.id, task.name, task.title, task.file).then(() => executing.delete(p));
				executing.add(p);
			}
			if (executing.size > 0) {
				await Promise.race(executing);
			} else {
				break;
			}
		}
	} finally {
		if (spinnerInterval) {
			clearInterval(spinnerInterval);
			spinnerInterval = null;
		}
		activeRunData = null;
		updateGoalWidget(ctx, cwd);
		// Safety net: reset any in-progress tasks
		const finalState = readState(cwd, slug);
		if (finalState) {
			let dirty = false;
			for (const task of finalState.tasks) {
				if (task.status === "in-progress") {
					task.status = "pending";
					dirty = true;
				}
			}
			if (dirty) writeState(cwd, slug, finalState);
		}
	}

	// Re-read final state
	currentState = readState(cwd, slug) || currentState;

	// Build summary
	const wasCancelled = signal?.aborted;
	const successCount = results.filter((r) => r.exitCode === 0).length;
	const failedCount = results.filter((r) => r.exitCode !== 0).length;
	const cancelledCount = pendingTasks.length - results.length;
	const totalDone = currentState.tasks.filter((t) => t.status === "done").length;
	const totalPending = currentState.tasks.filter((t) => t.status === "pending").length;
	const totalTasks = currentState.tasks.length;
	const totalDuration = results.reduce((sum, r) => sum + (r.durationSeconds || 0), 0);
	const wallTime = results.length > 0 ? Math.max(...results.map((r) => r.durationSeconds || 0)) : 0;

	const summaryLines = [];
	if (wasCancelled) {
		summaryLines.push(
			`Goal "${currentState.name}": cancelled. ${successCount} completed, ${cancelledCount} returned to pending.`,
		);
	} else {
		summaryLines.push(`Goal "${currentState.name}": ${successCount}/${results.length} tasks succeeded.`);
	}
	summaryLines.push(
		`Overall: ${totalDone}/${totalTasks} done${totalPending > 0 ? `, ${totalPending} pending` : ""}${failedCount > 0 ? `, ${failedCount} failed` : ""}.`,
	);
	if (results.length > 0) {
		summaryLines.push(
			`Wall time: ${formatDuration(wallTime)} (total CPU: ${formatDuration(totalDuration)}, ${maxWorkers} workers)`,
		);
	}
	summaryLines.push("");

	// Failed tasks first in summary
	const sortedResults = [...results].sort((a, b) => {
		if (a.exitCode !== 0 && b.exitCode === 0) return -1;
		if (a.exitCode === 0 && b.exitCode !== 0) return 1;
		return 0;
	});
	summaryLines.push(
		...sortedResults.map((r) => {
			const icon = r.exitCode === 0 ? "✓" : "✗";
			const preview = r.output.split("\n")[0]?.slice(0, 100) || "(no output)";
			const duration = r.durationSeconds ? ` (${formatDuration(r.durationSeconds)})` : "";
			return `${icon} ${r.taskId}-${r.taskName}${duration}: ${preview}`;
		}),
	);
	if (cancelledCount > 0) {
		summaryLines.push(`… ${cancelledCount} task(s) cancelled, returned to pending.`);
	}
	summaryLines.push("", "Results written to .pi/goals/" + slug + "/results/");
	if (!wasCancelled) summaryLines.push("Review results and update LEARNINGS.md if needed.");

	// Auto-complete goal when all tasks are done
	if (totalDone === totalTasks && totalTasks > 0) {
		currentState.status = "completed";
		writeState(cwd, slug, currentState);
		setActiveSlug(cwd, null);
		// Clear UI now that goal is no longer active
		updateStatusLine(ctx, cwd);
		updateGoalWidget(ctx, cwd);
		summaryLines.push("", `🎉 Goal "${currentState.name}" completed! Cleared active goal.`);
	}

	return {
		content: summaryLines.join("\n"),
		details: { action: "run", goalSlug: slug, state: currentState, results: sortedResults },
	};
}

function actionStatus(cwd: string): { content: string; details: GoalDetails } {
	const slug = getActiveSlug(cwd);
	if (!slug) {
		const dir = goalsDir(cwd);
		if (!fs.existsSync(dir)) {
			return { content: "No goals found. Use goal create to start one.", details: { action: "status" } };
		}
		const entries = fs.readdirSync(dir).filter((e) => {
			try {
				return fs.statSync(path.join(dir, e)).isDirectory();
			} catch {
				return false;
			}
		});
		if (entries.length === 0) {
			return { content: "No goals found. Use goal create to start one.", details: { action: "status" } };
		}
		return {
			content: `No active goal. Found ${entries.length} goal(s): ${entries.join(", ")}. Set one active or create a new one.`,
			details: { action: "status" },
		};
	}

	const state = readState(cwd, slug);
	if (!state) {
		return { content: `Active goal "${slug}" but state file not found.`, details: { action: "status", goalSlug: slug } };
	}

	const done = state.tasks.filter((t) => t.status === "done").length;
	const failed = state.tasks.filter((t) => t.status === "failed").length;
	const pending = state.tasks.filter((t) => t.status === "pending").length;
	const total = state.tasks.length;

	const lines: string[] = [];
	lines.push(`Goal: ${state.name}`);
	lines.push(`Status: ${state.status}`);
	lines.push(`Progress: ${done}/${total} done, ${pending} pending${failed > 0 ? `, ${failed} failed` : ""}`);
	lines.push("");

	for (const task of state.tasks) {
		const icon =
			task.status === "done" ? "✓" : task.status === "failed" ? "✗" : task.status === "in-progress" ? "⏳" : "○";
		let line = `${icon} ${task.id} ${taskDisplayTitle(task)}: ${task.status}`;
		if (task.summary) line += ` — ${task.summary}`;
		lines.push(line);
	}

	lines.push("", `Files: .pi/goals/${slug}/`);

	const learningsPath = path.join(goalDir(cwd, slug), "LEARNINGS.md");
	try {
		const learnings = fs.readFileSync(learningsPath, "utf-8").trim();
		if (learnings) {
			lines.push("", "Learnings:");
			const truncated = learnings.length > 500 ? learnings.slice(0, 500) + "..." : learnings;
			lines.push(truncated);
		}
	} catch {}

	return { content: lines.join("\n"), details: { action: "status", goalSlug: slug, state } };
}

// ─────────────────────────────────────────────────────
// Overlay — two-mode: list + detail
// ─────────────────────────────────────────────────────

function showGoalOverlay(ctx: any) {
	const cwd = ctx.cwd;
	const slug = getActiveSlug(cwd);
	if (!slug) {
		ctx.ui.notify("No active goal", "info");
		return Promise.resolve();
	}
	const initialState = readState(cwd, slug);
	if (!initialState) {
		ctx.ui.notify("Goal state not found", "error");
		return Promise.resolve();
	}

	return ctx.ui.custom<void>(
		(tui: any, theme: any, _kb: any, done: (v: void) => void) => {
			let mode: "list" | "detail" = "list";
			let selectedIndex = 0;
			let detailScroll = 0;
			let overlaySpinner: ReturnType<typeof setInterval> | null = null;

			// Store handle for live updates from actionRun
			overlayTui = tui;

			// Spinner for elapsed time when run is active
			overlaySpinner = setInterval(() => {
				if (activeRunData?.runningTasks.size) tui.requestRender();
			}, 1000);

			const fg = theme.fg.bind(theme);

			return {
				render(width: number): string[] {
					const state = readState(cwd, slug) || initialState;
					const termH = process.stdout.rows || 40;

					if (mode === "detail") {
						return renderDetailView(state, width, termH, cwd, slug!, fg, theme);
					}
					return renderListView(state, width, termH, cwd, slug!, fg, theme);
				},

				handleInput(data: string): void {
					const state = readState(cwd, slug) || initialState;

					if (mode === "list") {
						if (matchesKey(data, "escape") || data === "q") {
							done(undefined);
							return;
						}
						if (matchesKey(data, "up") || data === "k") {
							selectedIndex = Math.max(0, selectedIndex - 1);
						} else if (matchesKey(data, "down") || data === "j") {
							selectedIndex = Math.min(state.tasks.length - 1, selectedIndex + 1);
						} else if (matchesKey(data, "enter")) {
							if (state.tasks.length > 0) {
								mode = "detail";
								detailScroll = 0;
							}
						}
					} else {
						if (matchesKey(data, "escape") || data === "q") {
							mode = "list";
							return;
						}
						const maxScroll = 200; // rough upper bound
						if (matchesKey(data, "up") || data === "k") {
							detailScroll = Math.max(0, detailScroll - 1);
						} else if (matchesKey(data, "down") || data === "j") {
							detailScroll = Math.min(maxScroll, detailScroll + 1);
						} else if (matchesKey(data, "pageUp") || data === "u") {
							detailScroll = Math.max(0, detailScroll - 10);
						} else if (matchesKey(data, "pageDown") || data === "d") {
							detailScroll = Math.min(maxScroll, detailScroll + 10);
						} else if (data === "g") {
							detailScroll = 0;
						} else if (data === "G") {
							detailScroll = maxScroll;
						}
					}
					tui.requestRender();
				},

				invalidate(): void {},

				dispose(): void {
					overlayTui = null;
					if (overlaySpinner) {
						clearInterval(overlaySpinner);
						overlaySpinner = null;
					}
				},
			};

			// ── List view renderer ──
			function renderListView(
				state: GoalState,
				width: number,
				termH: number,
				cwd: string,
				slug: string,
				fg: (c: string, t: string) => string,
				theme: any,
			): string[] {
				const content: string[] = [];

				// Stats
				const doneCount = state.tasks.filter((t) => t.status === "done").length;
				const failedCount = state.tasks.filter((t) => t.status === "failed").length;
				const runningCount = state.tasks.filter((t) => t.status === "in-progress").length;
				const total = state.tasks.length;

				const statParts = [`${doneCount}/${total} done`];
				if (runningCount > 0) statParts.push(`${runningCount} running`);
				if (failedCount > 0) statParts.push(`${failedCount} failed`);

				content.push(`  ${fg("dim", statParts.join(" · "))}`);
				content.push("");

				// Task rows — running/failed first for attention
				const sortedTasks = [...state.tasks].sort((a, b) => {
					const order: Record<string, number> = { "in-progress": 0, failed: 1, pending: 2, done: 3 };
					return (order[a.status] ?? 4) - (order[b.status] ?? 4);
				});

				// Map sorted index back to original index for selection
				const originalIndices = sortedTasks.map((t) => state.tasks.indexOf(t));

				for (let i = 0; i < sortedTasks.length; i++) {
					const task = sortedTasks[i];
					const isSelected = originalIndices[i] === selectedIndex;
					const rt = activeRunData?.runningTasks.get(task.id);

					const rows = renderTaskRow(task, rt, fg, { selected: isSelected, showActivity: true });
					for (const row of rows) {
						content.push(truncateToWidth(row, width));
					}
				}

				// Viewport + scroll
				const viewportRows = Math.max(4, termH - 4);
				const out: string[] = [];

				// Header
				const title = `🎯 ${state.name}`;
				const fillLen = Math.max(0, width - 3 - 1 - title.length - 1);
				out.push(
					truncateToWidth(
						fg("borderMuted", "───") + fg("accent", ` ${title} `) + fg("borderMuted", "─".repeat(fillLen)),
						width,
					),
				);

				// Content (no scrolling needed for list — it's compact)
				for (const line of content.slice(0, viewportRows)) {
					out.push(truncateToWidth(line, width));
				}
				for (let i = content.length; i < viewportRows; i++) out.push("");

				// Footer
				const helpText = " ↑↓ navigate · enter detail · esc close ";
				const footFill = Math.max(0, width - helpText.length);
				out.push(truncateToWidth(fg("borderMuted", "─".repeat(footFill)) + fg("dim", helpText), width));

				return out;
			}

			// ── Detail view renderer ──
			function renderDetailView(
				state: GoalState,
				width: number,
				termH: number,
				cwd: string,
				slug: string,
				fg: (c: string, t: string) => string,
				theme: any,
			): string[] {
				const task = state.tasks[selectedIndex];
				if (!task) {
					mode = "list";
					return renderListView(state, width, termH, cwd, slug, fg, theme);
				}

				const rt = activeRunData?.runningTasks.get(task.id);
				const content: string[] = [];

				// ── Status + metrics ──
				const statusParts: string[] = [task.status];
				if (rt) statusParts.push(formatElapsed(Date.now() - rt.startedAt));
				else if (task.durationSeconds) statusParts.push(formatDuration(task.durationSeconds));
				if (task.cost && task.cost > 0) statusParts.push(`$${task.cost.toFixed(3)}`);
				if (task.turns) statusParts.push(`${task.turns} turns`);
				if (task.tokens) statusParts.push(`↑${formatTokens(task.tokens.input)} ↓${formatTokens(task.tokens.output)}`);

				content.push(`  ${fg("dim", statusParts.join(" · "))}`);
				content.push("");

				// ── Activity (for running tasks) — shown FIRST ──
				if (rt && rt.items.length > 0) {
					content.push(`  ${fg("accent", `Activity (${rt.items.length} items):`)}`);
					content.push(`  ${fg("borderMuted", "┄".repeat(Math.min(50, width - 4)))}`);
					for (const item of rt.items) {
						if (item.type === "toolCall") {
							content.push(
								truncateToWidth(
									`  ${fg("muted", "→ ")}${formatToolCall(item.name, item.args, fg)}`,
									width,
								),
							);
						}
					}
					content.push("");
				}

				// ── Result (for completed tasks) — shown FIRST ──
				if (!rt && task.resultFile) {
					const resultContent = readResultFile(cwd, slug, task.resultFile);
					const outputMatch = resultContent.match(/## Output\n([\s\S]*?)(?=\n## |$)/);
					if (outputMatch) {
						content.push(`  ${fg("accent", "Result:")}`);
						content.push(`  ${fg("borderMuted", "┄".repeat(Math.min(50, width - 4)))}`);
						for (const line of outputMatch[1].trim().split("\n")) {
							content.push(truncateToWidth(`  ${fg("muted", line)}`, width));
						}
						content.push("");
					}

					// Stderr for failed tasks
					if (task.status === "failed") {
						const stderrMatch = resultContent.match(/## Stderr\n([\s\S]*?)$/);
						if (stderrMatch) {
							content.push(`  ${fg("error", "Stderr:")}`);
							content.push(`  ${fg("borderMuted", "┄".repeat(Math.min(50, width - 4)))}`);
							for (const line of stderrMatch[1].trim().split("\n").slice(-20)) {
								content.push(truncateToWidth(`  ${fg("dim", line)}`, width));
							}
							content.push("");
						}
					}
				}

				// ── Task spec — shown LAST (it's static reference) ──
				const spec = readTaskSpec(cwd, slug, task.file);
				if (spec) {
					content.push(`  ${fg("accent", "Task spec:")}`);
					content.push(`  ${fg("borderMuted", "┄".repeat(Math.min(50, width - 4)))}`);
					for (const line of spec.split("\n")) {
						content.push(truncateToWidth(`  ${fg("dim", line)}`, width));
					}
				}

				// Viewport + scroll
				const viewportRows = Math.max(4, termH - 4);
				const totalRows = content.length;
				const maxScroll = Math.max(0, totalRows - viewportRows);
				if (detailScroll > maxScroll) detailScroll = maxScroll;

				const out: string[] = [];

				// Header
				const icon =
					task.status === "done"
						? fg("success", "✓")
						: task.status === "failed"
							? fg("error", "✗")
							: rt
								? fg("warning", SPINNER[spinnerFrame % SPINNER.length])
								: fg("dim", "○");

				const title = `${task.id} ${taskDisplayTitle(task)}`;
				const fillLen = Math.max(0, width - 3 - 3 - title.length - 1);
				out.push(
					truncateToWidth(
						fg("borderMuted", "───") +
							` ${icon} ` +
							fg("accent", title) +
							" " +
							fg("borderMuted", "─".repeat(fillLen)),
						width,
					),
				);

				// Content
				const visible = content.slice(detailScroll, detailScroll + viewportRows);
				for (const line of visible) out.push(truncateToWidth(line, width));
				for (let i = visible.length; i < viewportRows; i++) out.push("");

				// Footer
				const scrollInfo = totalRows > viewportRows ? ` ${detailScroll + 1}-${Math.min(detailScroll + viewportRows, totalRows)}/${totalRows}` : "";
				const helpText = ` ↑↓ scroll · esc back${scrollInfo} `;
				const footFill = Math.max(0, width - helpText.length);
				out.push(truncateToWidth(fg("borderMuted", "─".repeat(footFill)) + fg("dim", helpText), width));

				return out;
			}
		},
		{
			overlay: true,
			overlayOptions: {
				width: "95%",
				maxHeight: "90%",
				anchor: "center" as const,
			},
		},
	);
}

// ─────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── System prompt injection ──
	pi.on("before_agent_start", async (event, ctx) => {
		const goalContext = buildGoalContext(ctx.cwd);
		if (!goalContext) return;
		return { systemPrompt: event.systemPrompt + "\n" + goalContext };
	});

	// ── Session lifecycle ──
	const initSession = (ctx: any) => {
		lastExtCtx = ctx;
		updateStatusLine(ctx, ctx.cwd);
	};
	pi.on("session_start", async (_event, ctx) => initSession(ctx));
	pi.on("session_switch", async (_event, ctx) => initSession(ctx));
	pi.on("session_fork", async (_event, ctx) => initSession(ctx));
	pi.on("session_tree", async (_event, ctx) => initSession(ctx));

	// ── Ctrl+X: toggle widget expand/collapse ──
	pi.registerShortcut("ctrl+x", {
		description: "Toggle goal dashboard widget",
		handler: async (ctx) => {
			const slug = getActiveSlug(ctx.cwd);
			if (!slug) {
				ctx.ui.notify("No active goal", "info");
				return;
			}
			goalWidgetExpanded = !goalWidgetExpanded;
			updateGoalWidget(ctx, ctx.cwd);
		},
	});



	// ── /goal interactive command — unified list with inline actions ──
	pi.registerCommand("goal", {
		description: "Manage goals (view, switch, complete, dismiss)",
		handler: async (_args, ctx) => {
			// Gather ALL goals, sorted by creation (newest first)
			const dir = goalsDir(ctx.cwd);
			const allSlugs: string[] = [];
			try {
				if (fs.existsSync(dir)) {
					for (const entry of fs.readdirSync(dir)) {
						try {
							if (fs.statSync(path.join(dir, entry)).isDirectory()) {
								allSlugs.push(entry);
							}
						} catch {}
					}
				}
			} catch {}

			if (allSlugs.length === 0) {
				ctx.ui.notify("No goals found. Use the goal tool to create one.", "info");
				return;
			}

			// Sort newest first
			allSlugs.sort((a, b) => {
				const sa = readState(ctx.cwd, a);
				const sb = readState(ctx.cwd, b);
				return new Date(sb?.created || 0).getTime() - new Date(sa?.created || 0).getTime();
			});

			const activeSlug = getActiveSlug(ctx.cwd);

			// Build goal data for rendering
			type GoalRow = {
				slug: string;
				state: GoalState;
				label: string;
				isActive: boolean;
			};

			const goals: GoalRow[] = allSlugs
				.map((slug) => {
					const state = readState(ctx.cwd, slug);
					if (!state) return null;

					const done = state.tasks.filter((t) => t.status === "done").length;
					const failed = state.tasks.filter((t) => t.status === "failed").length;
					const total = state.tasks.length;
					const totalCost = state.tasks.reduce((s, t) => s + (t.cost || 0), 0);
					const totalDur = state.tasks.reduce((s, t) => s + (t.durationSeconds || 0), 0);
					const isActive = slug === activeSlug;

					const statusIcon = isActive ? "●" : state.status === "completed" ? "✓" : state.status === "paused" ? "⏸" : "○";
					const statusText = isActive ? "active" : state.status === "completed" ? "done" : state.status;

					const created = new Date(state.created);
					const month = created.toLocaleString("en", { month: "short" });
					const day = created.getDate();

					const progress = `${done}/${total}${failed > 0 ? ` ${failed}✗` : ""}`;
					const costStr = totalCost > 0 ? `$${totalCost.toFixed(2)}` : "—";
					const durStr = totalDur > 0 ? formatDuration(totalDur) : "—";

					const label = [
						state.name.slice(0, 26).padEnd(26),
						`${statusIcon} ${statusText}`.padEnd(10),
						progress.padEnd(7),
						costStr.padStart(7),
						durStr.padStart(7),
						`${month} ${day}`,
					].join(" ");

					return { slug, state, label, isActive };
				})
				.filter((g): g is GoalRow => g !== null);

			if (goals.length === 0) {
				ctx.ui.notify("No valid goals found.", "info");
				return;
			}

			// Custom UI with inline actions — stays open until esc
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				let selectedIndex = goals.findIndex((g) => g.isActive);
				if (selectedIndex < 0) selectedIndex = 0;
				let cachedLines: string[] | undefined;
				let currentActiveSlug = activeSlug;

				const fg = theme.fg.bind(theme);

				function rebuildGoalRow(g: GoalRow) {
					const state = readState(ctx.cwd, g.slug);
					if (!state) return;
					g.state = state;
					g.isActive = g.slug === currentActiveSlug;

					const done = state.tasks.filter((t) => t.status === "done").length;
					const failed = state.tasks.filter((t) => t.status === "failed").length;
					const total = state.tasks.length;
					const totalCost = state.tasks.reduce((s, t) => s + (t.cost || 0), 0);
					const totalDur = state.tasks.reduce((s, t) => s + (t.durationSeconds || 0), 0);

					const statusIcon = g.isActive ? "●" : state.status === "completed" ? "✓" : state.status === "paused" ? "⏸" : "○";
					const statusText = g.isActive ? "active" : state.status === "completed" ? "done" : state.status;

					const created = new Date(state.created);
					const month = created.toLocaleString("en", { month: "short" });
					const day = created.getDate();

					const progress = `${done}/${total}${failed > 0 ? ` ${failed}✗` : ""}`;
					const costStr = totalCost > 0 ? `$${totalCost.toFixed(2)}` : "—";
					const durStr = totalDur > 0 ? formatDuration(totalDur) : "—";

					g.label = [
						state.name.slice(0, 26).padEnd(26),
						`${statusIcon} ${statusText}`.padEnd(10),
						progress.padEnd(7),
						costStr.padStart(7),
						durStr.padStart(7),
						`${month} ${day}`,
					].join(" ");
				}

				function rebuildAll() {
					currentActiveSlug = getActiveSlug(ctx.cwd);
					for (const g of goals) rebuildGoalRow(g);
				}

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function performAction(action: string, slug: string) {
					const state = readState(ctx.cwd, slug);
					if (!state) return;

					if (action === "activate") {
						// Pause previous active if different
						if (currentActiveSlug && currentActiveSlug !== slug) {
							const prev = readState(ctx.cwd, currentActiveSlug);
							if (prev && prev.status === "active") {
								prev.status = "paused";
								writeState(ctx.cwd, currentActiveSlug, prev);
							}
						}
						state.status = "active";
						writeState(ctx.cwd, slug, state);
						setActiveSlug(ctx.cwd, slug);
					} else if (action === "complete") {
						state.status = "completed";
						writeState(ctx.cwd, slug, state);
						if (slug === currentActiveSlug) {
							setActiveSlug(ctx.cwd, null);
						}
					} else if (action === "dismiss") {
						setActiveSlug(ctx.cwd, null);
					}

					rebuildAll();
					updateStatusLine(ctx, ctx.cwd);
					updateGoalWidget(ctx, ctx.cwd);
					refresh();
				}

				return {
					render(width: number): string[] {
						if (cachedLines) return cachedLines;
						const lines: string[] = [];

						lines.push(fg("accent", "─".repeat(width)));
						lines.push(fg("accent", theme.bold(" 🎯 Goals")));
						lines.push("");

						const header = [
							"name".padEnd(26),
							"status".padEnd(10),
							"tasks".padEnd(7),
							"cost".padStart(7),
							"time".padStart(7),
							"created",
						].join(" ");
						lines.push(fg("dim", `    ${header}`));

						for (let i = 0; i < goals.length; i++) {
							const g = goals[i];
							const isSelected = i === selectedIndex;
							const prefix = isSelected ? fg("accent", "→ ") : "  ";
							const color = isSelected ? "accent" : g.isActive ? "text" : "muted";
							lines.push(truncateToWidth(`${prefix}${fg(color, g.label)}`, width));
						}

						lines.push("");

						const helpParts = ["↑↓ navigate"];
						const sel = goals[selectedIndex];
						if (sel) {
							if (!sel.isActive) helpParts.push("enter activate");
							if (sel.state.status !== "completed") helpParts.push("d complete");
							if (sel.isActive) helpParts.push("x dismiss");
						}
						helpParts.push("esc close");
						lines.push(fg("dim", ` ${helpParts.join(" · ")}`));

						lines.push(fg("accent", "─".repeat(width)));

						cachedLines = lines;
						return lines;
					},

					handleInput(data: string): void {
						if (matchesKey(data, "escape") || data === "q") {
							done(undefined);
							return;
						}
						if (matchesKey(data, "up") || data === "k") {
							selectedIndex = selectedIndex <= 0 ? goals.length - 1 : selectedIndex - 1;
							refresh();
							return;
						}
						if (matchesKey(data, "down") || data === "j") {
							selectedIndex = selectedIndex >= goals.length - 1 ? 0 : selectedIndex + 1;
							refresh();
							return;
						}

						const sel = goals[selectedIndex];
						if (!sel) return;

						if (matchesKey(data, "enter") && !sel.isActive) {
							performAction("activate", sel.slug);
							return;
						}
						if (data === "d" && sel.state.status !== "completed") {
							performAction("complete", sel.slug);
							return;
						}
						if (data === "x" && sel.isActive) {
							performAction("dismiss", sel.slug);
							return;
						}
					},

					invalidate(): void {
						cachedLines = undefined;
					},
				};
			});
		},
	});

	// ── The goal tool ──
	pi.registerTool({
		name: "goal",
		label: "Goal",
		description:
			"Manage autonomous goals with sub-agent workers. Actions: create (new goal), add_task (add a task), run (execute pending tasks with workers), status (check progress).",
		promptSnippet: "Create goals, add tasks with rich specs, spawn worker agents to implement them, track progress",
		promptGuidelines: [
			"Use `goal create` when the user wants to start a structured multi-task effort.",
			"Write rich task docs for `goal add_task` — include specific file paths, code snippets, constraints. Workers read the task doc and implement directly without broad exploration.",
			"Call `goal status` to re-ground yourself on current progress, especially after compaction.",
			"After `goal run`, evaluate results and update LEARNINGS.md with curated insights.",
		],
		parameters: Type.Object({
			action: StringEnum(["create", "add_task", "run", "status"] as const, {
				description: "Action to perform",
			}),
			name: Type.Optional(Type.String({ description: "Goal or task name (for create/add_task)" })),
			description: Type.Optional(Type.String({ description: "Goal description (for create)" })),
			content: Type.Optional(
				Type.String({
					description:
						"Full markdown task specification (for add_task). Include: what to do, key files with paths, constraints, acceptance criteria.",
				}),
			),
			workerModel: Type.Optional(
				Type.String({ description: "Model for worker agents (defaults to current model)" }),
			),
			maxWorkers: Type.Optional(
				Type.Number({ description: `Max parallel workers for run (default: ${DEFAULT_MAX_WORKERS})` }),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			switch (params.action) {
				case "create": {
					if (!params.name) {
						return { content: [{ type: "text", text: "Missing name for goal create." }], details: {} };
					}
					const result = actionCreate(ctx.cwd, params.name, params.description || params.name, params.workerModel);
					updateStatusLine(ctx, ctx.cwd);
					return { content: [{ type: "text", text: result.content }], details: result.details };
				}

				case "add_task": {
					if (!params.name || !params.content) {
						return { content: [{ type: "text", text: "Missing name or content for add_task." }], details: {} };
					}
					const result = actionAddTask(ctx.cwd, params.name, params.content);
					updateStatusLine(ctx, ctx.cwd);
					return { content: [{ type: "text", text: result.content }], details: result.details };
				}

				case "run": {
					const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
					const maxWorkers = params.maxWorkers ?? DEFAULT_MAX_WORKERS;
					const result = await actionRun(ctx.cwd, currentModel, maxWorkers, signal, onUpdate as any, ctx);
					updateStatusLine(ctx, ctx.cwd);
					return { content: [{ type: "text", text: result.content }], details: result.details };
				}

				case "status": {
					const result = actionStatus(ctx.cwd);
					return { content: [{ type: "text", text: result.content }], details: result.details };
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
			}
		},

		renderCall(args, theme) {
			const action = args.action || "...";
			let text = theme.fg("toolTitle", theme.bold("goal ")) + theme.fg("accent", action);

			if (action === "create" && args.name) {
				text += " " + theme.fg("dim", args.name);
			} else if (action === "add_task" && args.name) {
				text += " " + theme.fg("dim", args.name);
			} else if (action === "run") {
				const workers = args.maxWorkers ?? DEFAULT_MAX_WORKERS;
				text += theme.fg("dim", ` (${workers} workers)`);
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as GoalDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const fg = theme.fg.bind(theme);

			// ── Create ──
			if (details.action === "create") {
				if (details.state) {
					return new Text(
						fg("success", "✓ ") + fg("toolTitle", `Created: ${details.state.name}`) +
							fg("dim", `\n  .pi/goals/${details.state.slug}/`),
						0, 0,
					);
				}
				const raw = result.content[0];
				return new Text(raw?.type === "text" ? raw.text : "(no output)", 0, 0);
			}

			// ── Add Task ──
			if (details.action === "add_task") {
				if (details.state && details.state.tasks.length > 0) {
					const latest = details.state.tasks[details.state.tasks.length - 1];
					let text = fg("success", "✓ ") + `Task ${fg("accent", latest.id)} added`;
					text += fg("dim", ` — ${taskDisplayTitle(latest)}`);

					if (expanded) {
						text += "\n";
						for (const task of details.state.tasks) {
							const icon =
								task.status === "done"
									? fg("success", "✓")
									: task.status === "failed"
										? fg("error", "✗")
										: fg("dim", "○");
							text += `\n  ${icon} ${fg("accent", task.id)} ${fg("dim", taskDisplayTitle(task))}`;
						}
					}
					return new Text(text, 0, 0);
				}
				const raw = result.content[0];
				return new Text(raw?.type === "text" ? raw.text : "(no output)", 0, 0);
			}

			// ── Status ──
			if (details.action === "status") {
				if (details.state && details.state.tasks.length > 0) {
					const s = details.state;
					const done = s.tasks.filter((t) => t.status === "done").length;
					let text = fg("toolTitle", theme.bold(`🎯 ${s.name}`));
					text += fg("dim", ` ${done}/${s.tasks.length} done`);
					text += "\n";

					for (const task of s.tasks) {
						const icon =
							task.status === "done"
								? fg("success", "✓")
								: task.status === "failed"
									? fg("error", "✗")
									: task.status === "in-progress"
										? fg("warning", "⏳")
										: fg("dim", "○");
						text += `\n  ${icon} ${fg("accent", task.id)} ${fg("dim", taskDisplayTitle(task))}`;
						if (task.summary) text += fg("muted", ` — ${task.summary}`);
						if (expanded && task.durationSeconds) {
							let meta = `${formatDuration(task.durationSeconds)}`;
							if (task.cost && task.cost > 0) meta += ` $${task.cost.toFixed(3)}`;
							if (task.turns) meta += ` ${task.turns}t`;
							text += fg("dim", ` (${meta})`);
						}
					}
					return new Text(text, 0, 0);
				}
				const raw = result.content[0];
				return new Text(raw?.type === "text" ? raw.text : "(no output)", 0, 0);
			}

			// ── Run ──
			if (details.action === "run") {
				const completedResults = details.results || [];
				const running = details.runningTasks || [];

				// Still streaming — minimal (widget is the dashboard)
				if (running.length > 0) {
					const frame = SPINNER[spinnerFrame % SPINNER.length];
					const doneCount = completedResults.length;
					return new Text(
						fg("warning", frame) + fg("dim", ` ${doneCount} done, ${running.length} running`),
						0, 0,
					);
				}

				// Done — summary
				if (completedResults.length > 0) {
					const success = completedResults.filter((r) => r.exitCode === 0).length;
					const totalDuration = completedResults.reduce((s, r) => s + (r.durationSeconds || 0), 0);
					const wallTime = Math.max(...completedResults.map((r) => r.durationSeconds || 0));

					let text = fg(
						success === completedResults.length ? "success" : "warning",
						`${success}/${completedResults.length} tasks succeeded`,
					);
					if (totalDuration > 0) {
						text += fg("dim", ` · wall ${formatDuration(wallTime)} · cpu ${formatDuration(totalDuration)}`);
					}

					// Failures first, then successes
					if (expanded) {
						text += "\n";
						for (const r of completedResults) {
							const icon = r.exitCode === 0 ? fg("success", "✓") : fg("error", "✗");
							const dur = r.durationSeconds ? fg("dim", ` ${formatDuration(r.durationSeconds)}`) : "";
							const preview = r.output.split("\n")[0]?.slice(0, 80) || "(no output)";
							text += `\n${icon} ${fg("accent", `${r.taskId}`)}${dur} ${fg("muted", `— ${preview}`)}`;

							// Show failure details
							if (r.exitCode !== 0 && r.stderr) {
								const lastStderr = r.stderr.trim().split("\n").slice(-2).join("\n");
								if (lastStderr) text += `\n  ${fg("error", lastStderr.slice(0, 120))}`;
							}
						}
					}
					return new Text(text.trimEnd(), 0, 0);
				}

				const raw = result.content[0];
				return new Text(raw?.type === "text" ? raw.text : "(no output)", 0, 0);
			}

			const raw = result.content[0];
			return new Text(raw?.type === "text" ? raw.text : "(no output)", 0, 0);
		},
	});
}
