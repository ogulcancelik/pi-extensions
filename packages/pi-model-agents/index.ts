import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

const CONFIG_FILENAME = "model-agents.json";
const DEFAULT_FILENAME_PATTERN = "AGENTS_{alias}.md";
const EXTENSION_SECTION_TITLE = "Specific Context For You";
const MESSAGE_TYPE = "pi-model-agents";

interface ModelAgentsConfig {
	/** Exact model aliases keyed by "provider/modelId". */
	models?: Record<string, string>;
	/** Broad provider aliases keyed by provider name. */
	providers?: Record<string, string>;
	/** Explicit files keyed by alias. Values may be absolute, ~/..., or relative to this config file. */
	files?: Record<string, string>;
	/** Directories to search for model-specific files. Values may be absolute, ~/..., or relative to this config file. */
	directories?: string[];
	/** Filename pattern used inside search directories. Default: AGENTS_{alias}.md */
	filenamePattern?: string;
}

type ConfigScope = "env" | "project" | "global";

interface ConfigCandidate {
	path: string;
	scope: ConfigScope;
	required?: boolean;
}

interface LoadedConfig {
	path?: string;
	dir?: string;
	scope?: ConfigScope;
	config: ModelAgentsConfig;
	error?: string;
	fatal?: boolean;
}

interface ResolvedModelAgents {
	modelKey?: string;
	provider?: string;
	alias?: string;
	configPath?: string;
	configScope?: ConfigScope;
	files: string[];
	searched: string[];
	errors: string[];
}

let cachedConfigPath: string | undefined;
let cachedConfigStamp: string | undefined;
let cachedConfig: LoadedConfig | undefined;
const contentCache = new Map<string, { stamp: string; content: string }>();

function unique(values: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

function uniqueExistingFiles(paths: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const path of paths) {
		let key = path;
		try {
			key = realpathSync(path);
		} catch {
			// Keep the string path if realpath fails. The caller already validated existence.
		}

		if (seen.has(key)) continue;
		seen.add(key);
		result.push(path);
	}

	return result;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function resolveConfigRelativePath(path: string, configDir: string | undefined): string {
	const expanded = expandHome(path);
	if (isAbsolute(expanded)) return expanded;
	return resolve(configDir ?? homedir(), expanded);
}

function safeAlias(alias: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(alias);
}

function fileStamp(path: string): string | undefined {
	try {
		const stat = statSync(path);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return undefined;
	}
}

function readCachedFile(path: string): { content?: string; error?: string } {
	try {
		const stamp = fileStamp(path);
		if (!stamp) return { error: `File no longer exists: ${path}` };

		const cached = contentCache.get(path);
		if (cached?.stamp === stamp) return { content: cached.content };

		const content = readFileSync(path, "utf8");
		contentCache.set(path, { stamp, content });
		return { content };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `Could not read ${path}: ${message}` };
	}
}

function realDirectoryForFile(path: string): string | undefined {
	try {
		return dirname(realpathSync(path));
	} catch {
		return undefined;
	}
}

function pathInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realPathInside(child: string, parent: string): boolean {
	try {
		return pathInside(realpathSync(child), realpathSync(parent));
	} catch {
		return false;
	}
}

function defaultConfigCandidates(ctx: ExtensionContext): ConfigCandidate[] {
	const envConfig = process.env.PI_MODEL_AGENTS_CONFIG;
	if (envConfig) {
		return [{ path: resolveConfigRelativePath(envConfig, ctx.cwd), scope: "env", required: true }];
	}

	const globalAgents = join(homedir(), ".pi", "agent", "AGENTS.md");
	const linkedGlobalDir = existsSync(globalAgents) ? realDirectoryForFile(globalAgents) : undefined;

	return [
		{ path: join(ctx.cwd, ".pi", CONFIG_FILENAME), scope: "project" },
		...(linkedGlobalDir ? [{ path: join(linkedGlobalDir, CONFIG_FILENAME), scope: "global" as const }] : []),
		{ path: join(homedir(), ".pi", "agent", CONFIG_FILENAME), scope: "global" },
	];
}

