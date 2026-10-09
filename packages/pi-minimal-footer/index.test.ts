import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import extension from "./index.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync("/var/tmp/pi-minimal-footer-test-");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeAuth(directory: string, access: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "auth.json"), JSON.stringify({ anthropic: { access } }));
}

function checkAuth(agentDir: string | undefined, expected: Record<string, unknown>): void {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.PI_CODING_AGENT_DIR;
  if (agentDir !== undefined) env.PI_CODING_AGENT_DIR = agentDir;
  // Start with an isolated home before Bun or Pi can cache it. Never print credentials.
  const script = `
    import { homedir } from "node:os";
    import { loadAuthJson } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    if (homedir() !== ${JSON.stringify(home)}) process.exit(2);
    console.log(JSON.stringify(loadAuthJson()) === ${JSON.stringify(JSON.stringify(expected))});
  `;
  const result = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("true");
}

describe("footer auth directory", () => {
  test("reads credentials from the default agent directory", () => {
    writeAuth(join(home, ".pi", "agent"), "default-token");
    checkAuth(undefined, { anthropic: { access: "default-token" } });
  });

  test("reads the absolute override instead of default credentials", () => {
    writeAuth(join(home, ".pi", "agent"), "wrong-account");
    const agentDir = join(home, "custom-agent");
    writeAuth(agentDir, "custom-token");
    checkAuth(agentDir, { anthropic: { access: "custom-token" } });
  });

  test("expands a tilde in the agent directory override", () => {
    writeAuth(join(home, "custom-agent"), "custom-token");
    checkAuth("~/custom-agent", { anthropic: { access: "custom-token" } });
  });

  test("does not fall back to another account when override credentials are missing", () => {
    writeAuth(join(home, ".pi", "agent"), "wrong-account");
    checkAuth(join(home, "missing-agent"), {});
  });
});

async function startFooter(ctx: Record<string, unknown>) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  extension({ on: (event: string, handler: any) => handlers.set(event, handler) } as any);
  let factory: any;
  await handlers.get("session_start")!(
    {},
    {
      hasUI: true,
      cwd: "/tmp",
      model: { provider: "cursor", id: "grok-4.7", contextWindow: 256000, reasoning: false },
      ui: { setFooter: (f: unknown) => (factory = f) },
      ...ctx,
    },
  );
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const footer = factory({ requestRender() {} }, theme, { onBranchChange: () => () => {} });
  const contextGauge = (width = 200) => {
    const line = footer.render(width).find((l: string) => l.includes("ctx "));
    return line.slice(line.indexOf("ctx "));
  };
  return { footer, contextGauge };
}

function sessionWithResponse(contextTokens: number) {
  const usage = { input: contextTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: contextTokens };
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp: "", message: { role: "user", content: "hi", timestamp: 0 } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "",
      message: { role: "assistant", content: [], usage, stopReason: "stop", timestamp: 0 },
    },
  ];
  return { getEntries: () => entries, getLeafId: () => "a1" };
}

const unknownAfterCompaction = () => ({ tokens: null, contextWindow: 256000, percent: null });

describe("context gauge", () => {
  test("shows pi's context usage, which includes messages after the last response", async () => {
    const { footer, contextGauge } = await startFooter({
      sessionManager: sessionWithResponse(140000),
      getContextUsage: () => ({ tokens: 152187, contextWindow: 256000, percent: (152187 / 256000) * 100 }),
    });
    expect(contextGauge()).toBe("ctx ━━━━━━━───── 59% 152k/256k");
    footer.dispose();
  });

  test("shows an unknown size after a compaction instead of the last response", async () => {
    const { footer, contextGauge } = await startFooter({
      sessionManager: sessionWithResponse(304372),
      getContextUsage: unknownAfterCompaction,
    });
    expect(contextGauge()).toBe("ctx ──────────── ?/256k");
    expect(contextGauge(20)).toBe("ctx ────────── ?");
    footer.dispose();
  });

  test("uses the last response when pi has no getContextUsage", async () => {
    const { footer, contextGauge } = await startFooter({ sessionManager: sessionWithResponse(73000) });
    expect(contextGauge()).toBe("ctx ━━━───────── 29% 73k/256k");
    expect(contextGauge(20)).toBe("ctx ━━━─────── 29%");
    footer.dispose();
  });
});
