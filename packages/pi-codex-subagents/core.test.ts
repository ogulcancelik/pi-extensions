import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

const TEST_AGENT_DIR = "/tmp/pi-codex-subagents-tests";
const FAKE_RPC_CHILD = path.join(import.meta.dir, "test", "fake-rpc-child.js");
process.env.PI_SUBAGENT_TEMP_DIR = path.join(TEST_AGENT_DIR, "temp");

const codingAgent = await import("@earendil-works/pi-coding-agent");
mock.module("@earendil-works/pi-coding-agent", () => ({
  ...codingAgent,
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

describe("spawn model and thinking resolution", () => {
  test("caller wins, then the template, then the inherited value, then the default", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "spawn-overrides";
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
    const templateFile = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "agents", "routed.md");
    fs.mkdirSync(path.dirname(templateFile), { recursive: true });
    fs.writeFileSync(templateFile, "---\nname: routed\nprovider: template-provider\nmodel: template-model\nthinking: medium\n---\nRouted template.");
    const manager = new AgentManager();
    const spawn = async (task: string, overrides: Record<string, unknown>) => {
      await manager.spawnAgent({ ...spawnParams(parentSessionId, task, "work"), inheritedThinking: "low", ...overrides });
      return manager.getAgentInfo(task, parentSessionId);
    };
    const callerModel = { model: { provider: "openai", modelId: "gpt-5" } };
    try {
      expect(await spawn("inherited", {})).toMatchObject({ model: "test:fake", thinking: "low" });
      expect(await spawn("caller-model", callerModel)).toMatchObject({ model: "openai:gpt-5", thinking: "low" });
      expect(await spawn("caller-thinking", { thinking: "max" })).toMatchObject({ model: "test:fake", thinking: "max" });
      expect(await spawn("template", { agent_type: "routed" })).toMatchObject({ model: "template-provider:template-model", thinking: "medium" });
      expect(await spawn("caller-beats-template", { agent_type: "routed", ...callerModel, thinking: "xhigh" })).toMatchObject({ model: "openai:gpt-5", thinking: "xhigh" });
      // No level requested anywhere, not even by the parent, falls back to the package default.
      await manager.spawnAgent(spawnParams(parentSessionId, "default-thinking", "work"));
      expect(manager.getAgentInfo("default-thinking", parentSessionId)).toMatchObject({ model: "test:fake", thinking: "high" });
      await expect(spawn("missing", { agent_type: "absent" })).rejects.toThrow("Agent template not found");
    } finally {
      await manager.shutdown();
      fs.rmSync(templateFile, { force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });
});

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

  test("accepts Darwin process ownership when ps cannot expose the token", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "lifecycle-darwin";
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "hold darwin"));
      const running = manager.getAgentInfo("worker", parentSessionId);
      expect(running.childProcess?.pid).toBeNumber();
      expect(pidAlive(running.childProcess!.pid)).toBe(true);
    } finally {
      try {
        await manager.shutdown();
      } finally {
        Object.defineProperty(process, "platform", platformDescriptor);
        fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
        delete process.env.PI_SUBAGENT_PI_BIN;
      }
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

describe("completion delivery", () => {
  test("publishes unclaimed settled and abnormal-exit completions", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "completion-callbacks";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event: any) => completions.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "settled", "first"));
      await waitUntil(() => completions.some((event) => event.agentName === "/settled"));
      expect(completions.filter((event) => event.agentName === "/settled")).toHaveLength(1);
      expect(completions.find((event) => event.agentName === "/settled")).toMatchObject({
        status: "completed",
        finalResponse: "response:first",
      });

      await manager.spawnAgent(spawnParams(parentSessionId, "crashed", "crash now"));
      await waitUntil(() => completions.some((event) => event.agentName === "/crashed"));
      expect(completions.filter((event) => event.agentName === "/crashed")).toHaveLength(1);
      expect(completions.find((event) => event.agentName === "/crashed")).toMatchObject({ status: "failed" });
      expect(completions.find((event) => event.agentName === "/crashed").error).toContain("code=23");
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  test("suppresses automatic delivery while wait tools claim completions", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "completion-waits";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event: any) => completions.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "one", "first"));
      const waited = await manager.waitAgent(parentSessionId, ["one"]);
      expect(waited.event).toMatchObject({ agentName: "/one", status: "completed" });
      expect(completions).toEqual([]);

      await manager.spawnAgent(spawnParams(parentSessionId, "two", "second"));
      const all = await manager.waitAllAgents(parentSessionId, ["two"]);
      expect(all.responses).toEqual([expect.objectContaining({ agent_name: "/two", status: "completed" })]);
      expect(completions).toEqual([]);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  test("releases suppressed completions when wait_all_agents is cancelled", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "completion-wait-cancel";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event: any) => completions.push(event) });
    const controller = new AbortController();
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "slow", "hold slow"));
      await manager.spawnAgent(spawnParams(parentSessionId, "fast", "fast"));
      const wait = manager.waitAllAgents(parentSessionId, ["slow", "fast"], controller.signal);
      await waitUntil(() => manager.getAgentInfo("fast", parentSessionId).status === "completed");
      expect(completions).toEqual([]);
      controller.abort(new Error("cancelled"));
      await expect(wait).rejects.toThrow("aborted");
      await waitUntil(() => completions.some((event) => event.agentName === "/fast"));
      expect(completions.filter((event) => event.agentName === "/fast")).toHaveLength(1);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  test("reports active and inactive lifecycle transitions", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "status-transitions";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const activity: boolean[] = [];
    const manager = new AgentManager({
      onActivityChange: (event: any) => {
        if (event.parentSessionId === parentSessionId) activity.push(event.active);
      },
    });
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "first"));
      await waitUntil(() => manager.getAgentInfo("worker", parentSessionId).status === "completed");
      expect(activity).toContain(true);
      expect(activity.at(-1)).toBe(false);

      const settled = manager.getAgentInfo("worker", parentSessionId);
      const rejectedAt = activity.length;
      await expect(manager.sendMessage(parentSessionId, "worker", "reject restart")).rejects.toThrow("fake prompt rejection");
      expect(manager.getAgentInfo("worker", parentSessionId)).toMatchObject({
        status: "completed",
        finalResponse: settled.finalResponse,
        completedAt: settled.completedAt,
      });
      expect(manager.getAgentInfo("worker", parentSessionId).childProcess).toBeUndefined();
      expect(activity.slice(rejectedAt)).toContain(true);
      expect(activity.at(-1)).toBe(false);

      const restartAt = activity.length;
      await manager.sendMessage(parentSessionId, "worker", "hold restart");
      expect(activity.slice(restartAt)).toContain(true);
      await manager.interruptAgent(parentSessionId, "worker");
      expect(activity.at(-1)).toBe(false);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });
});