function findConfigCandidate(ctx: ExtensionContext): ConfigCandidate | undefined {
	for (const candidate of defaultConfigCandidates(ctx)) {
		if (candidate.required || existsSync(candidate.path)) return candidate;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.values(value).every((v) => typeof v === "string");
}

function normalizeConfig(value: unknown): ModelAgentsConfig {
	if (!value || typeof value !== "object") return {};
	const input = value as ModelAgentsConfig;
	return {
		models: isRecord(input.models) ? input.models : undefined,
		providers: isRecord(input.providers) ? input.providers : undefined,
		files: isRecord(input.files) ? input.files : undefined,
		directories: Array.isArray(input.directories) ? input.directories.filter((v) => typeof v === "string") : undefined,
		filenamePattern: typeof input.filenamePattern === "string" && input.filenamePattern.trim() ? input.filenamePattern : undefined,
	};
}

function loadConfig(ctx: ExtensionContext): LoadedConfig {
	const candidate = findConfigCandidate(ctx);
	if (!candidate) return { config: {} };

	const stamp = fileStamp(candidate.path);
	if (!stamp) {
		return {
			path: candidate.path,
			dir: dirname(candidate.path),
			scope: candidate.scope,
			config: {},
			error: `Config file not found: ${candidate.path}`,
			fatal: candidate.required,
		};
	}

	if (cachedConfig && cachedConfigPath === candidate.path && cachedConfigStamp === stamp) return cachedConfig;

	cachedConfigPath = candidate.path;
	cachedConfigStamp = stamp;

	try {
		const raw = readFileSync(candidate.path, "utf8");
		const config = normalizeConfig(JSON.parse(raw));
		cachedConfig = { path: candidate.path, dir: dirname(candidate.path), scope: candidate.scope, config };
		return cachedConfig;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		cachedConfig = {
			path: candidate.path,
			dir: dirname(candidate.path),
			scope: candidate.scope,
			config: {},
			error: `Could not read ${candidate.path}: ${message}`,
			fatal: candidate.required,
		};
		return cachedConfig;
	}
}

function contextDirectories(event: BeforeAgentStartEvent | undefined, ctx: ExtensionContext, projectOnly: boolean): string[] {
	const files = event?.systemPromptOptions.contextFiles ?? [];
	const dirs: string[] = [];

	for (const file of files) {
		for (const dir of unique([dirname(file.path), realDirectoryForFile(file.path)])) {
			if (!projectOnly || realPathInside(dir, ctx.cwd)) dirs.push(dir);
		}
	}

	return dirs;
}

function defaultSearchDirectories(
	ctx: ExtensionContext,
	event: BeforeAgentStartEvent | undefined,
	scope: ConfigScope | undefined,
): string[] {
	const projectOnly = scope === "project";
	const globalAgents = join(homedir(), ".pi", "agent", "AGENTS.md");
	const linkedGlobalDir = existsSync(globalAgents) ? realDirectoryForFile(globalAgents) : undefined;

	const projectPi = join(ctx.cwd, ".pi");
	const safeProjectPi = !existsSync(projectPi) || realPathInside(projectPi, ctx.cwd) ? projectPi : undefined;

	return unique([
		...contextDirectories(event, ctx, projectOnly),
		...(projectOnly ? [] : [linkedGlobalDir, join(homedir(), ".pi", "agent")]),
		safeProjectPi,
	]);
}

function allowedDirectory(path: string, ctx: ExtensionContext, scope: ConfigScope | undefined): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const stat = statSync(path);
		if (!stat.isDirectory()) return undefined;
	} catch {
		return undefined;
	}

	if (scope === "project" && !realPathInside(path, ctx.cwd)) return undefined;
	return path;
}

function configuredSearchDirectories(
	loaded: LoadedConfig,
	ctx: ExtensionContext,
	event?: BeforeAgentStartEvent,
): string[] {
	const { config, dir, scope } = loaded;
	const rawDirectories = config.directories?.length
		? config.directories.map((path) => resolveConfigRelativePath(path, dir))
		: defaultSearchDirectories(ctx, event, scope);

	return unique(rawDirectories.map((path) => allowedDirectory(path, ctx, scope)));
}

