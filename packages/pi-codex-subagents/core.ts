import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const PACKAGE_BASENAME = "pi-codex-subagents";
export const SUBAGENT_DIR = path.join(getAgentDir(), PACKAGE_BASENAME);
const CONFIG_PATH = path.join(SUBAGENT_DIR, "config.json");
const SYSTEM_PROMPT_PATH = path.join(SUBAGENT_DIR, "SYSTEM.md");
const AGENTS_DIR = path.join(SUBAGENT_DIR, "agents");
const TEMP_ROOT = path.join(process.env.PI_SUBAGENT_TEMP_DIR || os.tmpdir(), PACKAGE_BASENAME, os.userInfo().username);
const LEGACY_RUNS_DIR = path.join(TEMP_ROOT, "runs");
const SOCKET_DIR = path.join(TEMP_ROOT, "sockets");

export const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_THINKING = "high";
export const DEFAULT_TOOLS = "read,bash,grep,find,ls";
const DEFAULT_SUBAGENT_SYSTEM_PROMPT = "You are a subagent working for a main agent. Work only on the assigned task and follow its scope precisely.";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const FINAL_STATUSES = new Set<AgentRuntimeStatus>(["completed", "failed", "interrupted"]);

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type AgentRuntimeStatus = "starting" | "running" | "completed" | "failed" | "interrupted";

export interface SubagentConfig {
  storageDir?: string;
  retentionDays?: number;
  defaults?: {
    skills?: string[];
    extensions?: string[];
  };
}

export interface AgentDefinition {
  name: string;
  description?: string;
  hint?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string;
  skills?: string[];
  extensions?: string[];
  prompt?: string;
}

export interface ChildProcessOwnership {
  pid: number;
  processIdentity: string;
  token: string;
  ownerPid: number;
  ownerProcessIdentity?: string;
  startedAt: number;
}

export interface AgentInfo {
  id: string;
  taskName: string;
  canonicalName: string;
  parentSessionId: string;
  parentSessionFile?: string;
  agentType?: string;
  provider: string;
  modelId: string;
  model: string;
  thinking?: ThinkingLevel;
  tools?: string;
  skills?: string[];
  skillPaths?: string[];
  extensions?: string[];
  extensionPaths?: string[];
  cwd: string;
  sessionFile: string;
  infoFile: string;
  logFile: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  lastActivity?: number;
  messageCount: number;
  status: AgentRuntimeStatus;
  lastTaskMessage?: string;
  finalResponse?: string;
  error?: string;
  childProcess?: ChildProcessOwnership;
}

export interface AgentListEntry {
  agent_name: string;
  agent_status: AgentRuntimeStatus;
  last_task_message: string | null;
  parent_session_id?: string;
}

export interface AgentResponseEntry {
  agent_name: string;
  status: AgentRuntimeStatus;
  finalResponse?: string;
  error?: string;
  last_task_message: string | null;
}

export interface SpawnAgentParams {
  task_name: string;
  message: string;
  agent_type?: string;
  skills?: string[];
  loadedSkillPaths?: Record<string, string>;
  cwd: string;
  parentSessionId: string;
  parentSessionFile?: string;
  inheritedProvider: string;
  inheritedModelId: string;
  inheritedThinking?: ThinkingLevel;
  inheritedTools?: string;
}

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface LiveAgent {
  info: AgentInfo;
  proc: ChildProcessWithoutNullStreams;
  broadcaster: EventBroadcaster;
  logger: SessionLogger;
  pending: Map<string, PendingRequest>;
  reqId: number;
  stderr: string;
  expectedExit: boolean;
  processFinished: boolean;
  finalizedRun: boolean;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  termination?: Promise<void>;
  candidateResponse: string;
  candidateError?: string;
}

interface MailboxEvent {
  id: string;
  parentSessionId: string;
  agentName: string;
  status: AgentRuntimeStatus;
  finalResponse?: string;
  error?: string;
  createdAt: number;
}

interface Waiter {
  parentSessionId: string;
  targets?: Set<string>;
  resolve: (event: MailboxEvent) => void;
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Wait canceled.");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function expandHome(value: string): string {
  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function stringList(value: unknown): string[] | undefined {
  const entries = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? value.split(",")
      : [];
  const normalized = entries.map((entry) => entry.trim()).filter(Boolean);
  return normalized.length ? normalized : undefined;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function normalizeConfig(value: unknown): SubagentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const defaultsRaw = raw.defaults && typeof raw.defaults === "object" && !Array.isArray(raw.defaults)
    ? raw.defaults as Record<string, unknown>
    : undefined;
  const defaults = defaultsRaw ? {
    ...(stringList(defaultsRaw.skills) ? { skills: stringList(defaultsRaw.skills) } : {}),
    ...(stringList(defaultsRaw.extensions) ? { extensions: stringList(defaultsRaw.extensions) } : {}),
  } : undefined;
  const retentionDays = typeof raw.retentionDays === "number" && Number.isFinite(raw.retentionDays) && raw.retentionDays >= 0
    ? raw.retentionDays
    : undefined;
  return {
    ...(typeof raw.storageDir === "string" && raw.storageDir.trim() ? { storageDir: raw.storageDir.trim() } : {}),
    ...(retentionDays !== undefined ? { retentionDays } : {}),
    ...(defaults && Object.keys(defaults).length ? { defaults } : {}),
  };
}

export function loadSubagentConfig(): SubagentConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  } catch {}
  return {};
}

export function getRunsDir(): string {
  const configured = loadSubagentConfig().storageDir;
  if (configured) {
    const expanded = expandHome(configured);
    return path.isAbsolute(expanded) ? expanded : path.resolve(SUBAGENT_DIR, expanded);
  }
  return path.join(SUBAGENT_DIR, "runs");
}

function ensurePrivateDir(directory: string, enforceMode = false): void {
  const existed = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && (enforceMode || !existed)) fs.chmodSync(directory, 0o700);
}