describe("extension completion delivery and TUI", () => {
  test("registers commands, renders one-line activity, and delivers bounded completions", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const renderers = new Map<string, any>();
    const sentMessages: Array<{ message: any; options: any }> = [];
    let widget: any;
    const pi: any = {
      on(name: string, handler: (event: any, ctx: any) => any) {
        const entries = handlers.get(name) ?? [];
        entries.push(handler);
        handlers.set(name, entries);
      },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      registerMessageRenderer(name: string, renderer: any) { renderers.set(name, renderer); },
      sendMessage(message: any, options: any) { sentMessages.push({ message, options }); },
      getThinkingLevel() { return "high"; },
      getActiveTools() { return ["read", "bash"]; },
    };
    const parentSessionId = "index-integration-parent";
    const availableModels = [
      { provider: "test", id: "fake" },
      { provider: "fireworks", id: "accounts/fireworks/models/glm-5p2" },
      { provider: "openai", id: "gpt-5" },
    ];
    const notifications: string[] = [];
    const ctx: any = {
      cwd: TEST_AGENT_DIR,
      mode: "tui",
      model: { provider: "test", id: "fake" },
      modelRegistry: { getAvailable: () => availableModels },
      // What pi resolved the enabledModels patterns to for this session, availability-checked.
      scopedModels: [
        { model: { provider: "fireworks", id: "accounts/fireworks/models/glm-5p2" } },
        { model: { provider: "openai", id: "gpt-5" } },
      ],
      sessionManager: {
        getSessionId: () => parentSessionId,
        getSessionFile: () => path.join(TEST_AGENT_DIR, "parent.jsonl"),
      },
      ui: {
        setWidget(_key: string, value: any) { widget = value; },
        notify(message: string) { notifications.push(message); },
      },
    };
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const configFile = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "config.json");
    // A thinking suffix on an allowlist entry is tolerated and stripped from the offered pair.
    fs.writeFileSync(configFile, JSON.stringify({ models: ["test/fake:high", "typo/nope"], modelsFromEnabledModels: true }));
    const { default: subagentExtension } = await import("./index.js");
    subagentExtension(pi);
    const emit = async (name: string, event: any = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    };

    // Session start is the single resolution point, so before it the arguments are absent.
    const spawnArgs = () => tools.get("spawn_agent").parameters.properties;
    expect(spawnArgs().model).toBeUndefined();
    expect(spawnArgs().thinking).toBeUndefined();

    try {
      // Session start is authoritative: allowlist entries filtered to what is available,
      // unioned with pi's scoped models, and the schema must not wait for a first turn.
      await emit("session_start", { reason: "startup" });
      expect(spawnArgs().model.enum).toEqual(["test/fake", "fireworks/accounts/fireworks/models/glm-5p2", "openai/gpt-5"]);
      expect(spawnArgs().thinking.enum).toContain("max");
      expect(notifications).toEqual(['spawn_agent models not available: typo/nope']);
      // The values live in the schema, but the description has to say the capability exists.
      expect(tools.get("spawn_agent").description).toContain("`model` takes one of the values its schema lists");
      expect(commands.has("agents")).toBe(true);
      expect(commands.has("subagent")).toBe(true);
      expect(commands.has("subagents")).toBe(true);
      expect(renderers.has("pi-codex-subagent-completion")).toBe(true);

      await tools.get("spawn_agent").execute("spawn-1", {
        task_name: "x".repeat(200),
        message: "slow finish",
      }, undefined, undefined, ctx);

      expect(widget).toBeFunction();
      const theme = { fg: (_color: string, text: string) => text };
      const lines = widget({}, theme).render(40);
      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0])).toBeLessThanOrEqual(40);
      expect(lines[0]).toContain("/subagents");

      await waitUntil(() => sentMessages.length === 1);
      expect(widget).toBeUndefined();
      expect(sentMessages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
      expect(sentMessages[0].message.content).toContain("response:slow finish");

      await tools.get("spawn_agent").execute("spawn-2", {
        task_name: "large-output",
        message: "large response",
      }, undefined, undefined, ctx);
      await waitUntil(() => sentMessages.length === 2);
      const large = sentMessages[1].message;
      expect(Buffer.byteLength(large.content, "utf8")).toBeLessThanOrEqual(50 * 1024);
      expect(large.content).toContain("Output truncated");
      expect(large.details.fullOutputPath).toBeString();
      expect(fs.existsSync(large.details.fullOutputPath)).toBe(true);

      await tools.get("spawn_agent").execute("spawn-3", {
        task_name: "routed",
        message: "slow finish",
        model: "fireworks/accounts/fireworks/models/glm-5p2",
        thinking: "max",
      }, undefined, undefined, ctx);
      expect(getAgent("routed", parentSessionId)).toMatchObject({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/glm-5p2",
        thinking: "max",
      });
      // A model the registry has, but neither list allows, is refused.
      await expect(tools.get("spawn_agent").execute("spawn-4", { task_name: "not-enabled", message: "x", model: "anthropic/claude-opus-4-6" }, undefined, undefined, ctx))
        .rejects.toThrow(/not in the configured spawn models/);

      // An allowlisted model whose provider dropped out mid-session is refused at spawn time,
      // covering both availability drift and schemas frozen before the session started.
      availableModels.splice(availableModels.findIndex((entry) => entry.provider === "openai"), 1);
      await expect(tools.get("spawn_agent").execute("spawn-5", { task_name: "gone", message: "x", model: "openai/gpt-5" }, undefined, undefined, ctx))
        .rejects.toThrow(/not currently available/);

      // Unconfigured takes both runtime arguments away again even though Pi still has enabledModels.
      fs.writeFileSync(configFile, "{}");
      await emit("session_start", { reason: "restart" });
      expect(spawnArgs().model).toBeUndefined();
      expect(spawnArgs().thinking).toBeUndefined();
      expect(tools.get("spawn_agent").description).not.toContain("`model` takes one of the values");
    } finally {
      await emit("session_shutdown", { reason: "quit" });
      fs.rmSync(scope, { recursive: true, force: true });
      fs.rmSync(configFile, { force: true });
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