function selectAlias(ctx: ExtensionContext, config: ModelAgentsConfig): { alias?: string; modelKey?: string; provider?: string } {
	const model = ctx.model;
	const provider = model?.provider;
	const id = model?.id;
	const modelKey = provider && id ? `${provider}/${id}` : undefined;

	return {
		modelKey,
		provider,
		alias: modelKey ? config.models?.[modelKey] : undefined,
	};
}

function selectResolvedAlias(ctx: ExtensionContext, config: ModelAgentsConfig): { alias?: string; modelKey?: string; provider?: string } {
	const base = selectAlias(ctx, config);
	return {
		...base,
		alias: base.alias ?? (base.provider ? config.providers?.[base.provider] : undefined) ?? base.provider,
	};
}

function allowedFile(path: string, ctx: ExtensionContext, scope: ConfigScope | undefined): { ok: boolean; error?: string } {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return { ok: false, error: `Not a file: ${path}` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Cannot access ${path}: ${message}` };
	}

	if (scope === "project" && !realPathInside(path, ctx.cwd)) {
		return { ok: false, error: `Project config cannot load files outside the project: ${path}` };
	}

	return { ok: true };
}

function explicitFileForAlias(
	alias: string,
	loaded: LoadedConfig,
	ctx: ExtensionContext,
	errors: string[],
): { configured: boolean; file?: string } {
	const file = loaded.config.files?.[alias];
	if (!file) return { configured: false };

	const resolved = resolveConfigRelativePath(file, loaded.dir);
	const allowed = allowedFile(resolved, ctx, loaded.scope);
	if (!allowed.ok) {
		errors.push(allowed.error ?? `Could not load ${resolved}`);
		return { configured: true };
	}

	return { configured: true, file: resolved };
}

function patternFileForAlias(
	alias: string,
	directory: string,
	pattern: string,
	ctx: ExtensionContext,
	scope: ConfigScope | undefined,
	errors: string[],
): { file?: string; searched?: string } {
	if (!safeAlias(alias)) {
		errors.push(`Alias is not safe for filename lookup: ${alias}`);
		return {};
	}

	const filename = pattern.replaceAll("{alias}", alias);
	if (isAbsolute(filename)) {
		errors.push(`filenamePattern must not produce an absolute path: ${pattern}`);
		return {};
	}

	const directoryRoot = resolve(directory);
	const path = resolve(directoryRoot, filename);
	if (!pathInside(path, directoryRoot)) {
		errors.push(`filenamePattern escapes its search directory: ${pattern}`);
		return {};
	}

	if (!existsSync(path)) return { searched: path };

	const allowed = allowedFile(path, ctx, scope);
	if (!allowed.ok) {
		errors.push(allowed.error ?? `Could not load ${path}`);
		return { searched: path };
	}

	if (!realPathInside(path, directoryRoot)) {
		errors.push(`Resolved file escapes its search directory through a symlink: ${path}`);
		return { searched: path };
	}

	return { file: path, searched: path };
}

function resolveModelAgents(ctx: ExtensionContext, event?: BeforeAgentStartEvent): ResolvedModelAgents {
	const loaded = loadConfig(ctx);
	const errors = loaded.error ? [loaded.error] : [];
	const { alias, modelKey, provider } = selectResolvedAlias(ctx, loaded.config);

	if (loaded.fatal || !provider || !alias) {
		return {
			modelKey,
			provider,
			alias,
			configPath: loaded.path,
			configScope: loaded.scope,
			files: [],
			searched: [],
			errors,
		};
	}

	const explicitFile = explicitFileForAlias(alias, loaded, ctx, errors);
	if (explicitFile.file || explicitFile.configured) {
		return {
			modelKey,
			provider,
			alias,
			configPath: loaded.path,
			configScope: loaded.scope,
			files: explicitFile.file ? [explicitFile.file] : [],
			searched: explicitFile.file ? [explicitFile.file] : [],
			errors,
		};
	}

	const directories = configuredSearchDirectories(loaded, ctx, event);
	const pattern = loaded.config.filenamePattern ?? DEFAULT_FILENAME_PATTERN;
	const searched: string[] = [];
	const files: string[] = [];

	for (const directory of directories) {
		const result = patternFileForAlias(alias, directory, pattern, ctx, loaded.scope, errors);
		if (result.searched) searched.push(result.searched);
		if (result.file) files.push(result.file);
	}

	return {
		modelKey,
		provider,
		alias,
		configPath: loaded.path,
		configScope: loaded.scope,
		files: uniqueExistingFiles(files),
		searched: unique(searched),
		errors,
	};
}

function buildPromptSection(files: string[]): { section?: string; errors: string[] } {
	const parts: string[] = [];
	const errors: string[] = [];

	for (const file of files) {
		const result = readCachedFile(file);
		if (result.error) {
			errors.push(result.error);
			continue;
		}

		const content = result.content?.trim();
		if (!content) continue;
		parts.push(content);
	}

	if (parts.length === 0) return { errors };
	return { section: `# ${EXTENSION_SECTION_TITLE}\n\n${parts.join("\n\n")}`, errors };
}

function contextFileInsertionTargets(event: BeforeAgentStartEvent): Array<{ path: string; content: string }> {
	const files = event.systemPromptOptions.contextFiles ?? [];
	const agentsFiles = files.filter((file) => basename(file.path).toLowerCase() === "agents.md");
	const targets = agentsFiles.length > 0 ? agentsFiles : files;
	return [...targets].reverse();
}

function insertAfterContextFile(systemPrompt: string, section: string, event: BeforeAgentStartEvent): string {
	for (const file of contextFileInsertionTargets(event)) {
		const block = `## ${file.path}\n\n${file.content}\n\n`;
		const index = systemPrompt.lastIndexOf(block);
		if (index === -1) continue;

		const insertionIndex = index + block.length;
		const before = systemPrompt.slice(0, insertionIndex).trimEnd();
		const after = systemPrompt.slice(insertionIndex).trimStart();
		return `${before}\n\n${section}\n\n${after}`;
	}

	return `${systemPrompt.trimEnd()}\n\n${section}`;
}

function describeResolution(resolution: ResolvedModelAgents, readErrors: string[] = []): string {
	const lines = [
		`provider: ${resolution.provider ?? "none"}`,
		`model key: ${resolution.modelKey ?? "none"}`,
		`alias: ${resolution.alias ?? "none"}`,
		`config: ${resolution.configPath ?? "none"}`,
		`config scope: ${resolution.configScope ?? "none"}`,
	];

	if (resolution.files.length === 0) lines.push("files: none");
	else lines.push(...resolution.files.map((file) => `file: ${file}`));

	if (resolution.searched.length > 0) {
		lines.push("searched:");
		lines.push(...resolution.searched.map((file) => `  ${file}`));
	}

	const errors = [...resolution.errors, ...readErrors];
	if (errors.length > 0) {
		lines.push("errors:");
		lines.push(...errors.map((error) => `  ${error}`));
	}

	return lines.join("\n");
}

export default function piModelAgents(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const resolution = resolveModelAgents(ctx, event);
		const { section } = buildPromptSection(resolution.files);
		if (!section) return;

		return {
			systemPrompt: insertAfterContextFile(event.systemPrompt, section, event),
		};
	});

	pi.registerCommand("model-agents", {
		description: "Show model-specific AGENTS.md resolution",
		handler: async (_args, ctx) => {
			const resolution = resolveModelAgents(ctx);
			const { errors: readErrors } = buildPromptSection(resolution.files);
			const message = describeResolution(resolution, readErrors);
			if (ctx.hasUI) {
				ctx.ui.notify(message, resolution.files.length > 0 ? "info" : "warning");
				return;
			}

			pi.sendMessage({
				customType: MESSAGE_TYPE,
				content: message,
				display: true,
			});
		},
	});
}
