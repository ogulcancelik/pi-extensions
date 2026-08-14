import { createHash } from "node:crypto";
import {
	buildSessionContext,
	convertToLlm,
	sessionEntryToContextMessages,
	type SessionEntry,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { calculateCost, type Message, type Model, type Usage } from "@earendil-works/pi-ai";

export const NATIVE_COMPACTION_KIND = "openai-codex-native-compaction";
export const NATIVE_COMPACTION_VERSION = 1;
export const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";
export const RETAINED_USER_TOKEN_BUDGET = 64_000;

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const MAX_REMOTE_RETRIES = 2;

export type JsonObject = Record<string, unknown>;
export type ResponseItem = JsonObject & { type?: string };

export interface NativeCompactionDetails {
	kind: typeof NATIVE_COMPACTION_KIND;
	version: typeof NATIVE_COMPACTION_VERSION;
	modelKey: string;
	replacementHistory: ResponseItem[];
}

export type NativeCheckpoint = {
	entryIndex: number;
	entryId: string;
	details: NativeCompactionDetails;
};

export type CheckpointLookup =
	| { status: "none" }
	| { status: "invalid"; entryIndex: number; entryId: string }
	| { status: "valid"; checkpoint: NativeCheckpoint };

export type RemoteCompactionResult = {
	compactionItem: ResponseItem;
	usage?: Usage;
};

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOpenAICodexModel(model: unknown): model is Model<"openai-codex-responses"> {
	if (!isJsonObject(model)) return false;
	return model.provider === "openai-codex" && model.api === "openai-codex-responses";
}

export function modelKey(model: Pick<Model<any>, "provider" | "api" | "id">): string {
	return `${model.provider}:${model.api}:${model.id}`;
}

function cloneItem<T>(value: T): T {
	return structuredClone(value);
}

function isResponseItem(value: unknown): value is ResponseItem {
	if (!isJsonObject(value)) return false;
	return typeof value.type === "string" || (
		typeof value.role === "string" && (typeof value.content === "string" || Array.isArray(value.content))
	);
}

export function parseNativeCompactionDetails(value: unknown): NativeCompactionDetails | undefined {
	if (!isJsonObject(value)) return undefined;
	if (value.kind !== NATIVE_COMPACTION_KIND || value.version !== NATIVE_COMPACTION_VERSION) return undefined;
	if (typeof value.modelKey !== "string" || !Array.isArray(value.replacementHistory)) return undefined;

	const replacementHistory = value.replacementHistory.filter(isResponseItem);
	if (replacementHistory.length !== value.replacementHistory.length || replacementHistory.length === 0) return undefined;
	const compactionItems = replacementHistory.filter((item) => item.type === "compaction");
	if (
		compactionItems.length !== 1 ||
		typeof compactionItems[0]?.encrypted_content !== "string" ||
		replacementHistory.at(-1)?.type !== "compaction"
	) {
		return undefined;
	}

	return {
		kind: NATIVE_COMPACTION_KIND,
		version: NATIVE_COMPACTION_VERSION,
		modelKey: value.modelKey,
		replacementHistory: replacementHistory.map(cloneItem),
	};
}

export function findNativeCheckpoint(branch: SessionEntry[]): CheckpointLookup {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!entry) continue;

		let rawDetails: unknown;
		if (entry.type === "compaction") {
			if (!isJsonObject(entry.details) || entry.details.kind !== NATIVE_COMPACTION_KIND) {
				return { status: "none" };
			}
			rawDetails = entry.details;
		} else if (entry.type === "custom" && entry.customType === NATIVE_COMPACTION_KIND) {
			rawDetails = entry.data;
		} else {
			continue;
		}

		const details = parseNativeCompactionDetails(rawDetails);
		if (!details) return { status: "invalid", entryIndex: index, entryId: entry.id };
		return {
			status: "valid",
			checkpoint: { entryIndex: index, entryId: entry.id, details },
		};
	}
	return { status: "none" };
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizedItemId(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64).replace(/_+$/, "");
	return sanitized.startsWith("fc_") ? sanitized : `fc_${sanitized}`.slice(0, 64);
}

// The Responses API rejects call_ids longer than 64 characters. Hashing avoids
// the deterministic prefix collisions caused by truncation, and the stable
// mapping keeps function_call/function_call_output pairs matched since both
// sides derive from the same source id.
function normalizedCallId(value: string): string {
	return value.length <= 64 ? value : `call_${shortHash(value)}`;
}

