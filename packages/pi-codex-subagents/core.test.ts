import { describe, expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".pi",
  getAgentDir: () => "/tmp/pi-codex-subagents-tests",
}));

const {
  AgentManager,
  RpcJsonlDecoder,
  consumeFirstMatchingMailboxEvent,
  parentScopeKey,
  parseAgentDefinitionText,
  taskStorageKey,
} = await import("./core.js");

describe("RPC framing", () => {
  test("splits only on LF and preserves Unicode line separators", () => {
    const decoder = new RpcJsonlDecoder();
    const payload = JSON.stringify({ text: "before\u2028after" });
    expect(decoder.push(Buffer.from(payload.slice(0, 7)))).toEqual([]);
    expect(decoder.push(Buffer.from(`${payload.slice(7)}\n`))).toEqual([payload]);
    expect(decoder.end()).toEqual([]);
  });
});

describe("session-scoped identities", () => {
  test("separates parent sessions and formerly colliding task names", () => {
    expect(parentScopeKey("parent-a")).not.toBe(parentScopeKey("parent-b"));
    expect(taskStorageKey("review/api")).not.toBe(taskStorageKey("review__api"));
  });
});

describe("agent templates", () => {
  test("parses optional routing and extension fields", () => {
    const definition = parseAgentDefinitionText(`---
name: reviewer
provider: openai-codex
model: gpt-5.6-sol
thinking: high
extensions: @scope/tools, ~/.pi/helper.ts
skills: web-investigate
---
Review the requested files.`, "fallback");
    expect(definition).toMatchObject({
      name: "reviewer",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
      extensions: ["@scope/tools", "~/.pi/helper.ts"],
      skills: ["web-investigate"],
      prompt: "Review the requested files.",
    });
  });
});

describe("completion mailbox", () => {
  test("waits until explicitly cancelled when no completion exists", async () => {
    const manager = new AgentManager();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancelled")), 10);
    await expect(manager.waitAgent("empty-parent", undefined, controller.signal)).rejects.toThrow("cancelled");
    await manager.shutdown();
  });

  test("consumes one matching completion without dropping siblings", () => {
    const events = [
      { id: "1", parentSessionId: "parent", agentName: "/one", status: "completed", createdAt: 1 },
      { id: "2", parentSessionId: "parent", agentName: "/two", status: "completed", createdAt: 2 },
      { id: "3", parentSessionId: "other", agentName: "/one", status: "completed", createdAt: 3 },
    ] as any[];
    expect(consumeFirstMatchingMailboxEvent(events, "parent")?.agentName).toBe("/one");
    expect(events.map((event) => event.id)).toEqual(["2", "3"]);
    expect(consumeFirstMatchingMailboxEvent(events, "parent", new Set(["/two"]))?.agentName).toBe("/two");
    expect(events.map((event) => event.id)).toEqual(["3"]);
  });
});