function ensureSystemPromptFile(): void {
  if (fs.existsSync(SYSTEM_PROMPT_PATH)) return;
  try {
    fs.writeFileSync(SYSTEM_PROMPT_PATH, DEFAULT_SUBAGENT_SYSTEM_PROMPT, { flag: "wx", mode: 0o600 });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
}

function readSystemPrompt(): string {
  ensureSystemPromptFile();
  const prompt = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8");
  if (!prompt.trim()) throw new Error(`Subagent system prompt is empty: ${SYSTEM_PROMPT_PATH}`);
  return prompt;
}

function ensureBaseDirs(): void {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  ensureSystemPromptFile();
  ensurePrivateDir(getRunsDir(), !loadSubagentConfig().storageDir);
  ensurePrivateDir(SOCKET_DIR, true);
}

const SCOPE_DIR_PATTERN = /^[0-9a-f]{24}$/;
const AGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUTPUT_FILE_PATTERN = /^\d+-[0-9a-f-]{36}\.txt$/i;
const TASK_LOCK_PATTERN = /^\.task-[0-9a-f]{24}\.lock$/;

function isAgentArtifact(name: string, agentId: string): boolean {
  return name === `${agentId}.jsonl`
    || name === `${agentId}.info.json`
    || name === `${agentId}.log`
    || new RegExp(`^${agentId}\\.info\\.json\\.\\d+\\.tmp$`).test(name);
}

function pruneScope(directory: string, cutoff: number): void {
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".info.json")) continue;
    const agentId = entry.name.slice(0, -".info.json".length);
    if (!AGENT_ID_PATTERN.test(agentId)) continue;
    const info = readInfoFile(path.join(directory, entry.name));
    const agentEntries = entries.filter((candidate) => candidate.isFile() && isAgentArtifact(candidate.name, agentId));
    let latest = Math.max(info?.lastActivity ?? 0, info?.updatedAt ?? 0, info?.createdAt ?? 0);
    for (const candidate of agentEntries) {
      try { latest = Math.max(latest, fs.statSync(path.join(directory, candidate.name)).mtimeMs); } catch {}
    }
    if (isRunActive(agentId) || latest >= cutoff) continue;
    let failed = false;
    for (const candidate of agentEntries.filter((candidate) => candidate.name !== entry.name)) {
      try { fs.rmSync(path.join(directory, candidate.name), { force: true }); } catch { failed = true; }
    }
    if (failed) continue;
    try { fs.rmSync(path.join(directory, entry.name), { force: true }); } catch {}
  }

  for (const entry of entries) {
    if (!entry.isFile() || !TASK_LOCK_PATTERN.test(entry.name)) continue;
    const lockFile = path.join(directory, entry.name);
    try {
      if (fs.statSync(lockFile).mtimeMs >= cutoff) continue;
      const owner = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: number };
      if (typeof owner.pid === "number" && processAlive(owner.pid)) continue;
    } catch {}
    try { fs.rmSync(lockFile, { force: true }); } catch {}
  }

  try { fs.rmdirSync(directory); } catch {}
}

function pruneRunsRoot(root: string, cutoff: number): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.name === "_outputs" && entry.isDirectory()) {
      let outputs: fs.Dirent[];
      try { outputs = fs.readdirSync(target, { withFileTypes: true }); } catch { continue; }
      for (const output of outputs) {
        if (!output.isFile() || !OUTPUT_FILE_PATTERN.test(output.name)) continue;
        const outputPath = path.join(target, output.name);
        try {
          if (fs.statSync(outputPath).mtimeMs < cutoff) fs.rmSync(outputPath, { force: true });
        } catch {}
      }
      continue;
    }
    if (!entry.isDirectory() || !SCOPE_DIR_PATTERN.test(entry.name)) continue;
    try { pruneScope(target, cutoff); } catch {}
  }
}

function pruneExpiredRuns(): void {
  const retentionDays = loadSubagentConfig().retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (retentionDays === 0) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const root of runsRoots()) pruneRunsRoot(root, cutoff);
}

export function parentScopeKey(parentSessionId: string): string {
  return createHash("sha256").update(parentSessionId).digest("hex").slice(0, 24);
}

export function taskStorageKey(taskName: string): string {
  return createHash("sha256").update(taskName).digest("hex").slice(0, 24);
}

function runsRoots(): string[] {
  return [...new Set([getRunsDir(), LEGACY_RUNS_DIR])];
}

function scopeDir(parentSessionId: string): string {
  return path.join(getRunsDir(), parentScopeKey(parentSessionId));
}

function scopeDirs(parentSessionId: string): string[] {
  const key = parentScopeKey(parentSessionId);
  return runsRoots().map((root) => path.join(root, key));
}

function normalizeTaskName(name: string): string {
  const normalized = name.trim().replace(/^\/+|\/+$/g, "");
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(normalized)) {
    throw new Error("task_name must use letters, digits, underscores, dashes, and optional slash path separators");
  }
  return normalized;
}

function saveInfo(info: AgentInfo): void {
  fs.mkdirSync(path.dirname(info.infoFile), { recursive: true });
  info.updatedAt = Date.now();
  const temporary = `${info.infoFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(info, null, 2));
  fs.renameSync(temporary, info.infoFile);
}

function readInfoFile(file: string): AgentInfo | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8")) as Omit<AgentInfo, "status"> & { status: AgentRuntimeStatus | "closed"; closedAt?: number };
    if (info.status === "closed") {
      info.status = info.error ? "failed" : info.finalResponse !== undefined ? "completed" : "interrupted";
      delete info.closedAt;
    }
    return info as AgentInfo;
  } catch {
    return undefined;
  }
}

function readInfos(directory: string): AgentInfo[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".info.json"))
    .flatMap((name) => {
      const info = readInfoFile(path.join(directory, name));
      return info ? [info] : [];
    });
}

function sortInfos(infos: AgentInfo[]): AgentInfo[] {
  return infos.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

function readScopeInfos(parentSessionId: string): AgentInfo[] {
  return sortInfos(scopeDirs(parentSessionId).flatMap(readInfos));
}

function readAllInfos(): AgentInfo[] {
  const directories = runsRoots().flatMap((root) => {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SCOPE_DIR_PATTERN.test(entry.name))
      .map((entry) => path.join(root, entry.name));
  });
  return sortInfos(directories.flatMap(readInfos));
}

export function getAgent(name: string, parentSessionId: string): AgentInfo | null {
  const taskName = normalizeTaskName(name);
  return readScopeInfos(parentSessionId).find((info) => info.taskName === taskName) ?? null;
}

export function parseAgentDefinitionText(text: string, fallbackName: string): AgentDefinition {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const attrs: Record<string, string> = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
      if (entry) attrs[entry[1]] = entry[2].replace(/^['"]|['"]$/g, "");
    }
  }
  return {
    name: attrs.name || fallbackName,
    description: attrs.description,
    hint: attrs.hint || attrs.caller_hint,
    provider: attrs.provider,
    model: attrs.model,
    thinking: isThinkingLevel(attrs.thinking) ? attrs.thinking : undefined,
    tools: attrs.tools,
    skills: stringList(attrs.skills),
    extensions: stringList(attrs.extensions),
    prompt: (match ? text.slice(match[0].length) : text).trim() || undefined,
  };
}

export function listAgentDefinitions(): AgentDefinition[] {
  ensureBaseDirs();
  const definitions: AgentDefinition[] = [];
  for (const name of fs.readdirSync(AGENTS_DIR)) {
    if (!name.endsWith(".md")) continue;
    try {
      definitions.push(parseAgentDefinitionText(fs.readFileSync(path.join(AGENTS_DIR, name), "utf8"), name.replace(/\.md$/, "")));
    } catch {}
  }
  return definitions.sort((a, b) => a.name.localeCompare(b.name));
}

export function getAgentDefinition(name?: string): AgentDefinition | undefined {
  return name ? listAgentDefinitions().find((definition) => definition.name === name) : undefined;
}

export function getAgentDefinitionsDescription(): string {
  const definitions = listAgentDefinitions();
  if (!definitions.length) return `No agent templates found. Add markdown files to ${AGENTS_DIR}.`;
  return definitions.map((definition) => {
    let line = `- \`${definition.name}\`${definition.description ? ` — ${definition.description}` : ""}`;
    if (definition.provider && definition.model) line += ` — model: ${definition.provider}/${definition.model}`;
    if (definition.thinking) line += ` — thinking: ${definition.thinking}`;
    if (definition.extensions?.length) line += ` — extensions: ${definition.extensions.join(", ")}`;
    return definition.hint ? `${line}\n  Caller hint: ${definition.hint}` : line;
  }).join("\n");
}

