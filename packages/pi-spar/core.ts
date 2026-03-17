/**
 * Spar Core - Agent-to-agent communication via pi RPC
 * 
 * Extracted from pi-spar.ts for use as a native tool.
 */

import { spawn } from "child_process";
import * as readline from "readline";
import * as path from "path";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";

// =============================================================================
// Configuration
// =============================================================================

// Session storage in pi's config directory (persistent across reboots)
const SPAR_DIR = path.join(os.homedir(), ".pi", "agent", "spar");
const SESSION_DIR = path.join(SPAR_DIR, "sessions");
const CONFIG_PATH = path.join(SPAR_DIR, "config.json");

// Default timeout: 30 minutes (sliding - resets on activity)
export const DEFAULT_TIMEOUT = 1800000;

// Default tools for peer agent (read-only)
const DEFAULT_TOOLS = "read,grep,find,ls";

// =============================================================================
// Spar Config — user-configured models via /spar-models
// =============================================================================

export interface SparModelConfig {
	alias: string;     // short name like "gpt5", "opus"
	provider: string;  // pi provider like "openai", "anthropic"
	id: string;        // model id like "gpt-5.4", "claude-opus-4-6"
}

export interface SparConfig {
	models: SparModelConfig[];
}

export function loadSparConfig(): SparConfig {
	try {
		if (fs.existsSync(CONFIG_PATH)) {
			return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
		}
	} catch {}
	return { models: [] };
}

