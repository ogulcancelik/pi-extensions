import { afterEach, describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { needsLegacyCompactionFallback, registerCodexCompactionExtension } from "./index.ts";
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

function extensionHarness(initialBranch: SessionEntry[], hostVersion = "0.84.4") {
	const handlers = new Map<string, (...args: any[]) => any>();
	const entryRenderers = new Map<string, (...args: any[]) => any>();
	let branch = initialBranch;
	let abortCount = 0;
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
	registerCodexCompactionExtension(pi, hostVersion);

	const context = {
		model,
		mode: "tui",
		cwd: "/var/tmp/pi-codex-compaction-test",
		signal: new AbortController().signal,
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message) },
		abort: () => { abortCount++; },
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
		get aborted() { return abortCount > 0; },
		get abortCount() { return abortCount; },
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

	test("does not compact or abort inside the provider request hook", async () => {
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
		expect(harness.aborted).toBe(false);
		expect(harness.getBranch()).toEqual([entry]);
	});

	test("enables the compatibility path only before Pi 0.84.4", () => {
		expect(needsLegacyCompactionFallback("0.84.3")).toBe(true);
		expect(needsLegacyCompactionFallback("v0.83.0")).toBe(true);
		expect(needsLegacyCompactionFallback("0.84.4")).toBe(false);
		expect(needsLegacyCompactionFallback("0.85.0")).toBe(false);
		expect(needsLegacyCompactionFallback("development")).toBe(false);
	});

	test("leaves compaction timing and continuation to current Pi", () => {
		const harness = extensionHarness([userEntry("user-1", "continue the task")], "0.84.4");

		expect(harness.handlers.has("turn_end")).toBe(false);
		expect(harness.handlers.has("agent_settled")).toBe(false);
		expect(harness.handlers.has("session_compact")).toBe(false);
	});

	test("legacy Pi stops before the next provider request, compacts, and resumes", async () => {
		const harness = extensionHarness([userEntry("user-1", "continue the task")], "0.84.3");
		harness.setUsageTokens(180_000);

		harness.handlers.get("turn_end")!({}, harness.context);
		expect(harness.aborted).toBe(false);
		await harness.handlers.get("before_provider_request")!({ payload: { model: model.id, input: [] } }, harness.context);
		expect(harness.abortCount).toBe(1);

		harness.setIdle(true);
		harness.handlers.get("agent_settled")!({}, harness.context);
		expect(harness.compactionRequests).toHaveLength(1);
		harness.compactionRequests[0].onComplete({});
		expect(harness.sentUserMessages).toEqual([{
			content: "Compaction completed. Continue.",
			options: undefined,
		}]);
	});

	test("legacy Pi blocks repeated provider attempts without duplicate warnings", async () => {
		const harness = extensionHarness([userEntry("user-1", "continue the task")], "0.84.3");
		harness.setUsageTokens(180_000);
		harness.handlers.get("turn_end")!({}, harness.context);

		await harness.handlers.get("before_provider_request")!({ payload: { model: model.id, input: [] } }, harness.context);
		await harness.handlers.get("before_provider_request")!({ payload: { model: model.id, input: [] } }, harness.context);

		expect(harness.abortCount).toBe(2);
		expect(harness.notifications).toEqual([
			"Stopping before the next OpenAI Codex request to compact context.",
		]);
	});

	test("legacy Pi reuses a native threshold compaction that wins the race", async () => {
		const harness = extensionHarness([userEntry("user-1", "continue the task")], "0.84.3");
		harness.setUsageTokens(180_000);
		harness.handlers.get("turn_end")!({}, harness.context);
		await harness.handlers.get("before_provider_request")!({ payload: { model: model.id, input: [] } }, harness.context);

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

	test("legacy Pi defers continuation to overflow recovery", async () => {
		const harness = extensionHarness([userEntry("user-1", "continue the task")], "0.84.3");
		harness.setUsageTokens(180_000);
		harness.handlers.get("turn_end")!({}, harness.context);
		await harness.handlers.get("before_provider_request")!({ payload: { model: model.id, input: [] } }, harness.context);

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

	test("legacy Pi compacts silently when the run ends naturally", () => {
		const harness = extensionHarness([userEntry("user-1", "finish the task")], "0.84.3");
		harness.setUsageTokens(180_000);
		harness.handlers.get("turn_end")!({}, harness.context);

		harness.setIdle(true);
		harness.handlers.get("agent_settled")!({}, harness.context);
		expect(harness.compactionRequests).toHaveLength(1);
		harness.compactionRequests[0].onComplete({});
		expect(harness.sentUserMessages).toEqual([]);
	});

	test("legacy Pi does not resume over queued input", async () => {
		const harness = extensionHarness([userEntry("user-1", "continue the task")], "0.84.3");
		harness.setUsageTokens(180_000);
		harness.handlers.get("turn_end")!({}, harness.context);
		await harness.handlers.get("before_provider_request")!({ payload: { model: model.id, input: [] } }, harness.context);
		harness.setIdle(true);
		harness.handlers.get("agent_settled")!({}, harness.context);
		harness.setHasPendingMessages(true);
		harness.compactionRequests[0].onComplete({});
		expect(harness.sentUserMessages).toEqual([]);
	});

	test("legacy Pi stays idle below its compatibility threshold", () => {
		const harness = extensionHarness([userEntry("user-1", "continue the task")], "0.84.3");
		harness.setUsageTokens(179_999);
		harness.handlers.get("turn_end")!({}, harness.context);
		harness.handlers.get("agent_settled")!({}, harness.context);

		expect(harness.aborted).toBe(false);
		expect(harness.compactionRequests).toHaveLength(0);
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
	test("drops foreign reasoning state and response item ids", () => {
		const user = userEntry("user-1", "review this change");
		const assistant = {
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				provider: "xai",
				api: "openai-responses",
				model: "grok-4.6",
				stopReason: "toolUse",
				timestamp: Date.now(),
				content: [
					{
						type: "thinking",
						thinking: "checking",
						thinkingSignature: JSON.stringify({
							type: "reasoning",
							id: "rs_grok_1",
							status: "completed",
							summary: [{ type: "summary_text", text: "checking" }],
							encrypted_content: "opaque-grok-state",
						}),
					},
					{
						type: "text",
						text: "Looks good.",
						textSignature: JSON.stringify({ v: 1, id: "msg_grok_1" }),
					},
					{
						type: "toolCall",
						id: "call_grok_1|fc_grok_1",
						name: "bash",
						arguments: { command: "git status" },
					},
				],
			},
		} as SessionEntry;

		const input = effectiveInputForBranch({ branch: [user, assistant], model, tools: [] });
		const assistantMessage = input.find(
			(item) => item.type === "message" && item.role === "assistant",
		)!;
		const functionCall = input.find((item) => item.type === "function_call")!;

		expect(input.find((item) => item.type === "reasoning")).toBeUndefined();
		expect(JSON.stringify(input)).not.toContain("opaque-grok-state");
		expect(assistantMessage.status).toBeUndefined();
		expect(assistantMessage.id).toBe("msg_pi_1");
		expect(functionCall.call_id).toBe("call_grok_1");
		expect(functionCall.id).toBeUndefined();
	});

	test("removes response-only status from Codex reasoning", () => {
		const user = userEntry("user-1", "continue");
		const assistant = {
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: model.id,
				stopReason: "stop",
				timestamp: Date.now(),
				content: [{
					type: "thinking",
					thinking: "checking",
					thinkingSignature: JSON.stringify({
						type: "reasoning",
						id: "rs_codex_1",
						status: "completed",
						summary: [],
						encrypted_content: "opaque-codex-state",
					}),
				}],
			},
		} as SessionEntry;

		const input = effectiveInputForBranch({ branch: [user, assistant], model, tools: [] });
		const reasoning = input.find((item) => item.type === "reasoning")!;
		expect(reasoning.status).toBeUndefined();
		expect(reasoning.encrypted_content).toBe("opaque-codex-state");
	});

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
