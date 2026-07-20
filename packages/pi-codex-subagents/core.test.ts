import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TEST_AGENT_DIR = "/tmp/pi-codex-subagents-tests";
const FAKE_RPC_CHILD = path.join(import.meta.dir, "test", "fake-rpc-child.js");
process.env.PI_SUBAGENT_TEMP_DIR = path.join(TEST_AGENT_DIR, "temp");

mock.module("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".pi",
  getAgentDir: () => TEST_AGENT_DIR,
}));

const {
  AgentManager,
  RpcJsonlDecoder,
  consumeFirstMatchingMailboxEvent,
  getAgent,
  getRunsDir,
  getSocketPath,
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

describe("run storage", () => {
  const packageDir = path.join(TEST_AGENT_DIR, "pi-codex-subagents");
  const configFile = path.join(packageDir, "config.json");
  const fixtureDir = path.join(TEST_AGENT_DIR, "retention-fixture");

  test("uses persistent package storage by default", () => {
    fs.rmSync(configFile, { force: true });
    expect(getRunsDir()).toBe(path.join(packageDir, "runs"));
  });

  test("keeps legacy temporary runs discoverable", () => {
    fs.rmSync(configFile, { force: true });
    const parentSessionId = "legacy-parent";
    const id = "11111111-1111-4111-8111-111111111111";
    const legacyRoot = path.join(process.env.PI_SUBAGENT_TEMP_DIR!, "pi-codex-subagents", os.userInfo().username, "runs");
    const legacyScope = path.join(legacyRoot, parentScopeKey(parentSessionId));
    fs.mkdirSync(legacyScope, { recursive: true });
    fs.writeFileSync(path.join(legacyScope, `${id}.info.json`), JSON.stringify({
      id,
      taskName: "legacy",
      status: "closed",
      finalResponse: "legacy response",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    expect(getAgent("legacy", parentSessionId)).toMatchObject({ id, status: "completed", finalResponse: "legacy response" });
    fs.rmSync(legacyScope, { recursive: true, force: true });
  });

  test("keeps agent lists in creation order when activity changes", async () => {
    fs.rmSync(configFile, { force: true });
    const parentSessionId = "creation-order";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    const now = Date.now();
    const agents = [
      { id: "11111111-1111-4111-8111-111111111111", taskName: "older", createdAt: now - 2000, lastActivity: now },
      { id: "22222222-2222-4222-8222-222222222222", taskName: "newer", createdAt: now - 1000, lastActivity: now - 1000 },
    ];
    fs.mkdirSync(scope, { recursive: true });
    for (const agent of agents) {
      fs.writeFileSync(path.join(scope, `${agent.id}.info.json`), JSON.stringify({
        ...agent,
        canonicalName: `/${agent.taskName}`,
        parentSessionId,
        status: "completed",
        updatedAt: agent.lastActivity,
      }));
    }

    const manager = new AgentManager();
    try {
      expect(manager.listAgents(undefined, parentSessionId).map((agent) => agent.agent_name)).toEqual(["/newer", "/older"]);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  test("removes expired runs and outputs using configurable retention", () => {
    fs.mkdirSync(packageDir, { recursive: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.writeFileSync(configFile, JSON.stringify({ storageDir: fixtureDir, retentionDays: 3 }));

    const now = Date.now();
    const oldTime = new Date(now - 4 * 24 * 60 * 60 * 1000);
    const scope = path.join(fixtureDir, "a".repeat(24));
    const unrelatedScope = path.join(fixtureDir, "unrelated");
    const outputs = path.join(fixtureDir, "_outputs");
    const expiredId = "11111111-1111-4111-8111-111111111111";
    const activeId = "22222222-2222-4222-8222-222222222222";
    const expiredInfo = path.join(scope, `${expiredId}.info.json`);
    const activeInfo = path.join(scope, `${activeId}.info.json`);
    const expiredOutput = path.join(outputs, `${oldTime.getTime()}-33333333-3333-4333-8333-333333333333.txt`);
    const activeMarker = path.join(process.env.PI_SUBAGENT_TEMP_DIR!, "pi-codex-subagents", os.userInfo().username, "sockets", `${activeId}.peek.json`);
    const unrelatedAgentFile = path.join(scope, `${expiredId}.notes`);
    const staleLock = path.join(scope, `.task-${"c".repeat(24)}.lock`);
    const liveOwnerLock = path.join(scope, `.task-${"d".repeat(24)}.lock`);

    try {
      fs.mkdirSync(scope, { recursive: true });
      fs.mkdirSync(unrelatedScope, { recursive: true });
      fs.mkdirSync(outputs, { recursive: true });
      fs.mkdirSync(path.dirname(activeMarker), { recursive: true });
      for (const [file, id] of [[expiredInfo, expiredId], [activeInfo, activeId]]) {
        fs.writeFileSync(file, JSON.stringify({
          id,
          createdAt: oldTime.getTime(),
          updatedAt: oldTime.getTime(),
          lastActivity: oldTime.getTime(),
        }));
        fs.utimesSync(file, oldTime, oldTime);
      }
      fs.writeFileSync(activeMarker, JSON.stringify({ pid: process.pid, startedAt: now, token: "test" }));
      fs.writeFileSync(unrelatedAgentFile, "keep");
      fs.writeFileSync(staleLock, "");
      fs.writeFileSync(liveOwnerLock, JSON.stringify({ pid: process.pid }));
      fs.utimesSync(staleLock, oldTime, oldTime);
      fs.utimesSync(liveOwnerLock, oldTime, oldTime);
      fs.writeFileSync(expiredOutput, "old");
      fs.utimesSync(expiredOutput, oldTime, oldTime);
      fs.writeFileSync(path.join(outputs, "unrelated.txt"), "keep");
      fs.writeFileSync(path.join(unrelatedScope, "unrelated.txt"), "keep");

      new AgentManager();
      expect(fs.existsSync(expiredInfo)).toBe(false);
      expect(fs.existsSync(activeInfo)).toBe(true);
      expect(fs.existsSync(unrelatedAgentFile)).toBe(true);
      expect(fs.existsSync(staleLock)).toBe(false);
      expect(fs.existsSync(liveOwnerLock)).toBe(true);
      expect(fs.existsSync(expiredOutput)).toBe(false);
      expect(fs.existsSync(path.join(outputs, "unrelated.txt"))).toBe(true);
      expect(fs.existsSync(path.join(unrelatedScope, "unrelated.txt"))).toBe(true);

      fs.writeFileSync(configFile, JSON.stringify({ storageDir: fixtureDir, retentionDays: 0 }));
      fs.writeFileSync(expiredInfo, "{}");
      fs.utimesSync(expiredInfo, oldTime, oldTime);
      new AgentManager();
      expect(fs.existsSync(expiredInfo)).toBe(true);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      fs.rmSync(activeMarker, { force: true });
      fs.rmSync(configFile, { force: true });
    }
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition.");
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function spawnParams(parentSessionId: string, task_name: string, message: string) {
  return {
    task_name,
    message,
    cwd: TEST_AGENT_DIR,
    parentSessionId,
    inheritedProvider: "test",
    inheritedModelId: "fake",
  };
}

describe("child process lifecycle", () => {
  test("hibernates after settle and lazily restarts the persisted session", async () => {
    fs.rmSync(path.join(TEST_AGENT_DIR, "pi-codex-subagents", "config.json"), { force: true });
    fs.rmSync(path.join(TEST_AGENT_DIR, "pi-codex-subagents", "SYSTEM.md"), { force: true });
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "lifecycle-settle";
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "first"));
      const first = manager.getAgentInfo("worker", parentSessionId);
      const firstPid = first.childProcess!.pid;
      await waitUntil(() => {
        const info = manager.getAgentInfo("worker", parentSessionId);
        return info.status === "completed" && !info.childProcess;
      });
      expect(pidAlive(firstPid)).toBe(false);
      expect(manager.readAgentResponse("worker", parentSessionId).finalResponse).toBe("response:first");

      expect(await manager.sendMessage(parentSessionId, "worker", "second")).toEqual({ delivery: "prompt" });
      const secondPid = manager.getAgentInfo("worker", parentSessionId).childProcess!.pid;
      expect(secondPid).not.toBe(firstPid);
      await waitUntil(() => {
        const info = manager.getAgentInfo("worker", parentSessionId);
        return info.status === "completed" && !info.childProcess;
      });
      expect(pidAlive(secondPid)).toBe(false);
      expect(manager.readAgentResponse("worker", parentSessionId).finalResponse).toBe("response:second");
      const sessionRecords = fs.readFileSync(first.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const starts = sessionRecords.filter((entry) => entry.type === "started");
      expect(new Set(starts.map((entry) => entry.pid)).size).toBe(2);
      const systemPromptIndex = starts[0].args.indexOf("--system-prompt");
      const systemPromptPath = starts[0].args[systemPromptIndex + 1];
      expect(path.isAbsolute(systemPromptPath)).toBe(true);
      expect(fs.readFileSync(systemPromptPath, "utf8")).toBe("You are a subagent working for a main agent. Work only on the assigned task and follow its scope precisely.");
      for (const start of starts) {
        expect(start.args).toContain("--no-context-files");
        expect(start.args.slice(start.args.indexOf("--system-prompt"), start.args.indexOf("--system-prompt") + 2)).toEqual([
          "--system-prompt",
          systemPromptPath,
        ]);
        expect(start.args.slice(start.args.indexOf("--append-system-prompt"), start.args.indexOf("--append-system-prompt") + 2)).toEqual([
          "--append-system-prompt",
          "",
        ]);
      }
    } finally {
      await manager.shutdown();
      fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  test("hibernates after failure while preserving the error", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "lifecycle-failure";
    const systemPromptFile = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "SYSTEM.md");
    const customSystemPrompt = "Use the custom subagent instructions.";
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(systemPromptFile), { recursive: true });
    fs.writeFileSync(systemPromptFile, customSystemPrompt);
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "fail now"));
      const started = manager.getAgentInfo("worker", parentSessionId);
      const pid = started.childProcess!.pid;
      expect(fs.readFileSync(systemPromptFile, "utf8")).toBe(customSystemPrompt);
      await waitUntil(() => {
        const info = manager.getAgentInfo("worker", parentSessionId);
        return info.status === "failed" && !info.childProcess;
      });
      const failed = manager.readAgentResponse("worker", parentSessionId);
      expect(failed.error).toBe("fake failure");
      expect(pidAlive(pid)).toBe(false);
    } finally {
      await manager.shutdown();
      fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
      fs.rmSync(systemPromptFile, { force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  test("rejects an empty configured system prompt instead of falling back to Pi's default", async () => {
    const parentSessionId = "empty-system-prompt";
    const systemPromptFile = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "SYSTEM.md");
    fs.mkdirSync(path.dirname(systemPromptFile), { recursive: true });
    fs.writeFileSync(systemPromptFile, "\n");
    const manager = new AgentManager();
    try {
      await expect(manager.spawnAgent(spawnParams(parentSessionId, "worker", "first"))).rejects.toThrow("Subagent system prompt is empty");
    } finally {
      await manager.shutdown();
      fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
      fs.rmSync(systemPromptFile, { force: true });
    }
  });

  test("interrupt terminates the child and clears runtime artifacts", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "lifecycle-interrupt";
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "hold interrupt"));
      const running = manager.getAgentInfo("worker", parentSessionId);
      const pid = running.childProcess!.pid;
      expect((await manager.interruptAgent(parentSessionId, "worker")).previous_status).toBe("running");
      const interrupted = manager.getAgentInfo("worker", parentSessionId);
      expect(interrupted.status).toBe("interrupted");
      expect(interrupted.childProcess).toBeUndefined();
      expect(pidAlive(pid)).toBe(false);
      const socketDir = path.join(process.env.PI_SUBAGENT_TEMP_DIR!, "pi-codex-subagents", os.userInfo().username, "sockets");
      expect(fs.existsSync(path.join(socketDir, `${running.id}.active.json`))).toBe(false);
      expect(fs.existsSync(path.join(socketDir, `${running.id}.peek.json`))).toBe(false);
      if (process.platform !== "win32") expect(fs.existsSync(getSocketPath(running.id))).toBe(false);
    } finally {
      await manager.shutdown();
      fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  test("reconciles owned children without risking PID-reuse kills", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "lifecycle-reconcile";
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
    const owner = new AgentManager();
    const reconcilers: AgentManager[] = [];
    try {
      await owner.spawnAgent(spawnParams(parentSessionId, "orphan", "hold orphan"));
      const orphanPid = owner.getAgentInfo("orphan", parentSessionId).childProcess!.pid;
      const reconciler = new AgentManager();
      reconcilers.push(reconciler);
      await waitUntil(() => {
        const info = reconciler.getAgentInfo("orphan", parentSessionId);
        return info.status === "interrupted" && !info.childProcess;
      });
      await waitUntil(() => !pidAlive(orphanPid));
      expect(pidAlive(orphanPid)).toBe(false);

      await owner.spawnAgent(spawnParams(parentSessionId, "pid-reuse", "hold identity"));
      const mismatched = owner.getAgentInfo("pid-reuse", parentSessionId);
      const mismatchedPid = mismatched.childProcess!.pid;
      mismatched.childProcess!.processIdentity = "not-the-owned-process";
      fs.writeFileSync(mismatched.infoFile, JSON.stringify(mismatched, null, 2));
      const mismatchReconciler = new AgentManager();
      reconcilers.push(mismatchReconciler);
      await waitUntil(() => {
        const info = mismatchReconciler.getAgentInfo("pid-reuse", parentSessionId);
        return info.status === "interrupted" && !info.childProcess;
      });
      expect(pidAlive(mismatchedPid)).toBe(true);
      await owner.shutdown();
      expect(pidAlive(mismatchedPid)).toBe(false);
    } finally {
      await Promise.all([owner.shutdown(), ...reconcilers.map((manager) => manager.shutdown())]);
      fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
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