export function saveSparConfig(config: SparConfig): void {
	fs.mkdirSync(SPAR_DIR, { recursive: true });
	fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** Build alias → provider:model map from config */
function getModelAliases(): Record<string, string> {
	const config = loadSparConfig();
	const aliases: Record<string, string> = {};
	for (const m of config.models) {
		aliases[m.alias] = `${m.provider}:${m.id}`;
	}
	return aliases;
}

/** Get configured models for tool description */
export function getConfiguredModelsDescription(): string {
	const config = loadSparConfig();
	if (config.models.length === 0) {
		return "No models configured. Run /spar-models to set up sparring models.";
	}
	return config.models
		.map(m => `- \`${m.alias}\` - ${m.provider}/${m.id}`)
		.join("\n");
}

// =============================================================================
// Types
// =============================================================================

export interface SessionInfo {
	id: string;
	model: string;
	provider: string;
	modelId: string;
	thinking?: string;
	tools: string;
	sessionFile: string;
	createdAt: number;
	lastActivity?: number;
	messageCount?: number;
	status?: "active" | "closed" | "failed";
	error?: string;
	failedAt?: number;
	closedAt?: number;
}

export interface SendResult {
	response: string;
	usage?: {
		input: number;
		output: number;
		cost: number;
	};
}

export interface ProgressStatus {
	model: string;
	sessionId: string;
	startTime: number;
	status: "thinking" | "tool" | "streaming" | "done" | "error";
	toolName?: string;
	toolArgs?: string;
	elapsed?: number;
}

export interface SessionSummary {
	name: string;
	model: string;
	modelAlias?: string;
	messageCount: number;
	lastActivity: number;
	status: string;
}

// =============================================================================
// Directory Management
// =============================================================================

function ensureSessionDir(): void {
	fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function getSessionInfoPath(sessionId: string): string {
	return path.join(SESSION_DIR, `${sessionId}.info.json`);
}

function getSessionFilePath(sessionId: string): string {
	return path.join(SESSION_DIR, `${sessionId}.jsonl`);
}

function getSessionLogPath(sessionId: string): string {
	return path.join(SESSION_DIR, `${sessionId}.log`);
}

function getSocketPath(sessionId: string): string {
	return `/tmp/pi-spar-${sessionId}.sock`;
}

// =============================================================================
// Session Logger
// =============================================================================

class SessionLogger {
	private logPath: string;
	private stream: fs.WriteStream | null = null;

	constructor(sessionId: string) {
		this.logPath = getSessionLogPath(sessionId);
	}

	private timestamp(): string {
		return new Date().toISOString();
	}

	private write(level: string, category: string, message: string, data?: any) {
		const entry = {
			ts: this.timestamp(),
			level,
			category,
			message,
			...(data !== undefined ? { data } : {}),
		};
		const line = JSON.stringify(entry) + "\n";
		
		if (!this.stream) {
			this.stream = fs.createWriteStream(this.logPath, { flags: "a" });
		}
		this.stream.write(line);
		
		if (process.env.PI_SPAR_DEBUG) {
			console.error(`[${level}] ${category}: ${message}`, data ? JSON.stringify(data).slice(0, 200) : "");
		}
	}

	info(category: string, message: string, data?: any) { this.write("INFO", category, message, data); }
	error(category: string, message: string, data?: any) { this.write("ERROR", category, message, data); }
	warn(category: string, message: string, data?: any) { this.write("WARN", category, message, data); }
	debug(category: string, message: string, data?: any) { this.write("DEBUG", category, message, data); }

	rpcEvent(event: any) {
		this.write("DEBUG", "rpc-event", event.type, { 
			type: event.type,
			...(event.type === "tool_execution_start" ? { tool: event.toolName, args: event.args } : {}),
			...(event.type === "tool_execution_end" ? { tool: event.toolName } : {}),
			...(event.type === "response" ? { success: event.success, error: event.error, id: event.id } : {}),
			...(event.type === "message_end" ? { errorMessage: event.message?.errorMessage } : {}),
			...(event.type === "agent_end" ? { messageCount: event.messages?.length } : {}),
		});
	}

	stderr(chunk: string) { this.write("STDERR", "pi-process", chunk.trim()); }

	close() {
		if (this.stream) {
			this.stream.end();
			this.stream = null;
		}
	}
}

// =============================================================================
// Event Broadcaster (for peek extension)
// =============================================================================

class EventBroadcaster {
	private server: net.Server | null = null;
	private connections: net.Socket[] = [];
	private socketPath: string;
	
	// Track state for sync on connect
	private currentStatus: "thinking" | "streaming" | "tool" | "done" = "thinking";
	private currentToolName?: string;
	private currentPartialMessage: any = null; // The full partial AssistantMessage

	constructor(sessionId: string) {
		this.socketPath = getSocketPath(sessionId);
	}

	start(): void {
		try {
			if (fs.existsSync(this.socketPath)) {
				fs.unlinkSync(this.socketPath);
			}
		} catch {}

		this.server = net.createServer((conn) => {
			this.connections.push(conn);
			
			// Send sync event with current state to new client
			const syncEvent = {
				type: "sync",
				status: this.currentStatus,
				toolName: this.currentToolName,
				partialMessage: this.currentPartialMessage,
			};
			try { conn.write(JSON.stringify(syncEvent) + "\n"); } catch {}
			
			conn.on("close", () => {
				const idx = this.connections.indexOf(conn);
				if (idx >= 0) this.connections.splice(idx, 1);
			});
			conn.on("error", () => {
				const idx = this.connections.indexOf(conn);
				if (idx >= 0) this.connections.splice(idx, 1);
			});
		});

		this.server.listen(this.socketPath);
	}

	broadcast(event: any): void {
		// Track state for sync
		if (event.type === "message_start" && event.message?.role === "assistant") {
			this.currentPartialMessage = event.message;
			this.currentStatus = "thinking";
		} else if (event.type === "message_update" && event.message?.role === "assistant") {
			// event.message is the full accumulated partial AssistantMessage
			this.currentPartialMessage = event.message;
			const delta = event.assistantMessageEvent;
			if (delta?.type === "thinking_delta") {
				this.currentStatus = "thinking";
			} else if (delta?.type === "text_delta") {
				this.currentStatus = "streaming";
			}
		} else if (event.type === "tool_execution_start") {
			this.currentStatus = "tool";
			this.currentToolName = event.toolName;
		} else if (event.type === "message_end" || event.type === "agent_end") {
			this.currentPartialMessage = null;
			this.currentStatus = "done";
			this.currentToolName = undefined;
		}
		
		const line = JSON.stringify(event) + "\n";
		for (const conn of this.connections) {
			try { conn.write(line); } catch {}
		}
	}

	stop(): void {
		for (const conn of this.connections) {
			try { conn.end(); } catch {}
		}
		this.connections = [];
		
		if (this.server) {
			this.server.close();
			this.server = null;
		}
		
		try {
			if (fs.existsSync(this.socketPath)) {
				fs.unlinkSync(this.socketPath);
			}
		} catch {}
	}
}



// =============================================================================
// Session Management
// =============================================================================

function validateSessionName(name: string): void {
	if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
		throw new Error(`Invalid session name: "${name}". Only alphanumeric, hyphens, and underscores allowed.`);
	}
	if (name.length > 64) {
		throw new Error(`Session name too long (max 64 chars): "${name}"`);
	}
}

function saveSessionInfo(info: SessionInfo): void {
	ensureSessionDir();
	fs.writeFileSync(getSessionInfoPath(info.id), JSON.stringify(info, null, 2));
}

function loadSessionInfo(sessionId: string): SessionInfo | null {
	validateSessionName(sessionId);
	const infoPath = getSessionInfoPath(sessionId);
	if (!fs.existsSync(infoPath)) {
		return null;
	}
	return JSON.parse(fs.readFileSync(infoPath, "utf-8"));
}

function markSessionFailed(sessionId: string, error: string): void {
	try {
		const info = loadSessionInfo(sessionId);
		if (info) {
			info.status = "failed";
			info.error = error;
			info.failedAt = Date.now();
			saveSessionInfo(info);
		}
	} catch {}
}

function countSessionMessages(sessionFile: string): number {
	if (!fs.existsSync(sessionFile)) return 0;
	try {
		const content = fs.readFileSync(sessionFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		// Count user messages (approximate)
		let count = 0;
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "message" && entry.message?.role === "user") {
					count++;
				}
			} catch {}
		}
		return count;
	} catch {
		return 0;
	}
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Resolve model alias or provider:model string to components.
 * Accepts: "opus", "gpt5" (configured aliases), or "provider:model" directly.
 */
