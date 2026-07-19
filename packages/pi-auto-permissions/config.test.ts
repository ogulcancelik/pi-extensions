import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAutoPermissionsConfig } from "./config.js";

const tempDirs: string[] = [];

function configFile(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-auto-permissions-"));
  tempDirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("auto permissions config", () => {
  test("uses an empty policy when the config is missing", () => {
    const config = loadAutoPermissionsConfig(join(tmpdir(), "missing-auto-permissions-config.json"));
    expect(config.enabled).toBeTrue();
    expect(config.reviewer).toBeUndefined();
    expect(config.rules).toEqual([]);
    expect(config.reviewEvidence).toEqual({ projectInstructions: false });
    expect(config.ui).toEqual({ enabled: true, resultDisplayMs: 2500, placement: "widget" });
  });

  test("selects a reviewer and loads rules", () => {
    const path = configFile({
      reviewer: {
        provider: "openai-codex",
        model: "gpt-5.4",
        reasoningEffort: "medium",
        timeoutMs: 12_000,
      },
      systemPrompt: "custom permission policy",
      reviewEvidence: { projectInstructions: true },
      ui: { enabled: true, resultDisplayMs: 5000, placement: "toolRow" },
      rules: [
        {
          pattern: "\\brm\\s+-rf\\b",
          level: "guarded",
          group: "filesystem",
          label: "Recursive delete",
        },
      ],
    });

    const config = loadAutoPermissionsConfig(path);
    expect(config.reviewer).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
      reasoningEffort: "medium",
      timeoutMs: 12_000,
    });
    expect(config.systemPrompt).toBe("custom permission policy");
    expect(config.reviewEvidence).toEqual({ projectInstructions: true });
    expect(config.ui).toEqual({ enabled: true, resultDisplayMs: 5000, placement: "toolRow" });
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0].pattern.test("rm -rf build")).toBeTrue();
  });

  test("loads a prompt file relative to the config", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-auto-permissions-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "prompt.md"), "review carefully\n", "utf8");
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ systemPromptFile: "./prompt.md" }), "utf8");

    expect(loadAutoPermissionsConfig(path).systemPrompt).toBe("review carefully");
  });
});
