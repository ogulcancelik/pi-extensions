/**
 * Session Recall Extension - Search and query past pi sessions
 *
 * Two tools + one command:
 *
 * Tools:
 * 1. session_search - Find relevant past sessions by keywords.
 *    Use when the user mentions something from a previous conversation
 *    and you need to find which session it was in.
 *
 * 2. session_query - Deep dive into a specific session.
 *    Use after session_search to get detailed information from a
 *    specific session, or when you already know the session path
 *    (e.g., from a handoff).
 *
 * Command:
 * /session-recall - Configure the model used for session queries.
 *    Shows all available models and lets you pick one. Persists the
 *    choice to ~/.pi/agent/session-recall.json (or equivalent).
 *
 * Typical flow: user says "remember when we tried X?" →
 *   session_search("X") → find the right session →
 *   session_query(path, "what approach did we take for X?")
 */

import { complete, type Model, type Api, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
	getAgentDir,
	SessionManager,
	convertToLlm,
	getMarkdownTheme,
	serializeConversation,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import {
	Container,
	Input,
	Markdown,
	SelectList,
	type SelectItem,
	type SelectListTheme,
	Spacer,
	Text,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ── Config ───────────────────────────────────────────────────────────────────

interface SessionRecallConfig {
	queryModel?: {
		provider: string;
		id: string;
	};
}

function getConfigPath(): string {
	return join(getAgentDir(), "session-recall.json");
}

function loadConfig(): SessionRecallConfig {
	const configPath = getConfigPath();
	if (!existsSync(configPath)) return {};
	try {
		return JSON.parse(readFileSync(configPath, "utf-8"));
	} catch {
		return {};
	}
}

function saveConfig(config: SessionRecallConfig): void {
	const configPath = getConfigPath();
	const dir = dirname(configPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Resolve the query model from config → fallback to current session model.
 */
function resolveQueryModel(ctx: ExtensionCommandContext): Model<Api> | undefined {
	const config = loadConfig();
	if (config.queryModel) {
		const found = ctx.modelRegistry.find(config.queryModel.provider, config.queryModel.id);
		if (found) return found;
	}
	// Fallback: current session model
	return ctx.model;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Get the sessions root directory */
function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/**
 * Extract a readable project name from the encoded session directory path.
 * Session dirs are encoded as: --home-user-projects-myapp--
 * We strip the home directory prefix and convert dashes back to slashes.
 *
 * Uses the same encoding scheme as session-manager:
 *   cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")
 * This handles both Unix (/) and Windows (\, C:\) paths.
 */
function projectFromPath(sessionPath: string): string {
	// Match the encoded directory name — handle both / and \ separators
	const match = sessionPath.match(/sessions[/\\](--.*?--)[/\\]/);
	if (!match || !match[1]) return "~";

	// Decode: strip leading/trailing --, replace internal - with /
	let encoded = match[1].slice(2, -2); // remove -- from both ends

	// Encode homedir with the same scheme session-manager uses,
	// so it works on both Unix (/home/can) and Windows (C:\Users\Pc)
	const homeEncoded = homedir()
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-");

	if (encoded.startsWith(homeEncoded + "-")) {
		encoded = encoded.slice(homeEncoded.length + 1);
	} else if (encoded === homeEncoded) {
		return "~";
	}

	return encoded.replace(/-/g, "/") || "~";
}

/** Extract date from session filename */
function dateFromPath(sessionPath: string): string {
	const match = sessionPath.match(/(\d{4}-\d{2}-\d{2})T/);
	return match?.[1] ?? "unknown";
}

/** Parse a JSONL line and extract the text content if it's a message */
function extractMessageText(jsonLine: string): { role: string; text: string } | null {
	try {
		const entry = JSON.parse(jsonLine);
		if (entry.type !== "message") return null;
		const msg = entry.message;
		const role = msg.role as string;
		const texts = (msg.content ?? [])
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join(" ");
		if (!texts) return null;
		return { role, text: texts };
	} catch {
		return null;
	}
}

/** Get a snippet of text around a keyword match */
function snippetAround(text: string, keyword: string, radius = 100): string {
	const lower = text.toLowerCase();
	const idx = lower.indexOf(keyword.toLowerCase());
	if (idx === -1) return text.slice(0, radius * 2);
	const start = Math.max(0, idx - radius);
	const end = Math.min(text.length, idx + keyword.length + radius);
	const prefix = start > 0 ? "..." : "";
	const suffix = end < text.length ? "..." : "";
	return prefix + text.slice(start, end) + suffix;
}

/** Rough token estimate: ~4 chars per token */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Extract keywords from a question for matching.
 * Strips common stop words and short words.
 */
function extractKeywords(question: string): string[] {
	const stopWords = new Set([
		"a", "an", "the", "is", "was", "were", "are", "be", "been", "being",
		"have", "has", "had", "do", "does", "did", "will", "would", "could",
		"should", "may", "might", "can", "shall", "to", "of", "in", "for",
		"on", "with", "at", "by", "from", "as", "into", "about", "like",
		"through", "after", "over", "between", "out", "against", "during",
		"without", "before", "under", "around", "among", "and", "but", "or",
		"nor", "not", "so", "yet", "both", "either", "neither", "each",
		"every", "all", "any", "few", "more", "most", "other", "some", "such",
		"no", "only", "own", "same", "than", "too", "very", "just", "because",
		"if", "when", "where", "how", "what", "which", "who", "whom", "this",
		"that", "these", "those", "it", "its", "they", "them", "their", "we",
		"us", "our", "you", "your", "he", "him", "his", "she", "her", "i", "me", "my",
	]);
	return question
		.toLowerCase()
		.replace(/[^\w\s-]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2 && !stopWords.has(w));
}

interface SerializedMessage {
	index: number;
	role: string;
	text: string;
	charCount: number;
}

/**
 * Build a context-windowed conversation text for large sessions.
 *
 * Strategy:
 * - Always include first few messages (setup/context) and last few (final state)
 * - Find messages matching question keywords
 * - Expand windows around matches until we hit the token budget
 * - Mark gaps with "[... N messages omitted ...]"
 */
function buildWindowedContext(
	serializedMessages: SerializedMessage[],
	question: string,
	tokenBudget: number,
): string {
	const BOOKEND_COUNT = 3;
	const total = serializedMessages.length;

	if (total <= BOOKEND_COUNT * 2 + 2) {
		return serializedMessages.map((m) => `[${m.role}]\n${m.text}`).join("\n\n");
	}

	const keywords = extractKeywords(question);
	const scores = serializedMessages.map((msg) => {
		const lower = msg.text.toLowerCase();
		let score = 0;
		for (const kw of keywords) {
			if (lower.includes(kw)) score++;
		}
		return score;
	});

	const included = new Set<number>();
	for (let i = 0; i < Math.min(BOOKEND_COUNT, total); i++) included.add(i);
	for (let i = Math.max(0, total - BOOKEND_COUNT); i < total; i++) included.add(i);

	const matchIndices = scores
		.map((score, i) => ({ score, i }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((x) => x.i);

	for (const i of matchIndices) included.add(i);

	const charBudget = tokenBudget * 4;
	const currentChars = () =>
		[...included].reduce((sum, i) => sum + serializedMessages[i].charCount + 20, 0);

	let radius = 1;
	while (currentChars() < charBudget * 0.8 && radius < total) {
		const before = included.size;
		for (const i of matchIndices) {
			for (let d = -radius; d <= radius; d++) {
				const idx = i + d;
				if (idx >= 0 && idx < total) included.add(idx);
			}
		}
		if (included.size === before) break;
		radius++;
	}

	if (currentChars() < charBudget * 0.8) {
		for (let i = BOOKEND_COUNT; i < total && currentChars() < charBudget * 0.8; i++) {
			included.add(i);
		}
	}

	const sortedIndices = [...included].sort((a, b) => a - b);
	const parts: string[] = [];
	let lastIdx = -1;

	for (const i of sortedIndices) {
		if (lastIdx >= 0 && i > lastIdx + 1) {
			const gap = i - lastIdx - 1;
			parts.push(`[... ${gap} message${gap > 1 ? "s" : ""} omitted ...]`);
		}
		const msg = serializedMessages[i];
		parts.push(`[${msg.role}]\n${msg.text}`);
		lastIdx = i;
	}

	if (lastIdx < total - 1 && !included.has(total - 1)) {
		const gap = total - 1 - lastIdx;
		parts.push(`[... ${gap} message${gap > 1 ? "s" : ""} omitted ...]`);
	}

	return parts.join("\n\n");
}

// ── Search Backend ───────────────────────────────────────────────────────────

type SearchBackend = "rg" | "grep" | "node";
let cachedBackend: SearchBackend | undefined;

/** Detect best available search backend: rg → grep → node-native */
function getSearchBackend(): SearchBackend {
	if (cachedBackend !== undefined) return cachedBackend;

	for (const cmd of ["rg", "grep"] as const) {
		try {
			execFileSync(cmd, ["--version"], { stdio: "ignore", timeout: 5000 });
			cachedBackend = cmd;
			return cmd;
		} catch {
			// not available, try next
		}
	}

	cachedBackend = "node";
	return "node";
}

interface FileMatchCount {
	path: string;
	count: number;
}

/** Recursively find all .jsonl files under a directory */
function walkJsonlFiles(dir: string): string[] {
	const results: string[] = [];
	function walk(d: string) {
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(d, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".jsonl")) results.push(full);
		}
	}
	walk(dir);
	return results;
}

/**
 * Search for a query across all session files, returning files with match counts.
 * Falls back through rg → grep → node-native.
 */
function searchFiles(query: string, sessionsDir: string, timeout = 10000): FileMatchCount[] {
	const backend = getSearchBackend();

	if (backend === "rg") {
		try {
			const output = execFileSync("rg", ["-i", "-c", "-F", query, sessionsDir], {
				encoding: "utf-8",
				timeout,
				stdio: ["pipe", "pipe", "pipe"],
			});
			return parseCountOutput(output);
		} catch (err: any) {
			if (err.status === 1) return []; // no matches
			// rg failed unexpectedly — try grep
		}
	}

	if (backend === "rg" || backend === "grep") {
		try {
			const output = execFileSync(
				"grep",
				["-r", "-i", "-c", "-F", "--include=*.jsonl", query, sessionsDir],
				{
					encoding: "utf-8",
					timeout,
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			return parseCountOutput(output);
		} catch (err: any) {
			if (err.status === 1) return []; // no matches
			// grep failed too — fall through to node
		}
	}

	// Node-native fallback
	return nodeSearchFiles(query, sessionsDir);
}

/** Parse `file:count` output from rg -c / grep -c */
function parseCountOutput(output: string): FileMatchCount[] {
	return output
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const lastColon = line.lastIndexOf(":");
			return {
				path: line.slice(0, lastColon),
				count: parseInt(line.slice(lastColon + 1), 10),
			};
		})
		.filter((m) => m.count > 0);
}

/** Node-native: count case-insensitive matches per file */
function nodeSearchFiles(query: string, sessionsDir: string): FileMatchCount[] {
	const files = walkJsonlFiles(sessionsDir);
	const queryLower = query.toLowerCase();
	const results: FileMatchCount[] = [];

	for (const filePath of files) {
		try {
			const content = readFileSync(filePath, "utf-8");
			const lower = content.toLowerCase();
			let count = 0;
			let idx = 0;
			while ((idx = lower.indexOf(queryLower, idx)) !== -1) {
				count++;
				idx += queryLower.length;
			}
			if (count > 0) results.push({ path: filePath, count });
		} catch {
			continue;
		}
	}

	return results;
}

/**
 * Find matching lines in a single file, up to maxMatches.
 * Falls back through rg → grep → node-native.
 */
function searchLines(query: string, filePath: string, maxMatches: number): string[] {
	const backend = getSearchBackend();

	if (backend === "rg") {
		try {
			const output = execFileSync(
				"rg",
				["-i", "-F", "-m", String(maxMatches), query, filePath],
				{ encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
			);
			return output.trim().split("\n").filter(Boolean);
		} catch (err: any) {
			if (err.status === 1) return []; // no matches
			// rg failed — try grep
		}
	}

	if (backend === "rg" || backend === "grep") {
		try {
			const output = execFileSync(
				"grep",
				["-i", "-F", "-m", String(maxMatches), query, filePath],
				{ encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
			);
			return output.trim().split("\n").filter(Boolean);
		} catch (err: any) {
			if (err.status === 1) return []; // no matches
			// grep failed too — fall through to node
		}
	}

	// Node-native fallback
	return nodeSearchLines(query, filePath, maxMatches);
}

/** Node-native: find matching lines in a file */
function nodeSearchLines(query: string, filePath: string, maxMatches: number): string[] {
	try {
		const content = readFileSync(filePath, "utf-8");
		const queryLower = query.toLowerCase();
		const matches: string[] = [];
		for (const line of content.split("\n")) {
			if (matches.length >= maxMatches) break;
			if (line.toLowerCase().includes(queryLower)) {
				matches.push(line);
			}
		}
		return matches;
	} catch {
		return [];
	}
}

// ── Constants ────────────────────────────────────────────────────────────────

const QUERY_SYSTEM_PROMPT = `You are a session context assistant. Given the conversation history from a pi coding session and a question, provide a concise answer based on the session contents.

Focus on:
- Specific facts, decisions, and outcomes
- File paths and code changes mentioned
- Key context the user is asking about

Be concise and direct. If the information isn't in the session, say so.`;

const MAX_SEARCH_RESULTS = 10;
const MAX_SNIPPETS_PER_SESSION = 3;

// ── Extension ────────────────────────────────────────────────────────────────

export default function sessionRecallExtension(pi: ExtensionAPI) {
	// ── /session-recall command ────────────────────────────────────────────

	pi.registerCommand("session-recall", {
		description: "Configure the model used for session queries",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive mode required for /session-recall", "warning");
				return;
			}

			const config = loadConfig();
			const available = ctx.modelRegistry.getAvailable();

			if (available.length === 0) {
				ctx.ui.notify("No models available. Configure API keys first.", "warning");
				return;
			}

			const currentKey = config.queryModel
				? `${config.queryModel.provider}/${config.queryModel.id}`
				: null;

			// Build select items: session model fallback + all available models
			const SESSION_MODEL_VALUE = "__session_model__";
			const items: SelectItem[] = [
				{
					value: SESSION_MODEL_VALUE,
					label: "(use current session model)",
					description: currentKey === null ? "active" : undefined,
				},
				...available.map((m) => {
					const key = `${m.provider}/${m.id}`;
					return {
						value: key,
						label: key,
						description: key === currentKey ? "active" : undefined,
					};
				}),
			];

			const choice = await ctx.ui.custom<string | undefined>(
				(tui, theme, _kb, done) => {
					const selectTheme: SelectListTheme = {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("muted", t),
						noMatch: (t) => theme.fg("muted", t),
					};

					const container = new Container();
					const title = new Text(
						theme.bold("Query model for session_query") +
							theme.fg("muted", "  (type to filter)"),
						0,
						0,
					);
					const input = new Input();
					const listSpacer = new Spacer(1);
					const hint = new Text(
						theme.fg("muted", "  ↑/↓ navigate · Enter select · Esc cancel"),
						0,
						0,
					);

					// Fuzzy filter: every term must appear somewhere in the label
					const fuzzyMatch = (label: string, query: string): boolean => {
						const lower = label.toLowerCase();
						const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
						return terms.every((term) => lower.includes(term));
					};

					let list: SelectList;

					const buildList = (filtered: SelectItem[]): SelectList => {
						const sl = new SelectList(filtered, 10, selectTheme);
						sl.onSelect = (item) => done(item.value);
						sl.onCancel = () => done(undefined);
						return sl;
					};

					// Initial list with all items, pre-select active
					list = buildList(items);
					const activeIdx = items.findIndex(
						(i) => i.value === (currentKey ?? SESSION_MODEL_VALUE),
					);
					if (activeIdx >= 0) list.setSelectedIndex(activeIdx);

					container.addChild(title);
					container.addChild(new Spacer(1));
					container.addChild(input);
					container.addChild(listSpacer);
					container.addChild(list);
					container.addChild(new Spacer(1));
					container.addChild(hint);

					input.onSubmit = () => {
						const selected = list.getSelectedItem();
						if (selected) done(selected.value);
					};
					input.onEscape = () => done(undefined);

					const rebuildList = () => {
						const query = input.getValue();
						const filtered = query
							? items.filter((item) => fuzzyMatch(item.label, query))
							: items;

						container.removeChild(list);
						list = buildList(filtered);
						// Re-insert list at correct position (after listSpacer)
						const spacerIdx = container.children.indexOf(listSpacer);
						container.children.splice(spacerIdx + 1, 0, list);
						tui.requestRender();
					};

					container.handleInput = (data: string) => {
						// Navigation keys go to the select list
						const isNav =
							data === "\x1b[A" || // up
							data === "\x1b[B" || // down
							data === "\r" || // enter
							data === "\n";

						if (isNav) {
							list.handleInput(data);
						} else if (data === "\x1b" || data === "\x03") {
							done(undefined);
						} else {
							input.handleInput(data);
							rebuildList();
						}
					};

					return container;
				},
			);

			if (choice === undefined) return; // cancelled

			if (choice === SESSION_MODEL_VALUE) {
				delete config.queryModel;
				saveConfig(config);
				ctx.ui.notify("Session query will use the current session model", "info");
			} else {
				const slashIdx = choice.indexOf("/");
				if (slashIdx === -1) return;

				const provider = choice.slice(0, slashIdx);
				const id = choice.slice(slashIdx + 1);
				config.queryModel = { provider, id };
				saveConfig(config);
				ctx.ui.notify(`Session query model set to ${choice}`, "info");
			}
		},
	});

	// ── session_search tool ────────────────────────────────────────────────

	pi.registerTool({
		name: "session_search",
		label: (params) => `Session Search: ${params.query}`,
		description:
			"Find past sessions by literal text search. This is essentially `rg -i -F` over session JSONL files, not semantic search. " +
			"Use one exact token or phrase. Spaces are exact spaces in an exact phrase, so only use spaces for wording you expect appeared in the session, such as an error message. " +
			"Good examples: `libc++abi`, `Cannot find module '@sinclair/typebox'`, `Blender VAT bake`. " +
			"Bad example: `build ci c lib dependency ghostty` because that searches for one exact phrase, not separate keywords. " +
			"Do not combine independent keywords into one search string. If you need multiple unrelated terms, call session_search multiple times. " +
			"After finding a likely session, use session_query for semantic questions.",
		renderResult: (result, options, theme) => {
			const container = new Container();
			const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			const details = result.details as { matchCount?: number; query?: string; error?: boolean } | undefined;

			if (details?.error || !details?.matchCount) {
				container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
				return container;
			}

			const summary = `${details.matchCount} session${details.matchCount > 1 ? "s" : ""} matching "${details.query}"`;
			container.addChild(new Text(theme.fg("toolOutput", summary), 0, 0));

			if (options.expanded) {
				container.addChild(new Spacer(1));
				const body = text.replace(/^Found \d+ sessions? matching "[^"]*":\n\n/, "");
				container.addChild(
					new Markdown(body, 0, 0, getMarkdownTheme(), {
						color: (text: string) => theme.fg("toolOutput", text),
					}),
				);
			}

			return container;
		},
		parameters: Type.Object({
			query: Type.String({
				description:
					"Literal search pattern passed to fixed-string ripgrep-style search. Use one distinctive token or exact phrase, not a bag of unrelated keywords. Spaces mean exact spaces in an exact phrase.",
			}),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const { query } = params;
			const sessionsDir = getSessionsDir();

			const errorResult = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: { error: true },
			});

			if (!existsSync(sessionsDir)) {
				return errorResult("No sessions directory found.");
			}

			const allMatches = searchFiles(query, sessionsDir);

			if (allMatches.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`No sessions found matching "${query}".\n\n` +
								"session_search is literal fixed-string search, not semantic search. Retry with one exact distinctive token or phrase, such as a filename, package name, error text, function name, issue id, or unique term.",
						},
					],
					details: { matchCount: 0 },
				};
			}

			const fileMatches = allMatches
				.sort((a, b) => b.count - a.count || b.path.localeCompare(a.path))
				.slice(0, MAX_SEARCH_RESULTS);

			const results: string[] = [];

			for (const { path: filePath, count } of fileMatches) {
				if (signal?.aborted) break;

				const project = projectFromPath(filePath);
				const date = dateFromPath(filePath);

				const matchLines = searchLines(query, filePath, MAX_SNIPPETS_PER_SESSION);
				if (matchLines.length === 0) continue;

				const snippets: string[] = [];
				for (const line of matchLines) {
					const msg = extractMessageText(line);
					if (!msg) continue;
					const snippet = snippetAround(msg.text, query);
					snippets.push(`  [${msg.role}] ${snippet}`);
				}

				if (snippets.length === 0) continue;

				results.push(
					`**${date}** · \`${project}\` · ${count} match${count > 1 ? "es" : ""}\n` +
						`Session: \`${filePath}\`\n` +
						snippets.join("\n"),
				);
			}

			if (results.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`No readable matches found for "${query}".\n\n` +
								"session_search is literal fixed-string search, not semantic search. Retry with one exact distinctive token or phrase, such as a filename, package name, error text, function name, issue id, or unique term.",
						},
					],
					details: { matchCount: 0 },
				};
			}

			const output =
				`Found ${results.length} session${results.length > 1 ? "s" : ""} matching "${query}":\n\n` +
				results.join("\n\n---\n\n");

			return {
				content: [{ type: "text" as const, text: output }],
				details: { matchCount: results.length, query },
			};
		},
	});

	// ── session_query tool ─────────────────────────────────────────────────

	pi.registerTool({
		name: "session_query",
		label: (params) => `Session Query: ${params.question}`,
		description:
			"Query a specific session file to get detailed information. Use after session_search to dig into a particular session, " +
			"or when you already have a session path (e.g., from a handoff). Sends the full conversation to an LLM for analysis.",
		renderResult: (result, options, theme) => {
			const container = new Container();
			const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			const match = text.match(/\*\*Query:\*\* (.+?)\n\n---\n\n([\s\S]+)/);

			if (!match) {
				container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
				return container;
			}

			const [, query, answer] = match;

			if (options.expanded) {
				container.addChild(new Text(theme.bold("Query: ") + theme.fg("accent", query), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(
					new Markdown(answer.trim(), 0, 0, getMarkdownTheme(), {
						color: (text: string) => theme.fg("toolOutput", text),
					}),
				);
			} else {
				const firstLine = answer
					.trim()
					.split("\n")
					.find((l) => l.trim().length > 0 && !l.startsWith("#") && !l.startsWith("---"))
					?.trim() ?? query;
				const summary = firstLine.length > 120 ? firstLine.slice(0, 120) + "..." : firstLine;
				container.addChild(new Text(theme.fg("toolOutput", summary), 0, 0));
			}

			return container;
		},
		parameters: Type.Object({
			sessionPath: Type.String({
				description:
					"Full path to the session file (e.g., /home/user/.pi/agent/sessions/.../session.jsonl)",
			}),
			question: Type.String({
				description:
					"What you want to know about that session (e.g., 'What files were modified?' or 'What approach was chosen?')",
			}),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { sessionPath, question } = params;

			const errorResult = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: { error: true },
			});

			if (!sessionPath.endsWith(".jsonl")) {
				return errorResult(
					`Error: Invalid session path. Expected a .jsonl file, got: ${sessionPath}`,
				);
			}

			if (!existsSync(sessionPath)) {
				return errorResult(`Error: Session file not found: ${sessionPath}`);
			}

			onUpdate?.({
				content: [{ type: "text", text: `Query: ${question}` }],
				details: { status: "loading", question },
			});

			// Load the session
			let sessionManager: SessionManager;
			try {
				sessionManager = SessionManager.open(sessionPath);
			} catch (err) {
				return errorResult(`Error loading session: ${err}`);
			}

			const branch = sessionManager.getBranch();
			const messages = branch
				.filter(
					(entry): entry is SessionEntry & { type: "message" } =>
						entry.type === "message",
				)
				.map((entry) => entry.message);

			if (messages.length === 0) {
				return {
					content: [
						{ type: "text" as const, text: "Session is empty - no messages found." },
					],
					details: { empty: true },
				};
			}

			// Resolve query model: user config → current session model
			const queryModel = resolveQueryModel(ctx);
			if (!queryModel) {
				return errorResult(
					"Error: No model available to analyze the session. " +
						"Configure one with /session-recall or set up API keys.",
				);
			}

			// Serialize and check if we need windowing
			const llmMessages = convertToLlm(messages);
			const fullText = serializeConversation(llmMessages);
			const fullTokens = estimateTokens(fullText);

			// Reserve 20% of context for system prompt + question + response
			const tokenBudget = Math.floor(queryModel.contextWindow * 0.8);
			let conversationText: string;
			let wasWindowed = false;

			if (fullTokens <= tokenBudget) {
				conversationText = fullText;
			} else {
				const serialized: SerializedMessage[] = [];
				for (let i = 0; i < llmMessages.length; i++) {
					const msg = llmMessages[i];
					const text = serializeConversation([msg]);
					serialized.push({
						index: i,
						role: msg.role,
						text,
						charCount: text.length,
					});
				}
				conversationText = buildWindowedContext(serialized, question, tokenBudget);
				wasWindowed = true;
			}

			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(queryModel);
				if (!auth.ok) {
					return errorResult(`Error resolving model auth: ${auth.error}`);
				}

				const contextNote = wasWindowed
					? "\n\n**Note:** This is a large session. The conversation has been windowed to focus on sections most relevant to your question. Some messages were omitted (marked with [...])."
					: "";

				const userMessage: Message = {
					role: "user",
					content: [
						{
							type: "text",
							text: `## Session Conversation${contextNote}\n\n${conversationText}\n\n## Question\n\n${question}`,
						},
					],
					timestamp: Date.now(),
				};

				const response = await complete(
					queryModel,
					{ systemPrompt: QUERY_SYSTEM_PROMPT, messages: [userMessage] },
					{ apiKey: auth.apiKey, headers: auth.headers, signal },
				);

				if (response.stopReason === "aborted") {
					return {
						content: [
							{ type: "text" as const, text: "Query was cancelled." },
						],
						details: { cancelled: true },
					};
				}

				if (response.stopReason === "error" || response.content.length === 0) {
					return errorResult(
						`Error: LLM returned empty response (${response.stopReason}). Session may be too large even after windowing.`,
					);
				}

				const answer = response.content
					.filter(
						(c): c is { type: "text"; text: string } => c.type === "text",
					)
					.map((c) => c.text)
					.join("\n");

				const windowNote = wasWindowed ? ` · windowed` : "";
				return {
					content: [
						{
							type: "text" as const,
							text: `**Query:** ${question}\n\n---\n\n${answer}\n\n*Answered by ${queryModel.id} (${queryModel.provider})${windowNote}*`,
						},
					],
					details: {
						sessionPath,
						question,
						messageCount: messages.length,
						wasWindowed,
					},
				};
			} catch (err) {
				return errorResult(`Error querying session: ${err}`);
			}
		},
	});
}