export function resolveModel(model: string): { provider: string; modelId: string; fullModel: string } {
	const aliases = getModelAliases();
	const fullModel = aliases[model] || model;
	const parts = fullModel.split(":");
	if (parts.length < 2) {
		const available = Object.keys(aliases);
		const hint = available.length > 0
			? `Use ${available.map(a => `"${a}"`).join(", ")}, or "provider:model".`
			: `Use "provider:model" format. Run /spar-models to configure aliases.`;
		throw new Error(`Invalid model: "${model}". ${hint}`);
	}
	return {
		provider: parts[0],
		modelId: parts.slice(1).join(":"),
		fullModel,
	};
}

/**
 * Get model alias from full model string (for display)
 */
export function getModelAlias(fullModel: string): string | undefined {
	const aliases = getModelAliases();
	for (const [alias, model] of Object.entries(aliases)) {
		if (model === fullModel) return alias;
	}
	return undefined;
}

/**
 * List all sessions
 */
export function listSessions(): SessionSummary[] {
	ensureSessionDir();
	const files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith(".info.json"));
	const sessions: SessionSummary[] = [];

	for (const file of files) {
		try {
			const info: SessionInfo = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, file), "utf-8"));
			const messageCount = info.messageCount ?? countSessionMessages(info.sessionFile);
			sessions.push({
				name: info.id,
				model: info.model,
				modelAlias: getModelAlias(info.model),
				messageCount,
				lastActivity: info.lastActivity ?? info.createdAt,
				status: info.status ?? "active",
			});
		} catch {}
	}

	// Sort by last activity (most recent first)
	sessions.sort((a, b) => b.lastActivity - a.lastActivity);
	return sessions;
}