function textSignature(value: unknown): { id?: string; phase?: "commentary" | "final_answer" } {
	if (typeof value !== "string" || !value) return {};
	try {
		const parsed = JSON.parse(value) as JsonObject;
		return {
			id: typeof parsed.id === "string" ? parsed.id : undefined,
			phase: parsed.phase === "commentary" || parsed.phase === "final_answer" ? parsed.phase : undefined,
		};
	} catch {
		return { id: value };
	}
}

function contentToUserParts(content: unknown): unknown[] {
	if (typeof content === "string") return content ? [{ type: "input_text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	const parts: unknown[] = [];
	for (const part of content) {
		if (!isJsonObject(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			parts.push({ type: "input_text", text: part.text });
		} else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			parts.push({ type: "input_image", detail: "auto", image_url: `data:${part.mimeType};base64,${part.data}` });
		}
	}
	return parts;
}

function toolResultOutput(message: JsonObject, model: Model<any>): unknown {
	const content = Array.isArray(message.content) ? message.content : [];
	const text = content
		.flatMap((part) => isJsonObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])
		.join("\n");
	const images = content.filter((part) => isJsonObject(part) && part.type === "image");
	if (images.length === 0 || !model.input.includes("image")) {
		return text || (images.length > 0 ? "(see attached image)" : "(no tool output)");
	}
	return [
		...(text ? [{ type: "input_text", text }] : []),
		...images.flatMap((part) =>
			typeof part.data === "string" && typeof part.mimeType === "string"
				? [{ type: "input_image", detail: "auto", image_url: `data:${part.mimeType};base64,${part.data}` }]
				: [],
		),
	];
}

function responseTool(tool: ToolInfo, deferLoading = false): JsonObject {
	return {
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as unknown,
		strict: null,
		...(deferLoading ? { defer_loading: true } : {}),
	};
}

function messagesToResponseItems(model: Model<any>, messages: Message[], tools: ToolInfo[]): ResponseItem[] {
	const items: ResponseItem[] = [];
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	const pendingToolCalls = new Map<string, string>();
	const flushOrphanedToolCalls = () => {
		for (const callId of pendingToolCalls.values()) {
			items.push({ type: "function_call_output", call_id: callId, output: "No result provided" });
		}
		pendingToolCalls.clear();
	};
	let messageIndex = 0;

	for (const message of messages as unknown as JsonObject[]) {
		if (message.role === "user") {
			flushOrphanedToolCalls();
			const content = contentToUserParts(message.content);
			if (content.length > 0) items.push({ role: "user", content });
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			flushOrphanedToolCalls();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				messageIndex++;
				continue;
			}
			let textIndex = 0;
			for (const block of message.content) {
				if (!isJsonObject(block)) continue;
				if (block.type === "thinking" && typeof block.thinkingSignature === "string") {
					try {
						const reasoning = JSON.parse(block.thinkingSignature);
						if (isJsonObject(reasoning) && reasoning.type === "reasoning") items.push(cloneItem(reasoning));
					} catch {}
					continue;
				}
				if (block.type === "text" && typeof block.text === "string") {
					const signature = textSignature(block.textSignature);
					const fallbackId = textIndex === 0 ? `msg_pi_${messageIndex}` : `msg_pi_${messageIndex}_${textIndex}`;
					textIndex++;
					const rawId = signature.id || fallbackId;
					const id = rawId.length <= 64 ? rawId : `msg_${shortHash(rawId)}`;
					items.push({
						type: "message",
						role: "assistant",
						id,
						status: "completed",
						content: [{ type: "output_text", text: block.text, annotations: [] }],
						...(signature.phase ? { phase: signature.phase } : {}),
					});
					continue;
				}
				if (block.type === "toolCall" && typeof block.id === "string") {
					const [rawCallId, rawItemId] = block.id.split("|");
					const callId = normalizedCallId(rawCallId);
					pendingToolCalls.set(block.id, callId);
					items.push({
						type: "function_call",
						call_id: callId,
						...(normalizedItemId(rawItemId) ? { id: normalizedItemId(rawItemId) } : {}),
						name: String(block.name ?? ""),
						arguments: JSON.stringify(block.arguments ?? {}),
					});
				}
			}
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const [rawCallId] = message.toolCallId.split("|");
			const callId = normalizedCallId(rawCallId);
			pendingToolCalls.delete(message.toolCallId);
			items.push({ type: "function_call_output", call_id: callId, output: toolResultOutput(message, model) });

			const addedTools = Array.isArray(message.addedToolNames)
				? message.addedToolNames.flatMap((name) => typeof name === "string" && toolsByName.has(name) ? [toolsByName.get(name)!] : [])
				: [];
			if (addedTools.length > 0) {
				const searchCallId = `pi_tool_load_${shortHash(`${message.toolCallId}:${addedTools.map((tool) => tool.name).join(",")}`)}`;
				items.push({
					type: "tool_search_call",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					arguments: { query: addedTools.map((tool) => tool.name).join(" "), limit: addedTools.length },
				});
				items.push({
					type: "tool_search_output",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					tools: addedTools.map((tool) => responseTool(tool, true)),
				});
			}
		}
		messageIndex++;
	}
	flushOrphanedToolCalls();

	return items;
}

