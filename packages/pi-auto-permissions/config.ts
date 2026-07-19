import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Gate, GateLevel } from "./gates.js";
import { AUTO_PERMISSIONS_SYSTEM_PROMPT } from "./review.js";

export const CONFIG_FILENAME = "pi-auto-permissions/config.json";

const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export interface AutoPermissionsConfig {
  enabled: boolean;
  reviewer?: {
    provider: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    timeoutMs: number;
  };
  systemPrompt: string;
  reviewEvidence: {
    projectInstructions: boolean;
  };
  rules: Gate[];
  ui: {
    enabled: boolean;
    resultDisplayMs: number;
    placement: "widget" | "toolRow";
  };
}

interface RuleInput {
  pattern?: unknown;
  flags?: unknown;
  level?: unknown;
  group?: unknown;
  label?: unknown;
  message?: unknown;
}

function configPath(): string {
  return process.env.PI_AUTO_PERMISSIONS_CONFIG
    ? resolve(process.env.PI_AUTO_PERMISSIONS_CONFIG)
    : join(getAgentDir(), CONFIG_FILENAME);
}

function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("auto permissions config must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function compileRule(value: unknown, index: number): Gate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`rules[${index}] must be an object`);
  }
  const input = value as RuleInput;
  const pattern = optionalString(input.pattern, `rules[${index}].pattern`);
  const group = optionalString(input.group, `rules[${index}].group`);
  const label = optionalString(input.label, `rules[${index}].label`);
  if (!pattern || !group || !label) throw new Error(`rules[${index}] requires pattern, group, and label`);
  const flags = input.flags === undefined ? "i" : input.flags;
  if (typeof flags !== "string") throw new Error(`rules[${index}].flags must be a string`);
  const level: GateLevel = input.level === undefined ? "guarded" : input.level as GateLevel;
  if (level !== "guarded" && level !== "convention") {
    throw new Error(`rules[${index}].level must be guarded or convention`);
  }
  const message = optionalString(input.message, `rules[${index}].message`);
  if (level === "convention" && !message) throw new Error(`rules[${index}].message is required for convention rules`);

  return {
    pattern: new RegExp(pattern, flags),
    level,
    group,
    label,
    message,
  };
}

function resolvePrompt(raw: Record<string, unknown>, path: string): string {
  const inline = optionalString(raw.systemPrompt, "systemPrompt");
  const file = optionalString(raw.systemPromptFile, "systemPromptFile");
  if (inline && file) throw new Error("set only one of systemPrompt and systemPromptFile");
  if (inline) return inline;
  if (!file) return AUTO_PERMISSIONS_SYSTEM_PROMPT;

  const expanded = file.startsWith("~/") ? join(homedir(), file.slice(2)) : file;
  const resolved = isAbsolute(expanded) ? expanded : resolve(dirname(path), expanded);
  const prompt = readFileSync(resolved, "utf8").trim();
  if (!prompt) throw new Error("systemPromptFile is empty");
  return prompt;
}

function resolveReviewEvidence(raw: Record<string, unknown>): AutoPermissionsConfig["reviewEvidence"] {
  if (raw.reviewEvidence === undefined) return { projectInstructions: false };
  if (!raw.reviewEvidence || typeof raw.reviewEvidence !== "object" || Array.isArray(raw.reviewEvidence)) {
    throw new Error("reviewEvidence must be an object");
  }
  const evidence = raw.reviewEvidence as Record<string, unknown>;
  if (evidence.projectInstructions !== undefined && typeof evidence.projectInstructions !== "boolean") {
    throw new Error("reviewEvidence.projectInstructions must be boolean");
  }
  return { projectInstructions: evidence.projectInstructions === true };
}

function resolveUi(raw: Record<string, unknown>): AutoPermissionsConfig["ui"] {
  if (raw.ui === undefined) return { enabled: true, resultDisplayMs: 2500, placement: "widget" };
  if (!raw.ui || typeof raw.ui !== "object" || Array.isArray(raw.ui)) {
    throw new Error("ui must be an object");
  }
  const ui = raw.ui as Record<string, unknown>;
  if (ui.enabled !== undefined && typeof ui.enabled !== "boolean") {
    throw new Error("ui.enabled must be boolean");
  }
  const resultDisplayMs = ui.resultDisplayMs === undefined ? 2500 : ui.resultDisplayMs;
  if (!Number.isInteger(resultDisplayMs) || Number(resultDisplayMs) < 0 || Number(resultDisplayMs) > 30_000) {
    throw new Error("ui.resultDisplayMs must be an integer between 0 and 30000");
  }
  const placement = ui.placement ?? "widget";
  if (placement !== "widget" && placement !== "toolRow") {
    throw new Error("ui.placement must be widget or toolRow");
  }
  return { enabled: ui.enabled !== false, resultDisplayMs: Number(resultDisplayMs), placement };
}

function resolveReviewer(raw: Record<string, unknown>): AutoPermissionsConfig["reviewer"] {
  if (raw.reviewer === undefined) return undefined;
  if (!raw.reviewer || typeof raw.reviewer !== "object" || Array.isArray(raw.reviewer)) {
    throw new Error("reviewer must be an object");
  }
  const reviewer = raw.reviewer as Record<string, unknown>;
  const provider = optionalString(reviewer.provider, "reviewer.provider");
  const model = optionalString(reviewer.model, "reviewer.model");
  if (!provider || !model) throw new Error("reviewer requires both provider and model");
  const reasoningEffort = (optionalString(reviewer.reasoningEffort, "reviewer.reasoningEffort") ?? "low") as ReasoningEffort;
  if (!REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new Error("reviewer.reasoningEffort is invalid");
  }
  const timeoutMs = reviewer.timeoutMs === undefined ? 30_000 : reviewer.timeoutMs;
  if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 1_000 || Number(timeoutMs) > 300_000) {
    throw new Error("reviewer.timeoutMs must be an integer between 1000 and 300000");
  }
  return { provider, model, reasoningEffort, timeoutMs: Number(timeoutMs) };
}

export function loadAutoPermissionsConfig(path = configPath()): AutoPermissionsConfig {
  const raw = readObject(path);
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error("enabled must be boolean");
  if (raw.rules !== undefined && !Array.isArray(raw.rules)) throw new Error("rules must be an array");
  const customRules = (raw.rules ?? []).map(compileRule);

  return {
    enabled: raw.enabled !== false,
    reviewer: resolveReviewer(raw),
    systemPrompt: resolvePrompt(raw, path),
    reviewEvidence: resolveReviewEvidence(raw),
    rules: customRules,
    ui: resolveUi(raw),
  };
}