function normalizeTools(tools: string | undefined): string {
  if (tools === undefined) return DEFAULT_TOOLS;
  return tools.split(",").map((tool) => tool.trim()).filter(Boolean).join(",");
}

function normalizeList(values?: string[]): string[] | undefined {
  const normalized = Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
  return normalized.length ? normalized : undefined;
}

function findNearestSkillDirs(cwd: string): string[] {
  const directories: string[] = [];
  let current = cwd;
  while (true) {
    directories.push(path.join(current, CONFIG_DIR_NAME, "skills"));
    directories.push(path.join(current, ".agents", "skills"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

function parseSkillName(content: string): string | undefined {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const frontmatter = match?.[1] ?? content.slice(0, 2048);
  return frontmatter.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
}

function resolveSkillPath(skill: string, cwd: string): string {
  const expanded = expandHome(skill);
  if (path.isAbsolute(expanded) || expanded.startsWith(".")) {
    const candidate = path.resolve(cwd, expanded);
    if (fs.existsSync(candidate)) return candidate;
    throw new Error(`Skill path not found: ${skill}`);
  }
  const npmRoot = path.join(getAgentDir(), "npm", "node_modules");
  const roots = [path.join(getAgentDir(), "skills"), path.join(os.homedir(), ".agents", "skills"), ...findNearestSkillDirs(cwd), npmRoot];
  for (const root of roots) {
    const directDirectory = path.join(root, skill);
    if (fs.existsSync(path.join(directDirectory, "SKILL.md"))) return directDirectory;
    const directMarkdown = path.join(root, `${skill}.md`);
    if (fs.existsSync(directMarkdown)) return directMarkdown;
  }
  const stack = fs.existsSync(npmRoot) ? [npmRoot] : [];
  while (stack.length) {
    const directory = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    const skillFile = path.join(directory, "SKILL.md");
    if (fs.existsSync(skillFile)) {
      try {
        if (parseSkillName(fs.readFileSync(skillFile, "utf8")) === skill) return directory;
      } catch {}
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" && directory !== npmRoot) continue;
      stack.push(path.join(directory, entry.name));
    }
  }
  throw new Error(`Skill not found: ${skill}`);
}

function resolveSkillPaths(skills: string[] | undefined, cwd: string, loadedSkillPaths?: Record<string, string>): string[] | undefined {
  return skills?.map((skill) => loadedSkillPaths?.[skill] ?? resolveSkillPath(skill, cwd));
}

function looksLikePath(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith(".") || path.isAbsolute(value);
}

function resolveExtensionPath(extension: string, cwd: string): string {
  if (looksLikePath(extension)) {
    const expanded = expandHome(extension);
    const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
    if (!fs.existsSync(resolved)) throw new Error(`Extension path not found: ${extension}`);
    return resolved;
  }
  const candidates = [
    path.join(cwd, CONFIG_DIR_NAME, "npm", "node_modules", extension),
    path.join(getAgentDir(), "npm", "node_modules", extension),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) throw new Error(`Installed extension package not found: ${extension}. Install it with pi install first.`);
  return resolved;
}

function resolveExtensionPaths(extensions: string[] | undefined, cwd: string): string[] | undefined {
  return extensions?.map((extension) => resolveExtensionPath(extension, cwd));
}

export interface PeekMarker { pid: number; startedAt: number; token: string }

export function getSocketPath(agentId: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${PACKAGE_BASENAME}-${os.userInfo().username}-${agentId}`
    : path.join(SOCKET_DIR, `${agentId}.sock`);
}

function markerPath(agentId: string, kind: "active" | "peek"): string {
  return path.join(SOCKET_DIR, `${agentId}.${kind}.json`);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === "EPERM"; }
}

interface ProcessSnapshot {
  identity: string;
  tokenMatches?: boolean;
}

function hashIdentity(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function inspectProcess(pid: number, token?: string): ProcessSnapshot | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !processAlive(pid)) return undefined;
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const startTicks = fields[19];
      const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`);
      if (!startTicks || !commandLine.length) return undefined;
      const environment = token ? fs.readFileSync(`/proc/${pid}/environ`) : undefined;
      return {
        identity: `linux:${startTicks}:${hashIdentity(commandLine)}`,
        ...(token ? { tokenMatches: environment?.includes(Buffer.from(`PI_SUBAGENT_OWNER_TOKEN=${token}\0`)) ?? false } : {}),
      };
    }
    if (process.platform === "win32") {
      const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p) { [Console]::Out.Write($p.CreationDate.ToUniversalTime().Ticks.ToString() + [char]0 + $p.CommandLine) }`;
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 3000 });
      const output = result.status === 0 ? result.stdout : "";
      return output ? { identity: `windows:${hashIdentity(output)}` } : undefined;
    }
    const result = spawnSync("ps", ["eww", "-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8", timeout: 3000 });
    const output = result.status === 0 ? result.stdout.trim() : "";
    if (!output) return undefined;
    return {
      identity: `unix:${hashIdentity(output)}`,
      ...(token ? { tokenMatches: output.includes(`PI_SUBAGENT_OWNER_TOKEN=${token}`) } : {}),
    };
  } catch {
    return undefined;
  }
}

function ownershipMatches(ownership: ChildProcessOwnership): boolean {
  const snapshot = inspectProcess(ownership.pid, ownership.token);
  return snapshot?.identity === ownership.processIdentity && snapshot.tokenMatches !== false;
}

function markActive(agentId: string, kind: "active" | "peek", marker: PeekMarker): void {
  fs.writeFileSync(markerPath(agentId, kind), JSON.stringify(marker, null, 2));
}

function clearActive(agentId: string, kind: "active" | "peek", owner?: Pick<PeekMarker, "pid" | "token">): void {
  const file = markerPath(agentId, kind);
  try {
    if (owner && fs.existsSync(file)) {
      const current = JSON.parse(fs.readFileSync(file, "utf8"));
      if (current.pid !== owner.pid || current.token !== owner.token) return;
    }
    fs.unlinkSync(file);
  } catch {}
}

function isActive(agentId: string, kind: "active" | "peek"): boolean {
  const file = markerPath(agentId, kind);
  try {
    if (!fs.existsSync(file)) return false;
    const marker = JSON.parse(fs.readFileSync(file, "utf8")) as PeekMarker;
    if (processAlive(marker.pid)) return true;
    clearActive(agentId, kind, marker);
  } catch {}
  return false;
}

function isRunActive(agentId: string): boolean {
  return isActive(agentId, "active") || isActive(agentId, "peek");
}

export function isPeekActive(agentId: string): boolean {
  return isActive(agentId, "peek");
}

class SessionLogger {
  private stream: fs.WriteStream | null = null;
  constructor(private readonly file: string) {}
  write(level: string, category: string, message: string, data?: any): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!this.stream) this.stream = fs.createWriteStream(this.file, { flags: "a" });
    this.stream.write(JSON.stringify({ ts: new Date().toISOString(), level, category, message, ...(data !== undefined ? { data } : {}) }) + "\n");
    if (process.env.PI_SUBAGENT_DEBUG) console.error(`[${level}] ${category}: ${message}`, data ?? "");
  }
  info(category: string, message: string, data?: any): void { this.write("INFO", category, message, data); }
  stderr(chunk: string): void { this.write("STDERR", "pi-process", chunk.trim()); }
  close(): void { this.stream?.end(); this.stream = null; }
}

class EventBroadcaster {
  private server: net.Server | null = null;
  private connections: net.Socket[] = [];
  private readonly marker: PeekMarker = { pid: process.pid, startedAt: Date.now(), token: randomUUID() };
  private status: "thinking" | "streaming" | "tool" | "done" = "thinking";
  private toolName?: string;
  private partialMessage: any = null;
  private userMessage: any = null;
  private readonly activeTools = new Map<string, { toolCallId: string; toolName: string; args: any; partialResult?: any; result?: any; isError?: boolean }>();

  constructor(private readonly agentId: string) {}

  start(): void {
    ensurePrivateDir(SOCKET_DIR, true);
    markActive(this.agentId, "active", this.marker);
    const socketPath = getSocketPath(this.agentId);
    if (process.platform !== "win32") {
      try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch {}
    }
    this.server = net.createServer((connection) => {
      this.connections.push(connection);
      try {
        connection.write(JSON.stringify({
          type: "sync",
          status: this.status,
          toolName: this.toolName,
          partialMessage: this.partialMessage,
          userMessage: this.userMessage,
          activeTools: [...this.activeTools.values()],
        }) + "\n");
      } catch {}
      const remove = () => { this.connections = this.connections.filter((candidate) => candidate !== connection); };
      connection.on("close", remove);
      connection.on("error", remove);
    });
    this.server.on("listening", () => markActive(this.agentId, "peek", this.marker));
    this.server.on("error", () => this.stopSocket());
    try { this.server.listen(socketPath); } catch { this.stopSocket(); }
  }

  broadcast(event: any): void {
    if (event.type === "message_start" && event.message?.role === "user") {
      this.userMessage = event.message;
    } else if (event.type === "message_start" && event.message?.role === "assistant") {
      this.partialMessage = event.message;
      this.status = "thinking";
    } else if (event.type === "message_update" && event.message?.role === "assistant") {
      this.partialMessage = event.message;
      const delta = event.assistantMessageEvent;
      if (delta?.type === "thinking_delta") this.status = "thinking";
      if (delta?.type === "text_delta") this.status = "streaming";
    } else if (event.type === "tool_execution_start") {
      this.status = "tool";
      this.toolName = event.toolName;
      if (event.toolCallId) {
        this.activeTools.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
      }
    } else if (event.type === "tool_execution_update" && event.toolCallId) {
      const active = this.activeTools.get(event.toolCallId);
      if (active) active.partialResult = event.partialResult;
    } else if (event.type === "tool_execution_end" && event.toolCallId) {
      const active = this.activeTools.get(event.toolCallId);
      if (active) {
        active.result = event.result;
        active.isError = event.isError ?? false;
      }
    } else if (event.type === "message_end") {
      if (event.message?.role === "toolResult" && event.message.toolCallId) {
        this.activeTools.delete(event.message.toolCallId);
      }
      this.partialMessage = null;
      this.userMessage = null;
    } else if (event.type === "agent_settled") {
      this.partialMessage = null;
      this.userMessage = null;
      this.activeTools.clear();
      this.status = "done";
      this.toolName = undefined;
    }
    const line = JSON.stringify(event) + "\n";
    for (const connection of this.connections) {
      try { connection.write(line); } catch {}
    }
  }

  private stopSocket(): void {
    clearActive(this.agentId, "peek", this.marker);
    for (const connection of this.connections) {
      try { connection.destroy(); } catch {}
    }
    this.connections = [];
    try { this.server?.close(); } catch {}
    this.server = null;
    if (process.platform !== "win32") {
      try { if (fs.existsSync(getSocketPath(this.agentId))) fs.unlinkSync(getSocketPath(this.agentId)); } catch {}
    }
  }

  stop(): void {
    clearActive(this.agentId, "active", this.marker);
    this.stopSocket();
  }
}

export class RpcJsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const lines: string[] = [];
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) break;
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      lines.push(line);
    }
    return lines;
  }

  end(): string[] {
    this.buffer += this.decoder.end();
    if (!this.buffer) return [];
    const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
    this.buffer = "";
    return [line];
  }
}

function extractTextFromMessage(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n\n");
}

function previewText(text: string | undefined, maxLength = 180): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function getPiCommand(): { command: string; prefixArgs: string[] } {
  if (process.env.PI_SUBAGENT_PI_BIN) return { command: process.env.PI_SUBAGENT_PI_BIN, prefixArgs: [] };
  const currentEntry = process.argv[1];
  if (currentEntry && fs.existsSync(currentEntry)) return { command: process.execPath, prefixArgs: [currentEntry] };
  return { command: process.execPath, prefixArgs: [] };
}

function canonicalAgentName(target: string): string {
  return target.startsWith("/") ? target : `/${target}`;
}

function targetMatches(event: MailboxEvent, targets?: Set<string>): boolean {
  return !targets || targets.has(event.agentName);
}

export function consumeFirstMatchingMailboxEvent(events: MailboxEvent[], parentSessionId: string, targets?: Set<string>): MailboxEvent | undefined {
  const index = events.findIndex((event) => event.parentSessionId === parentSessionId && targetMatches(event, targets));
  if (index === -1) return undefined;
  return events.splice(index, 1)[0];
}

export class AgentManager {
  private readonly live = new Map<string, LiveAgent>();
  private readonly mailbox: MailboxEvent[] = [];
  private waiters: Waiter[] = [];
  private readonly defaultWaitAllTargets = new Map<string, Set<string>>();
  private readonly shutdownController = new AbortController();
  private readonly ownerProcessIdentity = inspectProcess(process.pid)?.identity;
  private readonly reconciliation: Promise<void>;

  constructor() {
    ensureBaseDirs();
    pruneExpiredRuns();
    this.reconciliation = this.reconcilePersistedChildren();
  }

  private clearChildOwnership(info: AgentInfo, expectedToken: string): void {
    const persisted = readInfoFile(info.infoFile);
    if (persisted?.childProcess?.token === expectedToken) {
      delete persisted.childProcess;
      saveInfo(persisted);
    }
    if (info.childProcess?.token === expectedToken) delete info.childProcess;
  }

  private async waitForOwnedExit(ownership: ChildProcessOwnership, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!ownershipMatches(ownership)) return true;
      await delay(25);
    }
    return !ownershipMatches(ownership);
  }

  private signalOwnedProcess(ownership: ChildProcessOwnership, signal: NodeJS.Signals): void {
    if (!ownershipMatches(ownership)) return;
    try {
      if (process.platform !== "win32") process.kill(-ownership.pid, signal);
      else process.kill(ownership.pid, signal);
    } catch {
      try { process.kill(ownership.pid, signal); } catch {}
    }
  }

  private async terminateOwnedChild(info: AgentInfo): Promise<void> {
    const ownership = info.childProcess;
    if (!ownership) return;
    if (!ownershipMatches(ownership)) {
      this.clearChildOwnership(info, ownership.token);
      return;
    }
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(ownership.pid), "/T", "/F"], { stdio: "ignore" });
        killer.once("error", () => resolve());
        killer.once("exit", () => resolve());
      });
      await this.waitForOwnedExit(ownership, 2000);
    } else {
      this.signalOwnedProcess(ownership, "SIGTERM");
      if (!await this.waitForOwnedExit(ownership, 1000)) {
        this.signalOwnedProcess(ownership, "SIGKILL");
        await this.waitForOwnedExit(ownership, 1000);
      }
    }
    if (ownershipMatches(ownership)) throw new Error(`Unable to terminate owned child process for ${info.canonicalName}.`);
    this.clearChildOwnership(info, ownership.token);
  }

  private async reconcilePersistedChildren(): Promise<void> {
    for (const info of readAllInfos()) {
      const ownership = info.childProcess;
      if (!ownership) continue;
      try {
        if (!ownershipMatches(ownership)) {
          if (info.status === "starting" || info.status === "running") {
            info.status = "interrupted";
            info.lastActivity = Date.now();
            saveInfo(info);
          }
          this.clearChildOwnership(info, ownership.token);
          continue;
        }
        const ownerSnapshot = inspectProcess(ownership.ownerPid);
        const ownerStillActive = ownership.ownerPid !== process.pid
          && ownerSnapshot
          && (!ownership.ownerProcessIdentity || ownerSnapshot.identity === ownership.ownerProcessIdentity);
        if (ownerStillActive) continue;
        if (info.status === "starting" || info.status === "running") {
          info.status = "interrupted";
          info.lastActivity = Date.now();
          saveInfo(info);
        }
        await this.terminateOwnedChild(info);
      } catch {}
    }
  }

  async spawnAgent(params: SpawnAgentParams): Promise<{ task_name: string; nickname: null }> {
    await this.reconciliation;
    const taskName = normalizeTaskName(params.task_name);
    const definition = getAgentDefinition(params.agent_type);
    if (params.agent_type && !definition) throw new Error(`Agent template not found: ${params.agent_type}`);
    const provider = definition?.provider && definition.model ? definition.provider : params.inheritedProvider;
    const modelId = definition?.provider && definition.model ? definition.model : params.inheritedModelId;
    const config = loadSubagentConfig();
    readSystemPrompt();
    const configuredSkills = definition?.skills ?? config.defaults?.skills;
    const skills = normalizeList([...(configuredSkills ?? []), ...(params.skills ?? [])]);
    const extensions = normalizeList(definition?.extensions ?? config.defaults?.extensions);
    const tools = definition?.tools !== undefined
      ? normalizeTools(definition.tools)
      : extensions?.length
        ? undefined
        : normalizeTools(params.inheritedTools);
    const thinking = definition?.thinking ?? params.inheritedThinking ?? DEFAULT_THINKING;
    const cwd = path.resolve(params.cwd);
    const directory = scopeDir(params.parentSessionId);
    ensurePrivateDir(directory, true);

    const lockFile = path.join(directory, `.task-${taskStorageKey(taskName)}.lock`);
    let lock: number | undefined;
    try {
      try {
        lock = fs.openSync(lockFile, "wx");
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      } catch (error: any) {
        if (error?.code === "EEXIST") throw new Error(`Agent ${taskName} is already being created.`);
        throw error;
      }
      if (readScopeInfos(params.parentSessionId).some((info) => info.taskName === taskName)) {
        throw new Error(`Agent ${taskName} already exists in this parent session. Use a new task_name.`);
      }
      const id = randomUUID();
      const info: AgentInfo = {
        id,
        taskName,
        canonicalName: `/${taskName}`,
        parentSessionId: params.parentSessionId,
        parentSessionFile: params.parentSessionFile,
        agentType: params.agent_type,
        provider,
        modelId,
        model: `${provider}:${modelId}`,
        thinking,
        tools,
        skills,
        skillPaths: resolveSkillPaths(skills, cwd, params.loadedSkillPaths),
        extensions,
        extensionPaths: resolveExtensionPaths(extensions, cwd),
        cwd,
        sessionFile: path.join(directory, `${id}.jsonl`),
        infoFile: path.join(directory, `${id}.info.json`),
        logFile: path.join(directory, `${id}.log`),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedAt: Date.now(),
        lastActivity: Date.now(),
        messageCount: 0,
        status: "starting",
        lastTaskMessage: params.message,
      };
      saveInfo(info);
      const targets = this.defaultWaitAllTargets.get(params.parentSessionId) ?? new Set<string>();
      targets.add(info.canonicalName);
      this.defaultWaitAllTargets.set(params.parentSessionId, targets);
      const prompt = [definition?.prompt, params.message].filter(Boolean).join("\n\n");
      await this.startLiveAgent(info, prompt, params.message);
      return { task_name: info.canonicalName, nickname: null };
    } finally {
      if (lock !== undefined) {
        fs.closeSync(lock);
        try { fs.unlinkSync(lockFile); } catch {}
      }
    }
  }

  private async startLiveAgent(info: AgentInfo, initialMessage?: string, displayMessage?: string): Promise<LiveAgent> {
    readSystemPrompt();
    const logger = new SessionLogger(info.logFile);
    const broadcaster = new EventBroadcaster(info.id);
    broadcaster.start();
    const launch = getPiCommand();
    const args = [
      ...launch.prefixArgs,
      "--mode", "rpc",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--system-prompt", SYSTEM_PROMPT_PATH,
      "--append-system-prompt", "",
      "--provider", info.provider,
      "--model", info.modelId,
      "--session", info.sessionFile,
    ];
    if (info.thinking) args.push("--thinking", info.thinking);
    if (info.tools !== undefined) {
      if (info.tools) args.push("--tools", info.tools);
      else args.push("--no-builtin-tools");
    }
    for (const extensionPath of info.extensionPaths ?? []) args.push("--extension", extensionPath);
    for (const skillPath of info.skillPaths ?? []) args.push("--skill", skillPath);
    const childToken = randomUUID();
    logger.info("spawn", "starting child pi", { command: launch.command, args, cwd: info.cwd });
    const proc = spawn(launch.command, args, {
      cwd: info.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_SUBAGENT_OWNER_TOKEN: childToken },
      detached: process.platform !== "win32",
    });
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });
    const live: LiveAgent = {
      info,
      proc,
      broadcaster,
      logger,
      pending: new Map(),
      reqId: 0,
      stderr: "",
      expectedExit: false,
      processFinished: false,
      finalizedRun: false,
      exitPromise,
      resolveExit,
      candidateResponse: "",
    };
    this.live.set(info.id, live);
    const decoder = new RpcJsonlDecoder();
    const finishProcess = (error?: Error) => {
      if (live.processFinished) return;
      live.processFinished = true;
      const persisted = readInfoFile(live.info.infoFile);
      if (persisted && FINAL_STATUSES.has(persisted.status)) {
        live.info = persisted;
        live.finalizedRun = true;
      }
      for (const [requestId, pending] of live.pending) {
        clearTimeout(pending.timer);
        pending.reject(error ?? new Error("Child Pi process exited before responding."));
        live.pending.delete(requestId);
      }
      if (!live.expectedExit && !live.finalizedRun && !FINAL_STATUSES.has(live.info.status)) {
        this.markFailed(live, error?.message ?? "Child Pi process exited unexpectedly.");
      }
      const ownership = live.info.childProcess;
      if (ownership) this.clearChildOwnership(live.info, ownership.token);
      if (this.live.get(info.id) === live) this.live.delete(info.id);
      broadcaster.stop();
      logger.close();
      proc.stdin.removeAllListeners();
      proc.stdout.removeAllListeners();
      proc.stderr.removeAllListeners();
      proc.removeAllListeners();
      try { proc.stdin.destroy(); } catch {}
      try { proc.stdout.destroy(); } catch {}
      try { proc.stderr.destroy(); } catch {}
      live.resolveExit();
    };
    proc.stdout.on("data", (chunk) => {
      for (const line of decoder.push(chunk)) this.handleLine(live, line);
    });
    proc.stdout.on("end", () => {
      for (const line of decoder.end()) this.handleLine(live, line);
    });
    proc.stderr.on("data", (data) => {
      const chunk = data.toString();
      live.stderr = `${live.stderr}${chunk}`.slice(-64 * 1024);
      logger.stderr(chunk);
    });
    proc.stdin.on("error", (error) => {
      logger.info("stdin", "child stdin error", { error: error.message });
      if (!live.expectedExit) {
        const persisted = readInfoFile(live.info.infoFile);
        if (persisted && FINAL_STATUSES.has(persisted.status)) {
          live.info = persisted;
          live.finalizedRun = true;
        } else if (!live.finalizedRun) {
          this.markFailed(live, error.message);
        }
        void this.terminateProcess(live);
      }
    });
    proc.on("error", (error) => finishProcess(error));
    proc.on("exit", (code, signal) => {
      logger.info("exit", "child exited", { code, signal });
      const suffix = live.stderr.trim() ? `: ${live.stderr.trim().slice(-1000)}` : "";
      finishProcess(live.expectedExit ? undefined : new Error(`Child Pi exited (code=${code}, signal=${signal})${suffix}`));
    });

    try {
      if (!proc.pid) throw new Error("Child Pi process did not provide a PID.");
      await this.sendCommand(live, { type: "get_state" }, DEFAULT_STARTUP_TIMEOUT_MS);
      let snapshot: ProcessSnapshot | undefined;
      for (let attempt = 0; attempt < 20 && !snapshot; attempt++) {
        snapshot = inspectProcess(proc.pid, childToken);
        if (!snapshot || snapshot.tokenMatches === false) await delay(10);
      }
      if (!snapshot || snapshot.tokenMatches === false) throw new Error("Unable to verify child Pi process ownership.");
      info.childProcess = {
        pid: proc.pid,
        processIdentity: snapshot.identity,
        token: childToken,
        ownerPid: process.pid,
        ownerProcessIdentity: this.ownerProcessIdentity,
        startedAt: Date.now(),
      };
      saveInfo(info);
      if (initialMessage) await this.prompt(live, initialMessage, displayMessage);
      return live;
    } catch (error) {
      if (!live.finalizedRun) this.markFailed(live, error instanceof Error ? error.message : String(error));
      await this.terminateProcess(live);
      throw error;
    }
  }

  private sendCommand(live: LiveAgent, command: Record<string, unknown>, timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS): Promise<any> {
    if (live.processFinished || live.expectedExit) return Promise.reject(new Error(`Agent ${live.info.taskName} process is not available.`));
    const id = `req-${++live.reqId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        live.pending.delete(id);
        reject(new Error(`Timed out waiting for child Pi RPC command: ${String(command.type ?? "unknown")}`));
      }, timeoutMs);
      live.pending.set(id, { resolve, reject, timer });
      live.proc.stdin.write(JSON.stringify({ id, ...command }) + "\n", (error) => {
        if (!error) return;
        const pending = live.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        live.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private async prompt(live: LiveAgent, message: string, displayMessage?: string): Promise<void> {
    const previousStatus = live.info.status;
    this.removeMailboxEvents(live.info.parentSessionId, live.info.canonicalName);
    const targets = this.defaultWaitAllTargets.get(live.info.parentSessionId) ?? new Set<string>();
    targets.add(live.info.canonicalName);
    this.defaultWaitAllTargets.set(live.info.parentSessionId, targets);
    live.info.status = "running";
    live.info.lastTaskMessage = displayMessage ?? message;
    live.info.lastActivity = Date.now();
    live.info.messageCount += 1;
    live.finalizedRun = false;
    live.candidateResponse = "";
    live.candidateError = undefined;
    delete live.info.finalResponse;
    delete live.info.error;
    delete live.info.completedAt;
    saveInfo(live.info);
    try {
      await this.sendCommand(live, { type: "prompt", message });
    } catch (error) {
      live.info.status = previousStatus;
      saveInfo(live.info);
      throw error;
    }
  }

  private handleLine(live: LiveAgent, line: string): void {
    if (!line.trim()) return;
    let event: any;
    try { event = JSON.parse(line); } catch {
      live.logger.info("rpc", "ignored invalid JSON line", { line: line.slice(0, 1000) });
      return;
    }
    live.broadcaster.broadcast(event);
    if (event.type === "response") {
      const pending = event.id ? live.pending.get(event.id) : undefined;
      if (!pending) return;
      clearTimeout(pending.timer);
      live.pending.delete(event.id);
      if (event.success) pending.resolve(event.data);
      else pending.reject(new Error(event.error || "RPC command failed"));
      return;
    }
    const persisted = readInfoFile(live.info.infoFile);
    if (persisted && FINAL_STATUSES.has(persisted.status) && persisted.status !== live.info.status) {
      live.info = persisted;
      live.finalizedRun = true;
      return;
    }
    if (live.finalizedRun || live.expectedExit) return;
    if (event.type === "agent_start") {
      live.info.status = "running";
      live.info.lastActivity = Date.now();
      live.candidateResponse = "";
      live.candidateError = undefined;
      saveInfo(live.info);
      return;
    }
    if (event.type === "message_update" || event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      live.info.status = "running";
      live.info.lastActivity = Date.now();
      saveInfo(live.info);
      return;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      live.candidateResponse = extractTextFromMessage(event.message).trim();
      live.candidateError = event.message.stopReason === "error" || event.message.stopReason === "aborted"
        ? event.message.errorMessage || `Agent ended with ${event.message.stopReason}.`
        : undefined;
      return;
    }
    if (event.type === "agent_end") {
      const lastAssistant = [...(event.messages ?? [])].reverse().find((message: any) => message?.role === "assistant");
      if (lastAssistant) {
        live.candidateResponse = extractTextFromMessage(lastAssistant).trim();
        live.candidateError = lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted"
          ? lastAssistant.errorMessage || `Agent ended with ${lastAssistant.stopReason}.`
          : undefined;
      }
      return;
    }
    if (event.type === "auto_retry_end" && event.success === false && event.finalError) {
      live.candidateError = event.finalError;
      return;
    }
    if (event.type === "agent_settled") {
      if (live.info.status === "interrupted" || live.finalizedRun) return;
      if (live.candidateError) this.markFailed(live, live.candidateError);
      else this.markCompleted(live);
      void this.terminateProcess(live).catch((error) => {
        live.logger.info("hibernate", "failed to terminate settled child", { error: error instanceof Error ? error.message : String(error) });
      });
    }
  }

  private markCompleted(live: LiveAgent): void {
    if (live.finalizedRun) return;
    live.finalizedRun = true;
    live.info.status = "completed";
    live.info.finalResponse = live.candidateResponse;
    delete live.info.error;
    live.info.completedAt = Date.now();
    live.info.lastActivity = Date.now();
    saveInfo(live.info);
    this.pushMailbox({
      id: randomUUID(),
      parentSessionId: live.info.parentSessionId,
      agentName: live.info.canonicalName,
      status: "completed",
      finalResponse: live.info.finalResponse,
      createdAt: Date.now(),
    });
  }

  private markFailed(live: LiveAgent, error: string): void {
    if (live.finalizedRun) return;
    live.finalizedRun = true;
    live.info.status = "failed";
    live.info.error = error;
    delete live.info.finalResponse;
    live.info.completedAt = Date.now();
    live.info.lastActivity = Date.now();
    saveInfo(live.info);
    this.pushMailbox({
      id: randomUUID(),
      parentSessionId: live.info.parentSessionId,
      agentName: live.info.canonicalName,
      status: "failed",
      error,
      createdAt: Date.now(),
    });
  }

  private removeMailboxEvents(parentSessionId: string, agentName: string): void {
    for (let index = this.mailbox.length - 1; index >= 0; index--) {
      const event = this.mailbox[index];
      if (event.parentSessionId === parentSessionId && event.agentName === agentName) this.mailbox.splice(index, 1);
    }
  }

  private pushMailbox(event: MailboxEvent): void {
    this.removeMailboxEvents(event.parentSessionId, event.agentName);
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.parentSessionId === event.parentSessionId && targetMatches(event, waiter.targets));
    if (waiterIndex !== -1) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      waiter.resolve(event);
      return;
    }
    this.mailbox.push(event);
  }

  listAgents(pathPrefix: string | undefined, parentSessionId: string, includeAll = false): AgentListEntry[] {
    const prefix = pathPrefix?.trim().replace(/^\/+/, "");
    const infos = includeAll ? readAllInfos() : readScopeInfos(parentSessionId);
    return infos
      .filter((info) => !prefix || info.taskName.startsWith(prefix))
      .map((info) => ({
        agent_name: info.canonicalName,
        agent_status: info.status,
        last_task_message: previewText(info.lastTaskMessage),
        ...(includeAll ? { parent_session_id: info.parentSessionId } : {}),
      }));
  }

  getAgentInfo(target: string, parentSessionId: string): AgentInfo {
    const info = getAgent(target, parentSessionId);
    if (!info) throw new Error(`Agent not found in this parent session: ${target}`);
    return info;
  }

  readAgentResponse(target: string, parentSessionId: string): AgentResponseEntry {
    return this.agentResponse(this.getAgentInfo(target, parentSessionId));
  }

  private agentResponse(info: AgentInfo): AgentResponseEntry {
    return {
      agent_name: info.canonicalName,
      status: info.status,
      ...(info.finalResponse !== undefined ? { finalResponse: info.finalResponse } : {}),
      ...(info.error ? { error: info.error } : {}),
      last_task_message: previewText(info.lastTaskMessage),
    };
  }

  private finishWaitTarget(parentSessionId: string, agentName: string): void {
    this.defaultWaitAllTargets.get(parentSessionId)?.delete(canonicalAgentName(agentName));
  }

  async waitAgent(parentSessionId: string, targets?: string[], signal?: AbortSignal): Promise<{ message: string; event?: MailboxEvent }> {
    const waitSignal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal;
    throwIfAborted(waitSignal);
    const normalizedTargets = targets?.length ? new Set(targets.map(canonicalAgentName)) : undefined;
    const existing = consumeFirstMatchingMailboxEvent(this.mailbox, parentSessionId, normalizedTargets);
    if (existing) {
      this.finishWaitTarget(parentSessionId, existing.agentName);
      return { message: `Wait completed: ${existing.agentName} ${existing.status}.`, event: existing };
    }
    if (normalizedTargets) {
      const targetInfos = readScopeInfos(parentSessionId).filter((info) => normalizedTargets.has(info.canonicalName));
      if (!targetInfos.length) throw new Error(`Agent not found in this parent session: ${Array.from(normalizedTargets).join(", ")}`);
      const finalInfo = targetInfos.find((info) => FINAL_STATUSES.has(info.status));
      if (finalInfo) {
        this.finishWaitTarget(parentSessionId, finalInfo.canonicalName);
        return {
          message: `Wait completed: ${finalInfo.canonicalName} ${finalInfo.status}.`,
          event: {
            id: randomUUID(),
            parentSessionId,
            agentName: finalInfo.canonicalName,
            status: finalInfo.status,
            finalResponse: finalInfo.finalResponse,
            error: finalInfo.error,
            createdAt: Date.now(),
          },
        };
      }
    }
    return await new Promise((resolve, reject) => {
      let waiter: Waiter;
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        waitSignal.removeEventListener("abort", onAbort);
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        callback();
      };
      const onAbort = () => settle(() => reject(abortError(waitSignal)));
      waiter = {
        parentSessionId,
        targets: normalizedTargets,
        resolve: (event) => settle(() => {
          this.finishWaitTarget(parentSessionId, event.agentName);
          resolve({ message: `Wait completed: ${event.agentName} ${event.status}.`, event });
        }),
      };
      this.waiters.push(waiter);
      waitSignal.addEventListener("abort", onAbort, { once: true });
      if (waitSignal.aborted) onAbort();
    });
  }

  async waitAllAgents(parentSessionId: string, targets?: string[], signal?: AbortSignal): Promise<{ message: string; responses: AgentResponseEntry[] }> {
    const waitSignal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal;
    throwIfAborted(waitSignal);
    const explicitTargets = targets?.length ? new Set(targets.map(canonicalAgentName)) : undefined;
    const defaultTargets = this.defaultWaitAllTargets.get(parentSessionId) ?? new Set<string>();
    const targetSet = explicitTargets ?? new Set(defaultTargets);
    if (explicitTargets) {
      const infos = readScopeInfos(parentSessionId);
      const missing = [...explicitTargets].filter((target) => !infos.some((info) => target === info.canonicalName));
      if (missing.length) throw new Error(`Agent not found in this parent session: ${missing.join(", ")}`);
    }
    const matchingInfos = () => readScopeInfos(parentSessionId).filter((info) => targetSet.has(info.canonicalName));
    const pendingNames = () => matchingInfos().filter((info) => !FINAL_STATUSES.has(info.status)).map((info) => info.canonicalName);
    const finalize = () => {
      const responses = matchingInfos().filter((info) => FINAL_STATUSES.has(info.status)).map((info) => this.agentResponse(info));
      for (const response of responses) this.finishWaitTarget(parentSessionId, response.agent_name);
      for (let index = this.mailbox.length - 1; index >= 0; index--) {
        const event = this.mailbox[index];
        if (event.parentSessionId === parentSessionId && targetSet.has(event.agentName)) this.mailbox.splice(index, 1);
      }
      return {
        message: "All target agents reached final status.",
        responses,
      };
    };
    while (true) {
      throwIfAborted(waitSignal);
      if (!pendingNames().length) return finalize();
      await delay(250, undefined, { signal: waitSignal });
    }
  }

  async sendMessage(parentSessionId: string, target: string, message: string): Promise<{ delivery: "steer" | "prompt" }> {
    await this.reconciliation;
    let info = this.getAgentInfo(target, parentSessionId);
    let live = this.live.get(info.id);
    if (live?.expectedExit) {
      await live.termination;
      live = undefined;
      info = this.getAgentInfo(target, parentSessionId);
    }
    const wasLive = Boolean(live);
    if (!live) {
      if (info.childProcess) await this.terminateOwnedChild(info);
      if (info.status === "starting" || info.status === "running") {
        info.status = "interrupted";
        info.lastActivity = Date.now();
        saveInfo(info);
      }
      live = await this.startLiveAgent(info);
    }
    if (wasLive && (info.status === "starting" || info.status === "running")) {
      await this.sendCommand(live, { type: "steer", message });
      info.lastTaskMessage = message;
      info.lastActivity = Date.now();
      saveInfo(info);
      return { delivery: "steer" };
    }
    await this.prompt(live, message, message);
    return { delivery: "prompt" };
  }

  async interruptAgent(parentSessionId: string, target: string): Promise<{ previous_status: AgentRuntimeStatus }> {
    await this.reconciliation;
    const info = this.getAgentInfo(target, parentSessionId);
    const previous = info.status;
    if (previous !== "starting" && previous !== "running") return { previous_status: previous };
    const live = this.live.get(info.id);
    info.status = "interrupted";
    info.lastActivity = Date.now();
    saveInfo(info);
    if (live) {
      live.info.status = "interrupted";
      live.info.lastActivity = info.lastActivity;
      live.finalizedRun = true;
      await this.terminateProcess(live);
    } else {
      await this.terminateOwnedChild(info);
    }
    this.finishWaitTarget(parentSessionId, info.canonicalName);
    this.pushMailbox({ id: randomUUID(), parentSessionId, agentName: info.canonicalName, status: "interrupted", createdAt: Date.now() });
    return { previous_status: previous };
  }

  private signalProcessTree(live: LiveAgent, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && live.proc.pid) process.kill(-live.proc.pid, signal);
      else live.proc.kill(signal);
    } catch {
      try { live.proc.kill(signal); } catch {}
    }
  }

  private async forceKillWindowsTree(live: LiveAgent): Promise<void> {
    if (process.platform !== "win32" || !live.proc.pid) return;
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(live.proc.pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
  }

  private terminateProcess(live: LiveAgent): Promise<void> {
    if (live.processFinished) return Promise.resolve();
    if (live.termination) return live.termination;
    live.termination = (async () => {
      const abortRequest = this.sendCommand(live, { type: "abort" }, 1000);
      live.expectedExit = true;
      try { await abortRequest; } catch {}
      try { live.proc.stdin.end(); } catch {}
      await Promise.race([live.exitPromise, delay(500)]);
      if (!live.processFinished) {
        this.signalProcessTree(live, "SIGTERM");
        await Promise.race([live.exitPromise, delay(1000)]);
      }
      if (!live.processFinished) {
        if (process.platform === "win32") await this.forceKillWindowsTree(live);
        else this.signalProcessTree(live, "SIGKILL");
        await Promise.race([live.exitPromise, delay(1000)]);
      }
      if (!live.processFinished) throw new Error(`Unable to terminate child Pi process for ${live.info.canonicalName}.`);
    })();
    return live.termination;
  }

  async shutdown(): Promise<void> {
    this.shutdownController.abort(new Error("Agent manager shut down."));
    await this.reconciliation;
    const terminations: Promise<void>[] = [];
    for (const live of this.live.values()) {
      if (live.info.status === "starting" || live.info.status === "running") {
        live.info.status = "interrupted";
        live.info.lastActivity = Date.now();
        live.finalizedRun = true;
        saveInfo(live.info);
      }
      terminations.push(this.terminateProcess(live));
    }
    await Promise.allSettled(terminations);
  }
}

export function writeFullToolOutput(content: string): string {
  const directory = path.join(getRunsDir(), "_outputs");
  ensurePrivateDir(directory, true);
  const file = path.join(directory, `${Date.now()}-${randomUUID()}.txt`);
  fs.writeFileSync(file, content);
  return file;
}