/**
 * Check if a session exists
 */
export function sessionExists(name: string): boolean {
	validateSessionName(name);
	return fs.existsSync(getSessionInfoPath(name));
}

/**
 * Get session info
 */
export function getSession(name: string): SessionInfo | null {
	return loadSessionInfo(name);
}

/**
 * Get session history (past exchanges)
 */
export interface Exchange {
	user: string;
	assistant: string;
}

export function getSessionHistory(name: string, count: number = 5): Exchange[] {
	validateSessionName(name);
	const sessionFile = getSessionFilePath(name);
	
	if (!fs.existsSync(sessionFile)) {
		return [];
	}
	
	const exchanges: Exchange[] = [];
	let currentUser: string | null = null;
	
	try {
		const content = fs.readFileSync(sessionFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type !== "message") continue;
				
				const msg = entry.message;
				if (msg?.role === "user") {
					// Extract text from user message
					currentUser = extractTextFromContent(msg.content);
				} else if (msg?.role === "assistant" && currentUser) {
					// Extract text from assistant message
					const assistantText = extractTextFromContent(msg.content);
					if (assistantText) {
						exchanges.push({ user: currentUser, assistant: assistantText });
						currentUser = null;
					}
				}
			} catch {}
		}
	} catch {}
	
	// Return last N exchanges
	return exchanges.slice(-count);
}

function extractTextFromContent(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c?.type === "text" && typeof c.text === "string")
			.map((c: any) => c.text)
			.join("\n\n");
	}
	return "";
}

/**
 * Create a new session
 */
export function createSession(name: string, model: string, thinking?: string): SessionInfo {
	validateSessionName(name);
	
	if (sessionExists(name)) {
		throw new Error(`Session "${name}" already exists.`);
	}

	const { provider, modelId, fullModel } = resolveModel(model);
	
	const info: SessionInfo = {
		id: name,
		model: fullModel,
		provider,
		modelId,
		thinking,
		tools: DEFAULT_TOOLS,
		sessionFile: getSessionFilePath(name),
		createdAt: Date.now(),
		messageCount: 0,
		status: "active",
	};

	saveSessionInfo(info);
	return info;
}

/**
 * Send a message to a session
 */
export async function sendMessage(
	sessionName: string,
	message: string,
	options: {
		model?: string;
		thinking?: string;
		timeout?: number;
		signal?: AbortSignal;
		onProgress?: (status: ProgressStatus) => void;
	} = {}
): Promise<SendResult> {
	validateSessionName(sessionName);
	
	let info = loadSessionInfo(sessionName);
	
	// Create session if it doesn't exist
	if (!info) {
		if (!options.model) {
			throw new Error(`Session "${sessionName}" doesn't exist. Provide a model to create it.`);
		}
		info = createSession(sessionName, options.model, options.thinking);
	}

	const timeout = options.timeout ?? DEFAULT_TIMEOUT;
	const result = await sendToAgent(message, info, timeout, options.onProgress, options.signal);

	// Update session info
	info.lastActivity = Date.now();
	info.messageCount = (info.messageCount ?? 0) + 1;
	saveSessionInfo(info);

	return result;
}

// =============================================================================
// Core: Send message to pi via RPC
// =============================================================================

function extractTextFromMessage(message: any): string {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c?.type === "text" && typeof c.text === "string")
			.map((c: any) => c.text)
			.join("\n\n");
	}
	return "";
}