function entriesToResponseItems(model: Model<any>, entries: SessionEntry[], tools: ToolInfo[]): ResponseItem[] {
	const messages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
	return messagesToResponseItems(model, convertToLlm(messages), tools);
}

export function effectiveInputForBranch(params: {
	branch: SessionEntry[];
	model: Model<any>;
	tools: ToolInfo[];
	excludeLastAssistantError?: boolean;
}): ResponseItem[] {
	let branch = params.branch;
	if (params.excludeLastAssistantError) {
		const lastAssistantIndex = branch.findLastIndex(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		if (lastAssistantIndex >= 0) {
			branch = branch.filter((_entry, index) => index !== lastAssistantIndex);
		}
	}

	const checkpoint = findNativeCheckpoint(branch);
	if (checkpoint.status === "invalid") {
		throw new Error("The latest OpenAI Codex native compaction checkpoint is malformed.");
	}
	if (checkpoint.status === "valid") {
		if (checkpoint.checkpoint.details.modelKey !== modelKey(params.model)) {
			throw new Error("The latest OpenAI Codex native compaction checkpoint belongs to a different model.");
		}
		const tail = branch.slice(checkpoint.checkpoint.entryIndex + 1);
		return [
			...checkpoint.checkpoint.details.replacementHistory.map(cloneItem),
			...entriesToResponseItems(params.model, tail, params.tools),
		];
	}

	const context = buildSessionContext(branch);
	return messagesToResponseItems(params.model, convertToLlm(context.messages), params.tools);
}

function responseItemText(item: ResponseItem): string {
	if (item.type !== "message" && item.type !== undefined) return "";
	if (typeof item.content === "string") return item.content;
	if (!Array.isArray(item.content)) return "";
	return item.content
		.flatMap((part) =>
			isJsonObject(part) && typeof part.text === "string" ? [part.text] : [],
		)
		.join("");
}

function approximateTokens(item: ResponseItem): number {
	return Math.max(1, Math.ceil(responseItemText(item).length / 4));
}

function truncateMiddle(text: string, maxCharacters: number): string {
	if (text.length <= maxCharacters) return text;
	if (maxCharacters <= 1) return text.slice(-maxCharacters);
	const marker = "…";
	const available = Math.max(0, maxCharacters - marker.length);
	const head = Math.ceil(available / 2);
	const tail = Math.floor(available / 2);
	return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`;
}

function truncateMessage(item: ResponseItem, maxTokens: number): ResponseItem | undefined {
	if ((item.type !== "message" && item.type !== undefined) || maxTokens <= 0) return undefined;
	const copy = cloneItem(item);
	let remainingCharacters = maxTokens * 4;

	if (typeof copy.content === "string") {
		copy.content = truncateMiddle(copy.content, remainingCharacters);
		return copy.content ? copy : undefined;
	}
	if (!Array.isArray(copy.content)) return copy;

	const content = copy.content;
	const textParts = content.filter((part) => isJsonObject(part) && typeof part.text === "string");
	const totalText = textParts.reduce((sum, part) => sum + String(part.text).length, 0);
	let consumed = 0;
	const truncatedContent = content.flatMap((part) => {
		if (!isJsonObject(part) || typeof part.text !== "string") return [part];
		const remainingText = totalText - consumed;
		const partBudget = remainingText === 0 ? 0 : Math.floor((part.text.length / remainingText) * remainingCharacters);
		const text = truncateMiddle(part.text, partBudget);
		consumed += part.text.length;
		remainingCharacters -= partBudget;
		return text ? [{ ...part, text }] : [];
	});
	copy.content = truncatedContent;
	return truncatedContent.length > 0 ? copy : undefined;
}

export function retainRecentUserMessages(items: ResponseItem[], maxTokens = RETAINED_USER_TOKEN_BUDGET): ResponseItem[] {
	let remaining = maxTokens;
	const retained: ResponseItem[] = [];
	for (const item of [...items].reverse()) {
		if (remaining <= 0) break;
		if ((item.type !== "message" && item.type !== undefined) || item.role !== "user" || !responseItemText(item).trim()) continue;
		const tokens = approximateTokens(item);
		if (tokens <= remaining) {
			retained.push(cloneItem(item));
			remaining -= tokens;
			continue;
		}
		const truncated = truncateMessage(item, remaining);
		if (truncated) retained.push(truncated);
		remaining = 0;
	}
	return retained.reverse();
}

export function buildReplacementHistory(
	preCompactionInput: ResponseItem[],
	compactionItem: ResponseItem,
): ResponseItem[] {
	if (compactionItem.type !== "compaction" || typeof compactionItem.encrypted_content !== "string") {
		throw new Error("OpenAI Codex did not return a valid compaction item.");
	}
	return [...retainRecentUserMessages(preCompactionInput), cloneItem(compactionItem)];
}

export function buildToolPayload(allTools: ToolInfo[], activeToolNames: string[]): unknown[] | undefined {
	const active = new Set(activeToolNames);
	const tools = allTools.filter((tool) => active.has(tool.name));
	return tools.length > 0 ? tools.map((tool) => responseTool(tool)) : undefined;
}

export function buildCompactionRequestBody(params: {
	basePayload?: JsonObject;
	model: Model<any>;
	input: ResponseItem[];
	instructions: string;
	tools?: unknown[];
	sessionId: string;
}): JsonObject {
	const base = params.basePayload ? cloneItem(params.basePayload) : {};
	const previousText = isJsonObject(base.text) ? base.text : undefined;
	const include = Array.isArray(base.include)
		? [...new Set([...base.include.filter((value): value is string => typeof value === "string"), "reasoning.encrypted_content"])]
		: ["reasoning.encrypted_content"];

	const body: JsonObject = {
		...base,
		model: params.model.id,
		store: false,
		stream: true,
		instructions: params.instructions,
		input: [...params.input.map(cloneItem), { type: "compaction_trigger" }],
		tool_choice: "auto",
		parallel_tool_calls: true,
		include,
		prompt_cache_key: params.sessionId,
		text: previousText && typeof previousText.verbosity === "string"
			? { verbosity: previousText.verbosity }
			: { verbosity: "low" },
	};
	if (params.tools) body.tools = params.tools;
	else delete body.tools;
	delete body.messages;
	delete body.previous_response_id;
	return body;
}

export function resolveCodexResponsesUrl(baseUrl?: string): string {
	const normalized = (baseUrl?.trim() || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

export function extractCodexAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as JsonObject;
		const auth = payload["https://api.openai.com/auth"];
		if (!isJsonObject(auth) || typeof auth.chatgpt_account_id !== "string") throw new Error("Missing account ID");
		return auth.chatgpt_account_id;
	} catch {
		throw new Error("Failed to extract the ChatGPT account ID from the OpenAI Codex token.");
	}
}

export function mergeFeatureHeader(existing: string | null | undefined): string {
	const features = (existing ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	return [...new Set([...features, REMOTE_COMPACTION_FEATURE])].join(",");
}

export function buildCodexHeaders(params: {
	apiKey: string;
	headers?: Record<string, string>;
	sessionId: string;
}): Headers {
	const headers = new Headers(params.headers);
	headers.set("authorization", `Bearer ${params.apiKey}`);
	headers.set("chatgpt-account-id", extractCodexAccountId(params.apiKey));
	headers.set("originator", "pi");
	headers.set("user-agent", "pi-codex-compaction");
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	headers.set("session-id", params.sessionId);
	headers.set("x-client-request-id", params.sessionId);
	headers.set("x-codex-beta-features", mergeFeatureHeader(headers.get("x-codex-beta-features")));
	return headers;
}

function parseRetryDelay(response: Response): number | undefined {
	const milliseconds = Number(response.headers.get("retry-after-ms"));
	if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
	const retryAfter = response.headers.get("retry-after");
	if (!retryAfter) return undefined;
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(retryAfter);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

class NonRetryableCompactionError extends Error {}
class RetryableCompactionStreamError extends Error {}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Compaction aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function parseSseResponse(response: Response): Promise<{ item: ResponseItem; usage?: unknown }> {
	if (!response.body) throw new Error("OpenAI Codex returned an empty compaction stream.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let completed = false;
	let usage: unknown;
	const compactionItems: ResponseItem[] = [];

	const processBlock = (block: string) => {
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
			.trim();
		if (!data || data === "[DONE]") return;
		let event: unknown;
		try {
			event = JSON.parse(data);
		} catch {
			throw new NonRetryableCompactionError("OpenAI Codex returned malformed compaction SSE data.");
		}
		if (!isJsonObject(event)) return;
		if (event.type === "error") {
			if (typeof event.message !== "string" || !event.message.trim()) {
				throw new RetryableCompactionStreamError("OpenAI Codex compaction failed.");
			}
			throw new NonRetryableCompactionError(event.message);
		}
		if (event.type === "response.failed") {
			throw new NonRetryableCompactionError("OpenAI Codex compaction ended with response.failed.");
		}
		if (event.type === "response.incomplete") {
			throw new RetryableCompactionStreamError("OpenAI Codex compaction ended with response.incomplete.");
		}
		if (event.type === "response.output_item.done" && isResponseItem(event.item) && event.item.type === "compaction") {
			compactionItems.push(event.item);
		}
		if (event.type === "response.completed" || event.type === "response.done") {
			completed = true;
			usage = isJsonObject(event.response) ? event.response.usage : undefined;
		}
	};

	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		buffer = buffer.replace(/\r\n/g, "\n");
		let boundary = buffer.indexOf("\n\n");
		while (boundary >= 0) {
			processBlock(buffer.slice(0, boundary));
			buffer = buffer.slice(boundary + 2);
			boundary = buffer.indexOf("\n\n");
		}
		if (done) break;
	}
	if (buffer.trim()) processBlock(buffer);
	if (!completed) {
		throw new RetryableCompactionStreamError(
			"OpenAI Codex compaction stream closed before response.completed.",
		);
	}
	if (compactionItems.length !== 1) {
		throw new NonRetryableCompactionError(
			`OpenAI Codex returned ${compactionItems.length} compaction items; expected exactly one.`,
		);
	}
	const item = compactionItems[0]!;
	if (typeof item.encrypted_content !== "string") {
		throw new NonRetryableCompactionError(
			"OpenAI Codex returned a compaction item without encrypted_content.",
		);
	}
	return { item, usage };
}

function usageFromResponse(model: Model<any>, value: unknown): Usage | undefined {
	if (!isJsonObject(value)) return undefined;
	const inputTokens = typeof value.input_tokens === "number" ? value.input_tokens : 0;
	const outputTokens = typeof value.output_tokens === "number" ? value.output_tokens : 0;
	const details = isJsonObject(value.input_tokens_details) ? value.input_tokens_details : undefined;
	const cacheRead = typeof details?.cached_tokens === "number" ? details.cached_tokens : 0;
	const cacheWrite = typeof details?.cache_write_tokens === "number" ? details.cache_write_tokens : 0;
	const usage: Usage = {
		input: Math.max(0, inputTokens - cacheRead - cacheWrite),
		output: outputTokens,
		cacheRead,
		cacheWrite,
		totalTokens: typeof value.total_tokens === "number" ? value.total_tokens : inputTokens + outputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

export async function callRemoteCompaction(params: {
	url: string;
	headers: Headers;
	body: JsonObject;
	model: Model<any>;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}): Promise<RemoteCompactionResult> {
	const fetchImpl = params.fetchImpl ?? fetch;
	let lastError: unknown;
	for (let attempt = 0; attempt <= MAX_REMOTE_RETRIES; attempt++) {
		try {
			const response = await fetchImpl(params.url, {
				method: "POST",
				headers: params.headers,
				body: JSON.stringify(params.body),
				signal: params.signal,
			});
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				const message = `OpenAI Codex compaction failed (${response.status}): ${body || response.statusText}`;
				if (!isRetryableStatus(response.status)) throw new NonRetryableCompactionError(message);
				const error = new Error(message);
				if (attempt === MAX_REMOTE_RETRIES) throw error;
				lastError = error;
				await delay(parseRetryDelay(response) ?? 1000 * 2 ** attempt, params.signal);
				continue;
			}
			const parsed = await parseSseResponse(response);
			return { compactionItem: parsed.item, usage: usageFromResponse(params.model, parsed.usage) };
		} catch (error) {
			if (params.signal?.aborted || error instanceof NonRetryableCompactionError) throw error;
			lastError = error;
			if (attempt === MAX_REMOTE_RETRIES) throw error;
			await delay(1000 * 2 ** attempt, params.signal);
		}
	}
	throw lastError instanceof Error ? lastError : new Error("OpenAI Codex compaction failed.");
}

export function stripInputFromPayload(payload: JsonObject): JsonObject {
	const shape = cloneItem(payload);
	delete shape.input;
	delete shape.messages;
	delete shape.previous_response_id;
	return shape;
}
