import { afterEach, describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import codexCompactionExtension from "./index.ts";
import {
	buildReplacementHistory,
	effectiveInputForBranch,
	findNativeCheckpoint,
	mergeFeatureHeader,
	NATIVE_COMPACTION_KIND,
	NATIVE_COMPACTION_VERSION,
	retainRecentUserMessages,
	type JsonObject,
} from "./native-compaction.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function token(): string {
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
	})).toString("base64url");
	return `header.${payload}.signature`;
}

const model = {
	id: "gpt-test",
	name: "GPT Test",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 16_384,
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0, total: 0 },
} as any;

function userEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
	} as SessionEntry;
}

function extensionHarness(initialBranch: SessionEntry[]) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const entryRenderers = new Map<string, (...args: any[]) => any>();
	let branch = initialBranch;
	let aborted = false;
	let hasPendingMessages = false;
	let idle = false;
	let usageTokens = 40_000;
	let customEntryId = 0;
	const notifications: string[] = [];
	const compactionRequests: any[] = [];
	const sentUserMessages: Array<{ content: string; options: any }> = [];
	const pi = {
		on(name: string, handler: (...args: any[]) => any) {
			handlers.set(name, handler);
		},
		getAllTools: () => [],
		getActiveTools: () => [],
		registerEntryRenderer(customType: string, renderer: (...args: any[]) => any) {
			entryRenderers.set(customType, renderer);
		},
		appendEntry(customType: string, data: unknown) {
			branch = [...branch, {
				type: "custom",
				id: `custom-${++customEntryId}`,
				parentId: branch.at(-1)?.id ?? null,
				timestamp: new Date().toISOString(),
				customType,
				data,
			} as SessionEntry];
		},
		sendUserMessage(content: string, options?: any) {
			sentUserMessages.push({ content, options });
		},
	} as any;
	codexCompactionExtension(pi);

	const context = {
		model,
		mode: "tui",
		cwd: "/var/tmp/pi-codex-compaction-test",
		signal: new AbortController().signal,
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message) },
		abort: () => { aborted = true; },
		compact: (options: any) => { compactionRequests.push(options); },
		isIdle: () => idle,
		isProjectTrusted: () => false,
		hasPendingMessages: () => hasPendingMessages,
		getContextUsage: () => ({
			tokens: usageTokens,
			contextWindow: model.contextWindow,
			percent: (usageTokens / model.contextWindow) * 100,
		}),
		getSystemPrompt: () => "You are Codex.",
		sessionManager: {
			getSessionId: () => "session-123",
			getBranch: () => branch,
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token(), headers: {} }),
			getProviderAuth: async () => ({ auth: { apiKey: token(), baseUrl: model.baseUrl } }),
			getProvider: () => ({ baseUrl: model.baseUrl }),
		},
	};

	return {
		handlers,
		context,
		setBranch(next: SessionEntry[]) { branch = next; },
		setHasPendingMessages(pending: boolean) { hasPendingMessages = pending; },
		setIdle(value: boolean) { idle = value; },
		setUsageTokens(tokens: number) { usageTokens = tokens; },
		getBranch() { return branch; },
		get aborted() { return aborted; },
		entryRenderers,
		notifications,
		compactionRequests,
		sentUserMessages,
	};
}

