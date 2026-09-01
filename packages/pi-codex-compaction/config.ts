import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export interface LegacyCompactionConfig {
	autoCompact: boolean;
	thresholdRatio: number;
}

const DEFAULT_CONFIG: LegacyCompactionConfig = {
	autoCompact: true,
	thresholdRatio: 0.9,
};

function readConfig(path: string): Partial<LegacyCompactionConfig> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return {
			...(typeof parsed.autoCompact === "boolean" ? { autoCompact: parsed.autoCompact } : {}),
			...(
				typeof parsed.thresholdRatio === "number" && parsed.thresholdRatio > 0 && parsed.thresholdRatio < 1
					? { thresholdRatio: parsed.thresholdRatio }
					: {}
			),
		};
	} catch {
		return {};
	}
}

export function loadLegacyConfig(cwd: string, projectTrusted: boolean): LegacyCompactionConfig {
	const globalConfig = readConfig(join(homedir(), CONFIG_DIR_NAME, "agent", "pi-codex-compaction.json"));
	const projectConfig = projectTrusted
		? readConfig(join(cwd, CONFIG_DIR_NAME, "pi-codex-compaction.json"))
		: {};
	return { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
}
