import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let reviewerText = '{"decision":"approve","reason":"authorized"}';
let completeOverride: ((context: any, options: any) => Promise<any>) | undefined;
let authOverride: (() => Promise<any>) | undefined;
const temporaryConfigs: string[] = [];
const temporaryDirs: string[] = [];
let responseId = 0;

const TEST_RULES = [
  { pattern: "\\bgit\\s+commit\\b", flags: "i", level: "guarded", group: "git", label: "Git commit" },
  { pattern: "\\bgit\\s+push\\b", flags: "i", level: "guarded", group: "git", label: "Git push" },
  {
    pattern: "(?<!uv\\s)\\bpip\\s+install\\b",
    flags: "i",
    level: "convention",
    group: "pip",
    label: "pip install",
    message: "Use uv instead.",
  },
];

function reviewerResponse(text = reviewerText, inputTokens = 10): any {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test-api",
    provider: "test",
    model: "guardian",
    responseId: `review-${++responseId}`,
    usage: {
      input: inputTokens,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function useConfig(value: unknown): string {
  const path = `/tmp/pi-auto-permissions-${process.pid}-${temporaryConfigs.length}.json`;
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  writeFileSync(path, JSON.stringify({ ...raw, rules: raw.rules ?? TEST_RULES }), "utf8");
  temporaryConfigs.push(path);
  process.env.PI_AUTO_PERMISSIONS_CONFIG = path;
  return path;
}

function useToolRowConfig(resultDisplayMs?: number): void {
  useConfig({ ui: { placement: "toolRow", resultDisplayMs } });
}

mock.module("@earendil-works/pi-ai/compat", () => ({
  completeSimple: async (_model: unknown, context: unknown, options: any) => {
    if (completeOverride) return completeOverride(context, options);
    if (options.signal?.aborted) return { content: [], stopReason: "aborted" };
    return reviewerResponse();
  },
}));

let commandGuardianExtension: any;

beforeAll(async () => {
  initTheme("dark", false);
  commandGuardianExtension = (await import("./index.js")).default;
});

function harness(branchInput: any[], mode = "print") {
  let toolCallHandler: any;
  let toolExecutionEndHandler: any;
  let sessionStartHandler: any;
  let sessionShutdownHandler: any;
  let overrideTool: any;
  let bashTool: any;
  let bashSourceInfo = { path: "<builtin:bash>", source: "builtin" };
  const widgets: unknown[] = [];
  const selects: unknown[] = [];
  let sessionId = `main-session-${Math.random().toString(36).slice(2)}`;
  let projectTrusted = false;
  let branchEntries = branchInput.map((entry, index) => typeof entry === "string"
    ? { id: `user-${index}`, type: "message", message: { role: "user", content: entry } }
    : entry);
  const pi = {
    events: { emit() {} },
    on(name: string, handler: any) {
      if (name === "tool_call") toolCallHandler = handler;
      if (name === "tool_execution_end") toolExecutionEndHandler = handler;
      if (name === "session_start") sessionStartHandler = handler;
      if (name === "session_shutdown") sessionShutdownHandler = handler;
    },
    registerTool(tool: any) {
      if (tool.name === "request_override") overrideTool = tool;
      if (tool.name === "bash") {
        bashTool = tool;
        bashSourceInfo = { path: "/extensions/pi-auto-permissions/index.ts", source: "extension" };
      }
    },
    getAllTools: () => [{ name: "bash", sourceInfo: bashSourceInfo }],
  };
  commandGuardianExtension(pi as any);
  const ctx = {
    model: {
      provider: "test",
      id: "guardian",
      api: "test-api",
      baseUrl: "https://reviewer.invalid",
      contextWindow: 128_000,
      maxTokens: 4096,
    },
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => authOverride ? authOverride() : ({ ok: true, apiKey: "test-key" }),
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branchEntries,
    },
    cwd: "/repo",
    mode,
    hasUI: mode === "tui",
    signal: undefined,
    isProjectTrusted: () => projectTrusted,
    ui: {
      setWidget: (_key: string, value: unknown) => widgets.push(value),
      select: (...args: unknown[]) => {
        selects.push(args);
        return Promise.resolve(undefined);
      },
      notify() {},
    },
  };
  return {
    toolCallHandler,
    toolExecutionEndHandler,
    sessionStartHandler,
    sessionShutdownHandler,
    overrideTool,
    get bashTool() { return bashTool; },
    setBashSource(sourceInfo: { path: string; source: string }) { bashSourceInfo = sourceInfo; },
    setBranch(entries: any[]) { branchEntries = entries; },
    setSessionId(value: string) { sessionId = value; },
    setProjectTrusted(value: boolean) { projectTrusted = value; },
    ctx,
    widgets,
    selects,
  };
}

beforeEach(() => {
  reviewerText = '{"decision":"approve","reason":"authorized"}';
  completeOverride = undefined;
  authOverride = undefined;
  responseId = 0;
  useConfig({});
});

afterEach(() => {
  for (const path of temporaryConfigs.splice(0)) rmSync(path, { force: true });
  for (const path of temporaryDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("auto permissions tool gate", () => {
  test("registers convention overrides as sequential", () => {
    const { overrideTool } = harness([]);
    expect(overrideTool.executionMode).toBe("sequential");
  });

  test("does not grant a convention override after cancellation", async () => {
    const { overrideTool, toolCallHandler, ctx } = harness([], "tui");
    let resolveSelect!: (value: string) => void;
    (ctx.ui as any).select = () => new Promise((resolve) => { resolveSelect = resolve; });
    const controller = new AbortController();
    const pending = overrideTool.execute(
      "override-1",
      { command: "pip install requests", reason: "legacy project" },
      controller.signal,
      undefined,
      ctx,
    );
    await Bun.sleep(0);
    controller.abort();
    resolveSelect("Allow for this session");
    const result = await pending;
    expect(result.details.success).toBeFalse();
    expect(result.content[0].text).toBe("Override cancelled.");

    const gateResult = await toolCallHandler(
      { toolName: "bash", input: { command: "pip install requests" } },
      ctx,
    );
    expect(gateResult.reason).toContain("Convention violation");
  });

  test("does not grant a convention override after session restart", async () => {
    const state = harness([], "tui");
    let resolveSelect!: (value: string) => void;
    (state.ctx.ui as any).select = () => new Promise((resolve) => { resolveSelect = resolve; });
    const pending = state.overrideTool.execute(
      "override-restart",
      { command: "pip install requests", reason: "legacy project" },
      undefined,
      undefined,
      state.ctx,
    );
    await Bun.sleep(0);
    await Promise.all([
      state.sessionShutdownHandler({}, state.ctx),
      state.sessionStartHandler({}, state.ctx),
    ]);
    resolveSelect("Allow for this session");
    const result = await pending;
    expect(result.details.success).toBeFalse();
    expect(result.content[0].text).toBe("Override cancelled.");

    const gateResult = await state.toolCallHandler(
      { toolName: "bash", input: { command: "pip install requests" } },
      state.ctx,
    );
    expect(gateResult.reason).toContain("Convention violation");
  });

  test("allows an approved guarded command", async () => {
    const { toolCallHandler, ctx } = harness(["push this branch"]);
    const result = await toolCallHandler({ toolName: "functions.bash", input: { command: "git push origin feature" } }, ctx);
    expect(result).toBeUndefined();
  });

  test("reuses one append-only reviewer context with stable cache options", async () => {
    const calls: Array<{ context: any; options: any }> = [];
    const responses = [reviewerResponse(), reviewerResponse()];
    completeOverride = async (context, options) => {
      calls.push({ context, options });
      return responses[calls.length - 1];
    };
    const state = harness([
      { id: "u1", type: "message", message: { role: "user", content: "squash this then push" } },
      {
        id: "a1",
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will push first" },
            { type: "toolCall", id: "push-1", name: "bash", arguments: { command: "git push origin feature" } },
          ],
        },
      },
    ]);

    expect(await state.toolCallHandler(
      { toolName: "bash", toolCallId: "push-1", input: { command: "git push origin feature" } },
      state.ctx,
    )).toBeUndefined();
    state.setBranch([
      { id: "u1", type: "message", message: { role: "user", content: "squash this then push" } },
      {
        id: "a1",
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will push first" },
            { type: "toolCall", id: "push-1", name: "bash", arguments: { command: "git push origin feature" } },
          ],
        },
      },
      { id: "r1", type: "message", message: { role: "toolResult", toolCallId: "push-1", toolName: "bash", isError: false, content: [{ type: "text", text: "REMOTE_OUTPUT_CANARY" }] } },
      {
        id: "a2",
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Now I will commit" },
            { type: "toolCall", id: "commit-1", name: "bash", arguments: { command: "git commit -m squash" } },
          ],
        },
      },
    ]);
    expect(await state.toolCallHandler(
      { toolName: "bash", toolCallId: "commit-1", input: { command: "git commit -m squash" } },
      state.ctx,
    )).toBeUndefined();

    expect(calls).toHaveLength(2);
    expect(calls[0].options.sessionId).toBe(calls[1].options.sessionId);
    expect(calls[0].options.sessionId).not.toBe(state.ctx.sessionManager.getSessionId());
    expect(calls[0].options.sessionId.length).toBeLessThanOrEqual(64);
    expect(calls[0].options.transport).toBe("auto");
    expect(calls[0].options.cacheRetention).toBe("long");
    expect(calls[1].context.messages).toHaveLength(3);
    expect(calls[1].context.messages[0]).toBe(calls[0].context.messages[0]);
    expect(calls[1].context.messages[1]).toBe(responses[0]);
    const firstEnvelope = calls[0].context.messages[0].content[0].text;
    const deltaEnvelope = calls[1].context.messages[2].content[0].text;
    expect(firstEnvelope).toContain('mode="full"');
    expect(firstEnvelope).toContain("USER: squash this then push");
    expect(deltaEnvelope).toContain('mode="delta"');
    expect(deltaEnvelope).not.toContain("USER: squash this then push");
    expect(deltaEnvelope).toContain('TOOL bash {\\"command\\":\\"git push origin feature\\"} → success');
    expect(deltaEnvelope).not.toContain("REMOTE_OUTPUT_CANARY");
    expect(deltaEnvelope).toContain('"command": "git commit -m squash"');
  });

  test("uses UUIDv7 and WebSocket routing for Codex reviewers", async () => {
    const calls: Array<{ options: any }> = [];
    completeOverride = async (_context, options) => {
      calls.push({ options });
      return reviewerResponse();
    };
    const state = harness(["push this branch"]);
    state.ctx.model.provider = "openai-codex";

    expect(await state.toolCallHandler(
      { toolName: "bash", input: { command: "git push origin feature" } },
      state.ctx,
    )).toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0].options.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(calls[0].options.transport).toBe("websocket");
  });

  test("resets to full evidence on branch, session, model, or API divergence", async () => {
    const scenarios = [
      (state: ReturnType<typeof harness>) => state.setBranch([
        { id: "other-user", type: "message", message: { role: "user", content: "push this branch" } },
      ]),
      (state: ReturnType<typeof harness>) => state.setSessionId("different-main-session"),
      (state: ReturnType<typeof harness>) => { state.ctx.model.id = "guardian-2"; },
      (state: ReturnType<typeof harness>) => {
        state.ctx.model.api = "other-api";
        state.ctx.model.baseUrl = "https://other-reviewer.invalid";
      },
    ];

    for (const mutate of scenarios) {
      const calls: Array<{ context: any; options: any }> = [];
      completeOverride = async (context, options) => {
        calls.push({ context, options });
        return reviewerResponse();
      };
      const state = harness([{ id: "user-1", type: "message", message: { role: "user", content: "push this branch" } }]);
      expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();
      mutate(state);
      expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();
      expect(calls[1].options.sessionId).not.toBe(calls[0].options.sessionId);
      expect(calls[1].context.messages).toHaveLength(1);
      expect(calls[1].context.messages[0].content[0].text).toContain('mode="full"');
    }
  });

  test("resets when the system policy or reasoning effort changes", async () => {
    const path = useConfig({
      reviewer: { provider: "test", model: "guardian", reasoningEffort: "low" },
      systemPrompt: "policy one",
    });
    const calls: Array<{ context: any; options: any }> = [];
    completeOverride = async (context, options) => {
      calls.push({ context, options });
      return reviewerResponse();
    };
    const state = harness(["push this branch"]);
    (state.ctx.modelRegistry as any).find = () => state.ctx.model;

    expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();
    writeFileSync(path, JSON.stringify({
      reviewer: { provider: "test", model: "guardian", reasoningEffort: "low" },
      systemPrompt: "policy two",
      rules: TEST_RULES,
    }));
    expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();
    writeFileSync(path, JSON.stringify({
      reviewer: { provider: "test", model: "guardian", reasoningEffort: "medium" },
      systemPrompt: "policy two",
      rules: TEST_RULES,
    }));
    expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();

    expect(new Set(calls.map((call) => call.options.sessionId)).size).toBe(3);
    expect(calls.map((call) => call.context.messages.length)).toEqual([1, 1, 1]);
    expect(calls[2].options.reasoning).toBe("medium");
  });

  test("adds only the highest-priority trusted project instruction file and resets when it changes", async () => {
    useConfig({ reviewEvidence: { projectInstructions: true } });
    const projectDir = mkdtempSync(join(tmpdir(), "pi-auto-permissions-project-"));
    temporaryDirs.push(projectDir);
    const agentsPath = join(projectDir, "AGENTS.md");
    writeFileSync(agentsPath, "AGENTS_POLICY: reusable Windows validation checkout\n", "utf8");
    writeFileSync(join(projectDir, "CLAUDE.md"), "CLAUDE_POLICY: lower priority\n", "utf8");

    const calls: Array<{ context: any; options: any }> = [];
    completeOverride = async (context, options) => {
      calls.push({ context, options });
      return reviewerResponse();
    };
    const state = harness(["push this branch"]);
    state.ctx.cwd = projectDir;

    expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();
    state.setProjectTrusted(true);
    expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();
    rmSync(agentsPath);
    expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();

    expect(calls[0].context.systemPrompt).not.toContain("AGENT_INSTRUCTIONS_EVIDENCE");
    expect(calls[1].context.systemPrompt).toContain('"source": "AGENTS.md"');
    expect(calls[1].context.systemPrompt).toContain("AGENTS_POLICY");
    expect(calls[1].context.systemPrompt).not.toContain("CLAUDE_POLICY");
    expect(calls[2].context.systemPrompt).toContain('"source": "CLAUDE.md"');
    expect(calls[2].context.systemPrompt).toContain("CLAUDE_POLICY");
    expect(new Set(calls.map((call) => call.options.sessionId)).size).toBe(3);
    expect(calls.map((call) => call.context.messages.length)).toEqual([1, 1, 1]);
  });

  test("resets on trust changes even when no project instruction file exists", async () => {
    useConfig({ reviewEvidence: { projectInstructions: true } });
    const projectDir = mkdtempSync(join(tmpdir(), "pi-auto-permissions-empty-project-"));
    temporaryDirs.push(projectDir);
    const calls: Array<{ context: any; options: any }> = [];
    completeOverride = async (context, options) => {
      calls.push({ context, options });
      return reviewerResponse();
    };
    const state = harness(["push this branch"]);
    state.ctx.cwd = projectDir;

    expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();
    state.setProjectTrusted(true);
    expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();

    expect(calls[0].context.systemPrompt).not.toContain("AGENT_INSTRUCTIONS_EVIDENCE");
    expect(calls[1].context.systemPrompt).not.toContain("AGENT_INSTRUCTIONS_EVIDENCE");
    expect(calls[1].options.sessionId).not.toBe(calls[0].options.sessionId);
    expect(calls[1].context.messages).toHaveLength(1);
  });

  test("invalidates continuation when project instructions cannot be read", async () => {
    useConfig({ reviewEvidence: { projectInstructions: true } });
    const projectDir = mkdtempSync(join(tmpdir(), "pi-auto-permissions-unreadable-project-"));
    temporaryDirs.push(projectDir);
    const agentsPath = join(projectDir, "AGENTS.md");
    writeFileSync(agentsPath, "stable policy\n", "utf8");
    const calls: Array<{ context: any; options: any }> = [];
    completeOverride = async (context, options) => {
      calls.push({ context, options });
      return reviewerResponse();
    };
    const state = harness(["push this branch"]);
    state.ctx.cwd = projectDir;
    state.setProjectTrusted(true);

    expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();
    rmSync(agentsPath);
    mkdirSync(agentsPath);
    const failed = await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx);
    expect(failed.reason).toContain("Automatic review failed");
    rmSync(agentsPath, { recursive: true });
    writeFileSync(agentsPath, "stable policy\n", "utf8");
    expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();

    expect(calls).toHaveLength(2);
    expect(calls[1].options.sessionId).not.toBe(calls[0].options.sessionId);
    expect(calls[1].context.messages).toHaveLength(1);
  });

  test("invalidates continuation after malformed output", async () => {
    const calls: Array<{ context: any; options: any }> = [];
    const outputs = [reviewerResponse(), reviewerResponse("not json"), reviewerResponse()];
    completeOverride = async (context, options) => {
      calls.push({ context, options });
      return outputs[calls.length - 1];
    };
    const state = harness(["push this branch"]);

    expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();
    const failed = await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx);
    expect(failed.reason).toContain("Automatic review failed");
    expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();

    expect(calls[1].options.sessionId).toBe(calls[0].options.sessionId);
    expect(calls[2].options.sessionId).not.toBe(calls[0].options.sessionId);
    expect(calls[2].context.messages).toHaveLength(1);
    expect(calls[2].context.messages[0].content[0].text).toContain('mode="full"');
  });

  test("invalidates continuation after cancellation", async () => {
    const calls: Array<{ context: any; options: any }> = [];
    let resolveCancelled!: (value: any) => void;
    completeOverride = async (context, options) => {
      calls.push({ context, options });
      if (calls.length === 2) return new Promise((resolve) => { resolveCancelled = resolve; });
      return reviewerResponse();
    };
    const state = harness(["push this branch"], "tui");
    expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();

    const controller = new AbortController();
    (state.ctx as any).signal = controller.signal;
    const pending = state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx);
    await Bun.sleep(0);
    controller.abort();
    resolveCancelled(reviewerResponse());
    expect(await pending).toEqual({ block: true, reason: "Auto Permissions review cancelled" });

    (state.ctx as any).signal = undefined;
    expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();
    expect(calls[1].options.sessionId).toBe(calls[0].options.sessionId);
    expect(calls[2].options.sessionId).not.toBe(calls[0].options.sessionId);
    expect(calls[2].context.messages).toHaveLength(1);
  });

  test("resets after usage approaches the model window", async () => {
    const calls: Array<{ context: any; options: any }> = [];
    const outputs = [reviewerResponse(undefined, 110_000), reviewerResponse()];
    completeOverride = async (context, options) => {
      calls.push({ context, options });
      return outputs[calls.length - 1];
    };
    const state = harness(["push this branch"]);

    expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();
    expect(await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx)).toBeUndefined();
    expect(calls[1].options.sessionId).not.toBe(calls[0].options.sessionId);
    expect(calls[1].context.messages).toHaveLength(1);
  });

  test("fails closed when one full non-ASCII compact review cannot fit", async () => {
    let calls = 0;
    completeOverride = async () => {
      calls++;
      return reviewerResponse();
    };
    const state = harness([`push this branch ${"😀".repeat(6000)}`]);
    state.ctx.model.contextWindow = 30_000;

    const result = await state.toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, state.ctx);
    expect(calls).toBe(0);
    expect(result).toEqual({
      block: true,
      reason: "Git push requires user approval: Automatic review failed: compact review evidence exceeds the review model's safe context budget",
    });
  });

  test("shows waiting and approved states in the TUI widget", async () => {
    const { toolCallHandler, ctx, widgets } = harness(["push this branch"], "tui");
    const result = await toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, ctx);
    expect(result).toBeUndefined();
    expect(widgets).toHaveLength(2);

    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const waiting = (widgets[0] as Function)({}, theme).render(100).join("\n");
    const approved = (widgets[1] as Function)({}, theme).render(100).join("\n");
    expect(waiting).toContain("waiting for test/guardian");
    expect(approved).toContain("approved");
    expect(approved).toContain("git push origin feature");
  });

  test("renders guarded review state inside the native bash row", async () => {
    useToolRowConfig(0);
    let resolveReview!: (value: unknown) => void;
    completeOverride = () => new Promise((resolve) => { resolveReview = resolve; });
    const harnessState = harness(["push this branch"], "tui");
    await harnessState.sessionStartHandler({}, harnessState.ctx);
    const bashTool = harnessState.bashTool;
    expect(bashTool.name).toBe("bash");

    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    let invalidations = 0;
    let lastComponent: unknown;
    const renderState = {};
    const render = () => {
      lastComponent = bashTool.renderCall(
        { command: "git push origin feature" },
        theme,
        {
          state: renderState,
          toolCallId: "call-1",
          invalidate: () => { invalidations++; },
          lastComponent,
          executionStarted: true,
        },
      );
      return (lastComponent as { render(width: number): string[] }).render(120).join("\n");
    };

    expect(render()).toContain("git push origin feature");
    expect(render()).not.toContain("guardian running");
    const pending = harnessState.toolCallHandler(
      { toolName: "bash", toolCallId: "call-1", input: { command: "git push origin feature" } },
      harnessState.ctx,
    );
    await Bun.sleep(0);
    expect(invalidations).toBeGreaterThan(0);
    expect(render()).toContain("guardian running");
    expect(render()).toContain("Git push");

    resolveReview({
      content: [{ type: "text", text: '{"decision":"approve","reason":"authorized"}' }],
      stopReason: "stop",
    });
    expect(await pending).toBeUndefined();
    expect(render()).toContain("approved");
    expect(render()).toContain("authorized");
    await Bun.sleep(1);
    expect(render()).toContain("approved");
    expect(harnessState.widgets).toHaveLength(0);
    await harnessState.sessionShutdownHandler({}, harnessState.ctx);
  });

  test("falls back to the widget if another extension replaces bash later", async () => {
    useToolRowConfig();
    const harnessState = harness(["push this branch"], "tui");
    await harnessState.sessionStartHandler({}, harnessState.ctx);
    harnessState.setBashSource({ path: "/extensions/ssh.ts", source: "extension" });

    const result = await harnessState.toolCallHandler(
      { toolName: "bash", toolCallId: "call-ssh", input: { command: "git push origin feature" } },
      harnessState.ctx,
    );
    expect(result).toBeUndefined();
    expect(harnessState.widgets).toHaveLength(2);
  });

  test("releases unguarded bash row invalidators when execution ends", async () => {
    useToolRowConfig();
    const harnessState = harness([], "tui");
    await harnessState.sessionStartHandler({}, harnessState.ctx);
    let invalidations = 0;
    harnessState.bashTool.renderCall(
      { command: "echo safe" },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      {
        state: {},
        toolCallId: "call-safe",
        invalidate: () => { invalidations++; },
        executionStarted: true,
      },
    );
    await harnessState.toolExecutionEndHandler({ toolName: "bash", toolCallId: "call-safe" });
    await harnessState.sessionShutdownHandler({}, harnessState.ctx);
    expect(invalidations).toBe(0);
  });

  test("returns revision feedback to the main agent", async () => {
    reviewerText = '{"decision":"revise","reason":"the commit message must be concise and lowercase"}';
    const { toolCallHandler, ctx } = harness(["commit with a concise lowercase message"]);
    const result = await toolCallHandler(
      { toolName: "bash", input: { command: 'git commit -m "Fix Authentication and Update Documentation"' } },
      ctx,
    );
    expect(result).toEqual({
      block: true,
      reason: "Auto Permissions requested revision: the commit message must be concise and lowercase\nRevise the command and try again.",
    });
  });

  test("blocks ask_user decisions when no UI exists", async () => {
    reviewerText = '{"decision":"ask_user","reason":"pushing was not requested"}';
    const { toolCallHandler, ctx } = harness(["fix the test"]);
    const result = await toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, ctx);
    expect(result).toEqual({
      block: true,
      reason: "Git push requires user approval: pushing was not requested",
    });
  });

  test("cancels without prompting when the active turn is aborted", async () => {
    const { toolCallHandler, ctx, selects } = harness(["push this branch"], "tui");
    const controller = new AbortController();
    controller.abort();
    (ctx as any).signal = controller.signal;
    const result = await toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, ctx);
    expect(result).toEqual({ block: true, reason: "Auto Permissions review cancelled" });
    expect(selects).toHaveLength(0);
  });

  test("cancels a stalled credential lookup", async () => {
    authOverride = () => new Promise(() => {});
    const { toolCallHandler, ctx, selects } = harness(["push this branch"], "tui");
    const controller = new AbortController();
    (ctx as any).signal = controller.signal;
    const pending = toolCallHandler(
      { toolName: "bash", input: { command: "git push origin feature" } },
      ctx,
    );
    await Bun.sleep(0);
    controller.abort();
    expect(await pending).toEqual({ block: true, reason: "Auto Permissions review cancelled" });
    expect(selects).toHaveLength(0);
  });

  test("clears review state and reviewer lineage when cancellation races with user confirmation", async () => {
    reviewerText = '{"decision":"ask_user","reason":"pushing was not requested"}';
    const calls: Array<{ context: any; options: any }> = [];
    completeOverride = async (context, options) => {
      calls.push({ context, options });
      return reviewerResponse();
    };
    const { toolCallHandler, ctx, widgets } = harness(["fix the test"], "tui");
    let resolveSelect!: (value: string) => void;
    (ctx.ui as any).select = () => new Promise((resolve) => { resolveSelect = resolve; });
    const controller = new AbortController();
    (ctx as any).signal = controller.signal;
    const pending = toolCallHandler(
      { toolName: "bash", input: { command: "git push origin feature" } },
      ctx,
    );
    await Bun.sleep(0);
    controller.abort();
    resolveSelect("Allow");
    expect(await pending).toEqual({ block: true, reason: "Auto Permissions review cancelled" });
    expect(widgets[widgets.length - 1]).toBeUndefined();

    reviewerText = '{"decision":"approve","reason":"authorized"}';
    (ctx as any).signal = undefined;
    expect(await toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, ctx)).toBeUndefined();
    expect(calls[1].options.sessionId).not.toBe(calls[0].options.sessionId);
    expect(calls[1].context.messages).toHaveLength(1);
    expect(calls[1].context.messages[0].content[0].text).toContain('mode="full"');
  });

  test("does not let a stale confirmation mutate restarted-session reviewer state", async () => {
    reviewerText = '{"decision":"ask_user","reason":"pushing was not requested"}';
    const calls: Array<{ context: any; options: any }> = [];
    completeOverride = async (context, options) => {
      calls.push({ context, options });
      return reviewerResponse();
    };
    const state = harness(["fix the test"], "tui");
    let resolveSelect!: (value: string) => void;
    (state.ctx.ui as any).select = () => new Promise((resolve) => { resolveSelect = resolve; });
    const stale = state.toolCallHandler(
      { toolName: "bash", input: { command: "git push origin feature" } },
      state.ctx,
    );
    await Bun.sleep(0);
    await Promise.all([
      state.sessionShutdownHandler({}, state.ctx),
      state.sessionStartHandler({}, state.ctx),
    ]);

    reviewerText = '{"decision":"approve","reason":"authorized"}';
    expect(await state.toolCallHandler(
      { toolName: "bash", input: { command: "git push origin feature" } },
      state.ctx,
    )).toBeUndefined();
    resolveSelect("Allow");
    expect(await stale).toEqual({ block: true, reason: "Auto Permissions review cancelled" });
    expect(await state.toolCallHandler(
      { toolName: "bash", input: { command: "git push origin feature" } },
      state.ctx,
    )).toBeUndefined();

    expect(calls[0].options.sessionId).not.toBe(calls[1].options.sessionId);
    expect(calls[2].options.sessionId).toBe(calls[1].options.sessionId);
    expect(calls[2].context.messages).toHaveLength(3);
  });

  test("cancels an old verdict when restart occurs before verdict dispatch", async () => {
    const state = harness(["push this branch"], "tui");
    const response = reviewerResponse();
    const content = response.content;
    let restarted = false;
    Object.defineProperty(response, "content", {
      get() {
        if (!restarted) {
          restarted = true;
          queueMicrotask(() => {
            void state.sessionShutdownHandler({}, state.ctx);
            void state.sessionStartHandler({}, state.ctx);
          });
        }
        return content;
      },
    });
    completeOverride = async () => response;

    expect(await state.toolCallHandler(
      { toolName: "bash", input: { command: "git push origin feature" } },
      state.ctx,
    )).toEqual({ block: true, reason: "Auto Permissions review cancelled" });
    expect(state.selects).toHaveLength(0);

    completeOverride = async () => reviewerResponse();
    expect(await state.toolCallHandler(
      { toolName: "bash", input: { command: "git push origin feature" } },
      state.ctx,
    )).toBeUndefined();
  });

  test("does not show approved when cancellation races with the provider response", async () => {
    let resolveReview!: (value: unknown) => void;
    completeOverride = () => new Promise((resolve) => { resolveReview = resolve; });
    const { toolCallHandler, ctx, widgets, selects } = harness(["push this branch"], "tui");
    const controller = new AbortController();
    (ctx as any).signal = controller.signal;
    const pending = toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, ctx);
    await Bun.sleep(0);
    controller.abort();
    resolveReview({
      content: [{ type: "text", text: '{"decision":"approve","reason":"authorized"}' }],
      stopReason: "stop",
    });
    expect(await pending).toEqual({ block: true, reason: "Auto Permissions review cancelled" });
    expect(selects).toHaveLength(0);
    expect(widgets[widgets.length - 1]).toBeUndefined();
  });

  test("aborts an in-flight credential lookup across shutdown and restart", async () => {
    authOverride = () => new Promise(() => {});
    const state = harness(["push this branch"], "tui");
    const pending = state.toolCallHandler(
      { toolName: "bash", input: { command: "git push origin feature" } },
      state.ctx,
    );
    await Bun.sleep(0);
    await Promise.all([
      state.sessionShutdownHandler({}, state.ctx),
      state.sessionStartHandler({}, state.ctx),
    ]);
    expect(await pending).toEqual({ block: true, reason: "Auto Permissions review cancelled" });
    expect(state.selects).toHaveLength(0);

    authOverride = undefined;
    expect(await state.toolCallHandler(
      { toolName: "bash", input: { command: "git push origin feature" } },
      state.ctx,
    )).toBeUndefined();
  });

  test("does not recreate the widget after session shutdown", async () => {
    let resolveReview!: (value: unknown) => void;
    completeOverride = () => new Promise((resolve) => { resolveReview = resolve; });
    const { toolCallHandler, sessionShutdownHandler, ctx, widgets } = harness(["push this branch"], "tui");
    const pending = toolCallHandler({ toolName: "bash", input: { command: "git push origin feature" } }, ctx);
    await Bun.sleep(0);
    await sessionShutdownHandler({}, ctx);
    resolveReview({
      content: [{ type: "text", text: '{"decision":"approve","reason":"authorized"}' }],
      stopReason: "stop",
    });
    await pending;
    expect(widgets).toHaveLength(2);
    expect(widgets[1]).toBeUndefined();
  });

  test("fails closed when the initial config is invalid", async () => {
    const path = `/tmp/pi-auto-permissions-invalid-${process.pid}.json`;
    writeFileSync(path, "{invalid", "utf8");
    process.env.PI_AUTO_PERMISSIONS_CONFIG = path;
    try {
      const { toolCallHandler, ctx } = harness(["say hello"]);
      const result = await toolCallHandler({ toolName: "bash", input: { command: "echo hello" } }, ctx);
      expect(result.block).toBeTrue();
      expect(result.reason).toContain("configuration is invalid");
    } finally {
      rmSync(path, { force: true });
    }
  });
});
