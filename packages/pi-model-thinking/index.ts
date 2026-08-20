import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_FILENAME = "model-thinking.json";

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof ALL_LEVELS)[number];

interface ModelThinkingConfig {
	models?: Record<string, ThinkingLevel>;
	providers?: Record<string, ThinkingLevel>;
}

let cachedPath: string | undefined;
let cachedStamp: string | undefined;
let cachedConfig: ModelThinkingConfig | undefined;

/** Tracks which model we consider "active" to ignore native pre-model_select thinking events. */
let activeModelKey: string | undefined;

/** Tracks our own programmatic setThinkingLevel calls so we don't record them as user changes. */
let lastProgrammaticSet: { modelKey: string; level: ThinkingLevel } | undefined;

function configPath(): string {
	return join(homedir(), ".pi", "agent", CONFIG_FILENAME);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && ALL_LEVELS.includes(value as ThinkingLevel);
}

function fileStamp(path: string): string | undefined {
	try {
		const stat = statSync(path);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return undefined;
	}
}

function loadConfig(): ModelThinkingConfig {
	const path = configPath();
	const stamp = fileStamp(path);
	if (cachedConfig !== undefined && cachedPath === path && cachedStamp === stamp) {
		return cachedConfig;
	}

	cachedPath = path;
	cachedStamp = stamp;

	if (!existsSync(path)) {
		cachedConfig = {};
		return cachedConfig;
	}

	try {
		const raw = readFileSync(path, "utf8");
		cachedConfig = normalizeConfig(JSON.parse(raw));
		return cachedConfig;
	} catch {
		cachedConfig = {};
		return cachedConfig;
	}
}

function saveConfig(config: ModelThinkingConfig): void {
	const path = configPath();
	try {
		writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
		cachedConfig = config;
		cachedPath = path;
		cachedStamp = fileStamp(path);
	} catch (error) {
		console.error("[pi-model-thinking] failed to save config:", error);
	}
}

function normalizeConfig(value: unknown): ModelThinkingConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const input = value as Record<string, unknown>;

	const normalizeRecord = (key: string): Record<string, ThinkingLevel> | undefined => {
		const raw = input[key];
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		const result: Record<string, ThinkingLevel> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (isThinkingLevel(v)) result[k] = v;
		}
		return Object.keys(result).length > 0 ? result : undefined;
	};

	return {
		models: normalizeRecord("models"),
		providers: normalizeRecord("providers"),
	};
}

function resolveThinkingLevel(ctx: ExtensionContext): ThinkingLevel | undefined {
	const model = ctx.model;
	if (!model) return undefined;

	const modelKey = `${model.provider}/${model.id}`;
	const config = loadConfig();

	if (config.models?.[modelKey]) {
		return config.models[modelKey];
	}

	if (config.providers?.[model.provider]) {
		return config.providers[model.provider];
	}

	return undefined;
}

function providerLevel(ctx: ExtensionContext): ThinkingLevel | undefined {
	const model = ctx.model;
	if (!model) return undefined;
	return loadConfig().providers?.[model.provider];
}

function isManaged(ctx: ExtensionContext): boolean {
	return resolveThinkingLevel(ctx) !== undefined;
}

function modelKey(model: NonNullable<ExtensionContext["model"]>): string {
	return `${model.provider}/${model.id}`;
}

function applyModelThinking(pi: ExtensionAPI, ctx: ExtensionContext, silent = false): void {
	const level = resolveThinkingLevel(ctx);
	if (!level) return;

	const model = ctx.model;
	if (!model) return;

	lastProgrammaticSet = { modelKey: modelKey(model), level };
	const before = pi.getThinkingLevel();
	pi.setThinkingLevel(level);
	const after = pi.getThinkingLevel();
	// Note: we do NOT clear lastProgrammaticSet here. The thinking_level_select
	// handler will run AFTER this function returns, and we need it to still match.

	if (after !== before && !silent) {
		ctx.ui.notify(`Thinking: ${before} → ${after}`, "info");
	}
}

function updateConfigForModel(ctx: ExtensionContext, level: ThinkingLevel): void {
	const model = ctx.model;
	if (!model) return;

	const key = modelKey(model);
	const config = loadConfig();
	const provLevel = providerLevel(ctx);

	// If user set back to provider default, remove the exact model entry
	if (provLevel !== undefined && level === provLevel) {
		if (config.models?.[key]) {
			config.models = { ...config.models };
			delete config.models[key];
			if (Object.keys(config.models).length === 0) {
				delete config.models;
			}
			saveConfig(config);
		}
		return;
	}

	// No-op if already the same
	if (config.models?.[key] === level) return;

	config.models = { ...(config.models ?? {}), [key]: level };
	saveConfig(config);
}

export default function modelThinkingExtension(pi: ExtensionAPI) {
	pi.on("model_select", async (event, ctx) => {
		activeModelKey = modelKey(event.model);

		const silent = event.source === "restore";
		applyModelThinking(pi, ctx, silent);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.model) {
			activeModelKey = modelKey(ctx.model);
			applyModelThinking(pi, ctx, true);
		}
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		if (!ctx.model) return;

		const currentKey = modelKey(ctx.model);

		// Ignore thinking events emitted by pi during model switches before model_select fires.
		// ctx.model is already the new model, but activeModelKey hasn't been updated yet.
		if (activeModelKey && currentKey !== activeModelKey) {
			return;
		}

		// Ignore our own programmatic setThinkingLevel calls.
		if (lastProgrammaticSet && lastProgrammaticSet.modelKey === currentKey && lastProgrammaticSet.level === event.level) {
			lastProgrammaticSet = undefined;
			return;
		}

		// Only record if this model is managed by our config
		if (!isManaged(ctx)) return;

		updateConfigForModel(ctx, event.level);
	});

	pi.registerCommand("model-thinking", {
		description: "Show or reset model-specific thinking levels",
		handler: async (args, ctx) => {
			const cmd = args?.trim() ?? "";

			if (cmd === "reset") {
				const path = configPath();
				if (existsSync(path)) {
					try {
						const { rmSync } = await import("node:fs");
						rmSync(path);
						cachedConfig = {};
						cachedPath = undefined;
						cachedStamp = undefined;
						ctx.ui.notify("Model-thinking config cleared.", "info");
						return;
					} catch {
						ctx.ui.notify("Failed to clear config file.", "error");
						return;
					}
				}
				ctx.ui.notify("No config file to clear.", "info");
				return;
			}

			const model = ctx.model;
			const currentKey = model ? modelKey(model) : undefined;
			const config = loadConfig();
			const managed = model ? isManaged(ctx) : false;
			const level = resolveThinkingLevel(ctx);

			const lines: string[] = [];
			lines.push(`model: ${currentKey ?? "none"}`);
			lines.push(`managed: ${managed ? "yes" : "no"}`);
			lines.push(`file: ${configPath()}`);

			if (managed) {
				lines.push(`resolved: ${level}`);
				lines.push(`current: ${pi.getThinkingLevel()}`);
			} else {
				lines.push(`resolved: none — pi handles this model natively`);
				lines.push(`current: ${pi.getThinkingLevel()}`);
			}

			lines.push("");
			lines.push("run `/model-thinking reset` to clear all remembered levels");

			const message = lines.join("\n");
			if (ctx.hasUI) {
				ctx.ui.notify(message, managed ? "info" : "warning");
			} else {
				console.log(message);
			}
		},
	});
}
