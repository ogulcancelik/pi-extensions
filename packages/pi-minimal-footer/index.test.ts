import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
