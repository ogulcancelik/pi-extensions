import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import modelThinkingExtension from "./index";

const testDirs: string[] = [];
const originalConfigOverride = process.env.PI_MODEL_THINKING_CONFIG;

function readConfig(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Fresh config file per test. Uses PI_MODEL_THINKING_CONFIG rather than
 * PI_CODING_AGENT_DIR: pi-codex-subagents mocks getAgentDir module-wide, and
 * bun's mock.module is process-global, so a directory override is not stable
 * when the whole suite runs in one process.
 */
function useAgentDir(seed?: unknown): string {
	const dir = `/tmp/pi-model-thinking-tests/${process.pid}-${testDirs.length}`;
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	testDirs.push(dir);

	const configFile = join(dir, "model-thinking.json");
	process.env.PI_MODEL_THINKING_CONFIG = configFile;
	if (seed !== undefined) writeFileSync(configFile, JSON.stringify(seed, null, 2) + "\n", "utf8");
	return configFile;
}

/**
 * Minimal stand-in for pi's agent session. setThinkingLevel emits
 * thinking_level_select only when the level actually changes, matching
 * AgentSession.setThinkingLevel.
 */
function harness(model: { provider: string; id: string }) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let level = "medium";
	const ctx = {
		model,
		hasUI: false,
		ui: { notify() {} },
	};

	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const existing = handlers.get(name);
			handlers.set(name, existing ? async (e, c) => (await existing(e, c), handler(e, c)) : handler);
		},
		registerCommand() {},
		getThinkingLevel: () => level,
		setThinkingLevel(next: string) {
			const previous = level;
			level = next;
			if (next !== previous) {
				void handlers.get("thinking_level_select")?.(
					{ type: "thinking_level_select", level: next, previousLevel: previous },
					ctx,
				);
			}
		},
	};

	modelThinkingExtension(pi as never);

	return {
		getLevel: () => level,
		async selectModel(source: "set" | "cycle" | "restore" = "set") {
			await handlers.get("model_select")?.({ type: "model_select", model, previousModel: undefined, source }, ctx);
		},
		async startSession(reason: "startup" | "resume" = "startup") {
			await handlers.get("session_start")?.({ type: "session_start", reason }, ctx);
		},
		async userChangesLevel(level: string) {
			const previous = level;
			await handlers.get("thinking_level_select")?.(
				{ type: "thinking_level_select", level, previousLevel: previous },
				ctx,
			);
		},
	};
}

afterEach(() => {
	for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (originalConfigOverride === undefined) delete process.env.PI_MODEL_THINKING_CONFIG;
	else process.env.PI_MODEL_THINKING_CONFIG = originalConfigOverride;
});

describe("pi-model-thinking config bootstrap", () => {
	test("creates the config file when a user changes thinking level", async () => {
		const configFile = useAgentDir();
		const h = harness({ provider: "test", id: "model-a" });

		await h.startSession();
		await h.selectModel();
		expect(existsSync(configFile)).toBe(false);

		await h.userChangesLevel("high");

		expect(existsSync(configFile)).toBe(true);
		expect(readConfig(configFile)).toEqual({ models: { "test/model-a": "high" } });
	});

	test("does not write a config file on session start or model select alone", async () => {
		const configFile = useAgentDir();
		const h = harness({ provider: "test", id: "model-a" });

		await h.startSession();
		await h.selectModel();
		await h.selectModel("cycle");

		expect(existsSync(configFile)).toBe(false);
	});

	test("records an override against an existing provider default", async () => {
		const configFile = useAgentDir({ providers: { test: "high" } });
		const h = harness({ provider: "test", id: "model-a" });

		await h.selectModel();
		expect(h.getLevel()).toBe("high");

		await h.userChangesLevel("low");

		expect(readConfig(configFile)).toEqual({
			providers: { test: "high" },
			models: { "test/model-a": "low" },
		});
	});

	test("does not record its own programmatic thinking level", async () => {
		const configFile = useAgentDir({ providers: { test: "high" } });
		const h = harness({ provider: "test", id: "model-a" });

		// model_select applies "high" via setThinkingLevel, which emits
		// thinking_level_select. That is not a user change.
		await h.selectModel();

		expect(h.getLevel()).toBe("high");
		expect(readConfig(configFile)).toEqual({ providers: { test: "high" } });
	});
});