async function sendToAgent(
	message: string,
	info: SessionInfo,
	timeout: number,
	onProgress?: (status: ProgressStatus) => void,
	signal?: AbortSignal,
): Promise<SendResult> {
	const piBin = process.env.PI_SPAR_PI_BIN || "pi";
	
	const logger = new SessionLogger(info.id);
	logger.info("session", "Starting sendToAgent", { 
		model: info.model, 
		timeout, 
		messageLength: message.length,
		messagePreview: message.slice(0, 200) + (message.length > 200 ? "..." : ""),
	});

	const broadcaster = new EventBroadcaster(info.id);
	broadcaster.start();

	const startTime = Date.now();
	const modelName = info.modelId;
	const sessionId = info.id;
	
	const updateProgress = (status: ProgressStatus) => {
		status.elapsed = Math.floor((Date.now() - status.startTime) / 1000);
		onProgress?.(status);
	};
	
	updateProgress({ model: modelName, sessionId, startTime, status: "thinking" });

	const args = [
		"--mode", "rpc",
		"--no-extensions",
		"--provider", info.provider,
		"--model", info.modelId,
		"--session", info.sessionFile,
	];

	if (info.thinking) {
		args.push("--thinking", info.thinking);
	}

	if (info.tools) {
		args.push("--tools", info.tools);
	}

	logger.info("spawn", "Spawning pi process", { bin: piBin, args });

	const proc = spawn(piBin, args, {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env },
	});

	let stderr = "";
	proc.stderr?.on("data", (data) => {
		const chunk = data.toString();
		stderr += chunk;
		logger.stderr(chunk);
	});

	const rl = readline.createInterface({
		input: proc.stdout!,
		terminal: false,
	});

	let responseText = "";
	let usage: SendResult["usage"];
	let agentMessages: any[] = [];
	let finished = false;

	let reqId = 0;
	const pending = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>();

	function sendCommand(command: Record<string, unknown>): Promise<any> {
		const id = `req-${++reqId}`;
		const payload = JSON.stringify({ id, ...command });
		proc.stdin!.write(payload + "\n");
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
		});
	}

	let resolveDone!: () => void;
	let rejectDone!: (err: Error) => void;
	const donePromise = new Promise<void>((resolve, reject) => {
		resolveDone = resolve;
		rejectDone = reject;
	});

	// Handle abort signal (user pressed Escape)
	if (signal) {
		if (signal.aborted) {
			proc.kill("SIGTERM");
			broadcaster.stop();
			logger.close();
			throw new Error("Cancelled");
		}
		signal.addEventListener("abort", () => {
			logger.info("abort", "Cancelled by user");
			finished = true;
			proc.kill("SIGTERM");
			rejectDone(new Error("Cancelled"));
		}, { once: true });
	}

	rl.on("line", (line) => {
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			logger.debug("parse", "Non-JSON line from pi", { line: line.slice(0, 200) });
			return;
		}

		logger.rpcEvent(event);
		broadcaster.broadcast(event);

		if (event.type === "response") {
			const waiter = event.id ? pending.get(event.id) : undefined;
			if (event.id) pending.delete(event.id);

			if (waiter) {
				if (!event.success) {
					const err = event.error || "Unknown error";
					logger.error("rpc-response", `Command failed: ${err}`, { id: event.id });
					waiter.reject(new Error(err));
				} else {
					waiter.resolve(event.data);
				}
			} else if (!event.success) {
				const err = event.error || "Unknown error";
				logger.error("rpc-response", `Untracked error response: ${err}`, event);
				rejectDone(new Error(err));
			}
			return;
		}

		if (event.type === "message_update") {
			const delta = event.assistantMessageEvent;
			if (delta?.type === "text_delta") {
				responseText += delta.delta;
				resetTimeout("text_delta");
				updateProgress({ model: modelName, sessionId, startTime, status: "streaming" });
			}
			if (delta?.type === "thinking_delta") {
				resetTimeout("thinking_delta");
				updateProgress({ model: modelName, sessionId, startTime, status: "thinking" });
			}
			if (delta?.type === "error") {
				const err = delta.reason ?? "Streaming error";
				logger.error("streaming", `Streaming error: ${err}`, delta);
				rejectDone(new Error(err));
			}
			return;
		}

		if (event.type === "message_end") {
			const msg = event.message;
			if (msg?.errorMessage) {
				logger.error("message-end", `Message error: ${msg.errorMessage}`, msg);
				rejectDone(new Error(msg.errorMessage));
			}
			return;
		}

		if (event.type === "tool_execution_start") {
			resetTimeout(`tool_start:${event.toolName}`);
			logger.info("tool", `Tool started: ${event.toolName}`, { args: event.args });
			updateProgress({ 
				model: modelName, 
				sessionId,
				startTime, 
				status: "tool",
				toolName: event.toolName,
				toolArgs: JSON.stringify(event.args || {}).slice(0, 100)
			});
			return;
		}
		if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
			resetTimeout(`tool_${event.type}`);
			return;
		}

		if (event.type === "agent_end") {
			agentMessages = event.messages || [];

			usage = { input: 0, output: 0, cost: 0 };
			for (const msg of agentMessages) {
				if (msg.role === "assistant" && msg.usage) {
					usage.input += msg.usage.input || 0;
					usage.output += msg.usage.output || 0;
					usage.cost += msg.usage.cost?.total || 0;
				}
			}

			if (responseText.trim() === "") {
				const lastAssistant = [...agentMessages].reverse().find((m: any) => m?.role === "assistant");
				responseText = extractTextFromMessage(lastAssistant);
			}

			logger.info("complete", "Agent completed", { 
				usage, 
				responseLength: responseText.length,
				messageCount: agentMessages.length,
			});
			finished = true;
			resolveDone();
			return;
		}

		if (event.type === "hook_error") {
			const err = `Hook error: ${event.error || "Unknown"}`;
			logger.error("hook", err, event);
			rejectDone(new Error(err));
		}
	});

	proc.on("exit", (code, signal) => {
		if (!finished) {
			const err = `pi process exited unexpectedly (code=${code}, signal=${signal})`;
			logger.error("exit", err, { code, signal, stderr });
			rejectDone(new Error(`${err}\nStderr: ${stderr}`));
		}
	});

	let timeoutHandle: ReturnType<typeof setTimeout>;
	let timeoutReject: (err: Error) => void;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutReject = reject;
		timeoutHandle = setTimeout(() => {
			const err = `Timeout after ${timeout}ms waiting for response`;
			logger.error("timeout", err, { stderr, elapsed: Date.now() - startTime });
			reject(new Error(`${err}\nStderr: ${stderr}`));
		}, timeout);
	});

	let lastResetAt = startTime;
	let resetCount = 0;
	
	function resetTimeout(reason: string) {
		clearTimeout(timeoutHandle);
		resetCount++;
		const now = Date.now();
		lastResetAt = now;
		logger.debug("timeout-reset", `Reset #${resetCount}: ${reason}`, { 
			elapsed: now - startTime,
		});
		timeoutHandle = setTimeout(() => {
			const err = `Timeout after ${timeout}ms of inactivity`;
			logger.error("timeout", err, { 
				stderr, 
				elapsed: Date.now() - startTime,
				resetCount,
			});
			timeoutReject(new Error(`${err}\nStderr: ${stderr}`));
		}, timeout);
	}

	try {
		await Promise.race([sendCommand({ type: "get_state" }), timeoutPromise]);
		await Promise.race([sendCommand({ type: "prompt", message }), timeoutPromise]);
		await Promise.race([donePromise, timeoutPromise]);

		logger.info("session", "sendToAgent completed successfully", { elapsed: Date.now() - startTime });
		return {
			response: responseText.trim(),
			usage,
		};
	} catch (err: any) {
		logger.error("session", `sendToAgent failed: ${err.message}`, { 
			elapsed: Date.now() - startTime,
			stderr,
		});
		markSessionFailed(info.id, err.message);
		throw err;
	} finally {
		clearTimeout(timeoutHandle!);
		broadcaster.stop();
		logger.close();
		rl.close();
		proc.stdin?.end();
		proc.kill("SIGTERM");
	}
}