function compactionSse(encryptedContent = "opaque-state"): Response {
	const events = [
		{
			type: "response.output_item.done",
			item: { type: "compaction", id: "cmp_1", encrypted_content: encryptedContent },
		},
		{
			type: "response.completed",
			response: {
				usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
			},
		},
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("pi-codex-compaction", () => {
	test("runs native compaction and never replays the local marker", async () => {
		let requestBody: JsonObject | undefined;
		let requestHeaders: Headers | undefined;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body));
			requestHeaders = new Headers(init?.headers);
			return compactionSse();
		}) as typeof fetch;

		const firstUser = userEntry("user-1", "Remember BLUE-42.");
		const harness = extensionHarness([firstUser]);
		const compact = harness.handlers.get("session_before_compact")!;
		const result = await compact({
			branchEntries: [firstUser],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);

		expect(result.cancel).toBeUndefined();
		expect(result.compaction.summary).toContain("OpenAI Codex native compaction checkpoint");
		expect(result.compaction.details.kind).toBe(NATIVE_COMPACTION_KIND);
		expect(result.compaction.details.replacementHistory.at(-1)).toEqual({
			type: "compaction",
			id: "cmp_1",
			encrypted_content: "opaque-state",
		});
		expect((requestBody!.input as JsonObject[]).at(-1)).toEqual({ type: "compaction_trigger" });
		expect(JSON.stringify(requestBody)).not.toContain("checkpoint");
		expect(requestHeaders!.get("x-codex-beta-features")).toContain("remote_compaction_v2");
		expect(harness.getBranch().slice(1).map((entry: any) => entry.data?.state)).toEqual([
			"running",
			"complete",
		]);

		const compactionEntry = {
			type: "compaction",
			id: "compact-1",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			summary: result.compaction.summary,
			firstKeptEntryId: "user-1",
			tokensBefore: 50_000,
			details: result.compaction.details,
		} as SessionEntry;
		const nextUser = {
			...userEntry("user-2", "What was the code?"),
			parentId: "compact-1",
		} as SessionEntry;
		harness.setBranch([firstUser, compactionEntry, nextUser]);

		const beforeRequest = harness.handlers.get("before_provider_request")!;
		const markerPayload = {
			model: model.id,
			input: [{ role: "user", content: [{ type: "input_text", text: result.compaction.summary }] }],
		};
		const patched = await beforeRequest({ payload: markerPayload }, harness.context);
		const serialized = JSON.stringify(patched);
		expect(serialized).not.toContain(result.compaction.summary);
		expect(patched.input[0]).toEqual({
			role: "user",
			content: [{ type: "input_text", text: "Remember BLUE-42." }],
		});
		expect(patched.input[1]).toEqual({ type: "compaction", id: "cmp_1", encrypted_content: "opaque-state" });
		expect(patched.input[2]).toMatchObject({ role: "user" });

		const filteredContext = harness.handlers.get("context")!({
			messages: [
				{ role: "compactionSummary", summary: result.compaction.summary },
				{ role: "user", content: [{ type: "text", text: "What was the code?" }] },
			],
		}, harness.context);
		expect(filteredContext.messages).toHaveLength(1);
		expect(filteredContext.messages[0].role).toBe("user");
	});

	test("cancels Pi compaction instead of falling back to text summarization", async () => {
		globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
		const entry = userEntry("user-1", "hello");
		const harness = extensionHarness([entry]);
		const result = await harness.handlers.get("session_before_compact")!({
			branchEntries: [entry],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);

		expect(result).toEqual({ cancel: true });
		expect(harness.notifications[0]).toContain("native compaction failed");
		expect(harness.getBranch().slice(1).map((entry: any) => entry.data?.state)).toEqual([
			"running",
			"failed",
		]);
	});

	test("retries a message-less compaction stream error", async () => {
		let attempts = 0;
		globalThis.fetch = (async () => {
			attempts++;
			if (attempts === 1) {
				return new Response(`data: ${JSON.stringify({ type: "error" })}\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return compactionSse("retried-opaque");
		}) as typeof fetch;
		const entry = userEntry("user-1", "continue after a transient compaction failure");
		const harness = extensionHarness([entry]);
		const result = await harness.handlers.get("session_before_compact")!({
			branchEntries: [entry],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);

		expect(attempts).toBe(2);
		expect(result.compaction.details.replacementHistory.at(-1)).toEqual({
			type: "compaction",
			id: "cmp_1",
			encrypted_content: "retried-opaque",
		});
		expect(harness.getBranch()
			.filter((entry: any) => entry.customType === "openai-codex-compaction-status")
			.map((entry: any) => entry.data.state)).toEqual(["running", "complete"]);
	});

	test("does not retry an explicit compaction stream error", async () => {
		let attempts = 0;
		globalThis.fetch = (async () => {
			attempts++;
			return new Response(`data: ${JSON.stringify({ type: "error", message: "explicit failure" })}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;
		const entry = userEntry("user-1", "do not retry a permanent compaction failure");
		const harness = extensionHarness([entry]);
		const result = await harness.handlers.get("session_before_compact")!({
			branchEntries: [entry],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);

		expect(attempts).toBe(1);
		expect(result).toEqual({ cancel: true });
		expect(harness.notifications).toContain("OpenAI Codex native compaction failed: explicit failure");
	});

	test("shows the running marker while Pi compaction is in progress", async () => {
		let resolveFetch: ((response: Response) => void) | undefined;
		globalThis.fetch = (() => new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		})) as typeof fetch;
		const entry = userEntry("user-1", "continue the task");
		const harness = extensionHarness([entry]);
		const pending = harness.handlers.get("session_before_compact")!({
			branchEntries: [entry],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);

		expect((harness.getBranch().at(-1) as any).data.state).toBe("running");
		await Promise.resolve();
		expect(resolveFetch).toBeDefined();
		resolveFetch!(compactionSse());
		await pending;
		expect((harness.getBranch().at(-1) as any).data.state).toBe("complete");
		const renderer = harness.entryRenderers.get("openai-codex-compaction-status")!;
		const rendered = renderer(
			{ data: { state: "complete" } },
			{},
			{ fg: (_color: string, text: string) => text },
		).render(80).join("\n");
		expect(rendered).toContain("OpenAI compaction complete");
	});

	test("does not compact inside the provider request hook", async () => {
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return compactionSse();
		}) as typeof fetch;
		const entry = userEntry("user-1", "continue the tool-driven task");
		const harness = extensionHarness([entry]);
		const result = await harness.handlers.get("before_provider_request")!({
			payload: {
				model: model.id,
				input: [{ role: "user", content: [{ type: "input_text", text: "continue the tool-driven task" }] }],
			},
		}, harness.context);

		expect(result).toBeUndefined();
		expect(called).toBe(false);
		expect(harness.getBranch()).toEqual([entry]);
	});

	test("aborts at 90 percent, compacts after settlement, and visibly continues", () => {
		const entry = userEntry("user-1", "continue the task");
		const harness = extensionHarness([entry]);
		harness.setUsageTokens(180_000);

		harness.handlers.get("turn_end")!({}, harness.context);
		expect(harness.aborted).toBe(true);
		expect(harness.compactionRequests).toHaveLength(0);

		harness.setIdle(true);
		harness.handlers.get("agent_settled")!({}, harness.context);
		expect(harness.compactionRequests).toHaveLength(1);
		harness.compactionRequests[0].onComplete({});

		expect(harness.sentUserMessages).toEqual([{
			content: "Compaction completed. Continue.",
			options: undefined,
		}]);
	});

	test("uses Pi threshold compaction when it finishes before settlement", () => {
		const entry = userEntry("user-1", "continue the task");
		const harness = extensionHarness([entry]);
		harness.setUsageTokens(180_000);
		harness.handlers.get("turn_end")!({}, harness.context);

		harness.handlers.get("session_compact")!({
			reason: "threshold",
			willRetry: false,
			fromExtension: true,
			compactionEntry: { details: { kind: NATIVE_COMPACTION_KIND } },
		}, harness.context);
		harness.setIdle(true);
		harness.handlers.get("agent_settled")!({}, harness.context);

		expect(harness.compactionRequests).toHaveLength(0);
		expect(harness.sentUserMessages).toEqual([{
			content: "Compaction completed. Continue.",
			options: undefined,
		}]);
	});

	test("does not add a continuation when overflow recovery will retry", () => {
		const entry = userEntry("user-1", "continue the task");
		const harness = extensionHarness([entry]);
		harness.setUsageTokens(180_000);
		harness.handlers.get("turn_end")!({}, harness.context);

		harness.handlers.get("session_compact")!({
			reason: "overflow",
			willRetry: true,
			fromExtension: true,
			compactionEntry: { details: { kind: NATIVE_COMPACTION_KIND } },
		}, harness.context);
		harness.setIdle(true);
		harness.handlers.get("agent_settled")!({}, harness.context);

		expect(harness.compactionRequests).toHaveLength(0);
		expect(harness.sentUserMessages).toEqual([]);
	});

	test("does not interrupt below the configured threshold", () => {
		const entry = userEntry("user-1", "continue the task");
		const harness = extensionHarness([entry]);
		harness.setUsageTokens(179_999);
		harness.handlers.get("turn_end")!({}, harness.context);
		expect(harness.aborted).toBe(false);
	});


	test("does not auto-continue when input is already queued", () => {
		const entry = userEntry("user-1", "continue the task");
		const harness = extensionHarness([entry]);
		harness.setUsageTokens(180_000);
		harness.handlers.get("turn_end")!({}, harness.context);
		harness.setIdle(true);
		harness.handlers.get("agent_settled")!({}, harness.context);
		harness.setHasPendingMessages(true);
		harness.compactionRequests[0].onComplete({});
		expect(harness.sentUserMessages).toEqual([]);
	});

	test("leaves non-Codex providers untouched", async () => {
		const entry = userEntry("user-1", "hello");
		const harness = extensionHarness([entry]);
		const otherContext = {
			...harness.context,
			model: { ...model, provider: "anthropic", api: "anthropic-messages" },
		};

		expect(await harness.handlers.get("before_provider_request")!({ payload: { input: ["original"] } }, otherContext)).toBeUndefined();
		expect(await harness.handlers.get("session_before_compact")!({
			branchEntries: [entry],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		}, otherContext)).toBeUndefined();
	});

	test("aborts rather than sending a malformed local checkpoint", async () => {
		const firstUser = userEntry("user-1", "hello");
		const malformed = {
			type: "compaction",
			id: "compact-1",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			summary: "local marker",
			firstKeptEntryId: "user-1",
			tokensBefore: 100,
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				modelKey: "bad",
				replacementHistory: [],
			},
		} as SessionEntry;
		const harness = extensionHarness([firstUser, malformed]);
		const patched = await harness.handlers.get("before_provider_request")!({
			payload: { model: model.id, input: [{ role: "user", content: "local marker" }] },
		}, harness.context);

		expect(harness.aborted).toBe(true);
		expect(patched.input).toEqual([]);
		expect(JSON.stringify(patched)).not.toContain("local marker");
	});
});

describe("native compaction helpers", () => {
	test("retains only recent user messages before the opaque item", () => {
		const input = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "old" }] },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "reply" }] },
			{ type: "function_call", call_id: "call-1" },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "new" }] },
		] as any;
		const retained = retainRecentUserMessages(input);
		expect(retained).toHaveLength(2);
		expect(retained.every((item) => item.role === "user")).toBe(true);

		const replacement = buildReplacementHistory(input, { type: "compaction", encrypted_content: "opaque" });
		expect(replacement.at(-1)).toEqual({ type: "compaction", encrypted_content: "opaque" });
	});

	test("repeated compaction replaces rather than nests the old opaque item", () => {
		const firstUser = userEntry("user-1", "old user fact");
		const firstCheckpoint = {
			type: "compaction",
			id: "compact-1",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			summary: "local marker 1",
			firstKeptEntryId: "user-1",
			tokensBefore: 100,
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				modelKey: "openai-codex:openai-codex-responses:gpt-test",
				replacementHistory: [
					{ role: "user", content: [{ type: "input_text", text: "old user fact" }] },
					{ type: "compaction", encrypted_content: "opaque-1" },
				],
			},
		} as SessionEntry;
		const nextUser = { ...userEntry("user-2", "new user fact"), parentId: "compact-1" } as SessionEntry;
		const input = effectiveInputForBranch({
			branch: [firstUser, firstCheckpoint, nextUser],
			model,
			tools: [],
		});
		expect(input.filter((item) => item.type === "compaction")).toHaveLength(1);

		const replacement = buildReplacementHistory(input, {
			type: "compaction",
			encrypted_content: "opaque-2",
		});
		expect(replacement.filter((item) => item.type === "compaction")).toEqual([
			{ type: "compaction", encrypted_content: "opaque-2" },
		]);
		expect(JSON.stringify(replacement)).toContain("new user fact");
	});

	test("overflow recovery excludes the failed assistant response", () => {
		const user = userEntry("user-1", "large request");
		const failure = {
			type: "message",
			id: "assistant-error",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "context window exceeded" }],
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: model.id,
				stopReason: "error",
				timestamp: Date.now(),
			},
		} as SessionEntry;
		const input = effectiveInputForBranch({
			branch: [user, failure],
			model,
			tools: [],
			excludeLastAssistantError: true,
		});
		expect(JSON.stringify(input)).not.toContain("context window exceeded");
		expect(JSON.stringify(input)).toContain("large request");
	});

	test("does not replay partial tool calls from an aborted assistant after a checkpoint", () => {
		const checkpoint = {
			type: "custom",
			id: "checkpoint",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: NATIVE_COMPACTION_KIND,
			data: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				modelKey: "openai-codex:openai-codex-responses:gpt-test",
				replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
			},
		} as SessionEntry;
		const aborted = {
			type: "message",
			id: "assistant-aborted",
			parentId: "checkpoint",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{
					type: "toolCall",
					id: "call-aborted|fc_aborted",
					name: "edit",
					arguments: { path: "src/client/input.rs" },
				}],
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: model.id,
				stopReason: "aborted",
				timestamp: Date.now(),
			},
		} as SessionEntry;
		const user = { ...userEntry("user-after-abort", "what happened?"), parentId: "assistant-aborted" } as SessionEntry;

		const input = effectiveInputForBranch({ branch: [checkpoint, aborted, user], model, tools: [] });
		expect(JSON.stringify(input)).not.toContain("call-aborted");
		expect(JSON.stringify(input)).toContain("what happened?");
	});

	test("synthesizes outputs for non-aborted orphaned tool calls", () => {
		const assistant = {
			type: "message",
			id: "assistant-tool",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-orphan|fc_orphan", name: "edit", arguments: {} }],
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: model.id,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		} as SessionEntry;
		const user = { ...userEntry("user-after-tool", "interrupt"), parentId: "assistant-tool" } as SessionEntry;

		const input = effectiveInputForBranch({ branch: [assistant, user], model, tools: [] });
		expect(input).toContainEqual({
			type: "function_call_output",
			call_id: "call-orphan",
			output: "No result provided",
		});
	});

	test("preserves valid call ids and keeps hashed shared prefixes distinct", () => {
		// pi-cursor-sdk bridge ids reach 64 characters at tool 1 and exceed the
		// Responses API limit once the tool index gains a second digit.
		const runId = "cursor-pi-bridge-run-00000000-0000-4000-8000-000000000000-tool-";
		const callIds = [`${runId}1`, `${runId}10`, `${runId}11`];
		expect(callIds.map((id) => id.length)).toEqual([64, 65, 65]);
		const assistant = {
			type: "message",
			id: "assistant-long-tools",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: callIds.map((id, index) => ({
					type: "toolCall",
					id: `${id}|fc_item_${index}`,
					name: "edit",
					arguments: {},
				})),
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: model.id,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		} as SessionEntry;
		const toolResults = callIds.map((callId, index) => ({
			type: "message",
			id: `tool-result-${index}`,
			parentId: index === 0 ? "assistant-long-tools" : `tool-result-${index - 1}`,
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: `${callId}|fc_item_${index}`,
				toolName: "edit",
				content: [{ type: "text", text: `ok-${index}` }],
				isError: false,
				timestamp: Date.now(),
			},
		}) as SessionEntry);

		const input = effectiveInputForBranch({ branch: [assistant, ...toolResults], model, tools: [] });
		const calls = input.filter((item) => item.type === "function_call");
		const outputs = input.filter((item) => item.type === "function_call_output");
		const normalizedIds = calls.map((item) => String(item.call_id));
		expect(normalizedIds[0]).toBe(callIds[0]);
		expect(normalizedIds.slice(1)).not.toEqual(callIds.slice(1));
		expect(calls.map((item) => item.id)).toEqual(["fc_item_0", "fc_item_1", "fc_item_2"]);
		expect(normalizedIds.every((id) => id.length <= 64)).toBe(true);
		expect(new Set(normalizedIds).size).toBe(normalizedIds.length);
		expect(outputs.map((item) => item.call_id)).toEqual(normalizedIds);
	});

	test("synthesized outputs for orphaned over-limit call ids stay paired", () => {
		const longCallId = `cursor-pi-bridge-run-${"1".repeat(36)}-tool-11`;
		const assistant = {
			type: "message",
			id: "assistant-long-orphan",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: `${longCallId}|fc_item_2`, name: "edit", arguments: {} }],
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: model.id,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		} as SessionEntry;
		const user = { ...userEntry("user-after-long-orphan", "interrupt"), parentId: "assistant-long-orphan" } as SessionEntry;

		const input = effectiveInputForBranch({ branch: [assistant, user], model, tools: [] });
		const call = input.find((item) => item.type === "function_call")!;
		const output = input.find((item) => item.type === "function_call_output")!;
		expect(String(call.call_id).length).toBeLessThanOrEqual(64);
		expect(output).toEqual({
			type: "function_call_output",
			call_id: call.call_id,
			output: "No result provided",
		});
	});

	test("latest compaction on the active branch is authoritative", () => {
		const native = {
			type: "compaction",
			id: "native",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "marker",
			firstKeptEntryId: "user",
			tokensBefore: 100,
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				modelKey: "openai-codex:openai-codex-responses:gpt-test",
				replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
			},
		} as SessionEntry;
		expect(findNativeCheckpoint([native]).status).toBe("valid");
		expect(findNativeCheckpoint([native, { ...native, id: "local", details: {} } as SessionEntry]).status).toBe("none");
	});

	test("merges the beta feature without removing existing features", () => {
		expect(mergeFeatureHeader("foo, remote_compaction_v2")).toBe("foo,remote_compaction_v2");
	});
});
