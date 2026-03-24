/**
 * Context Gauge Extension
 *
 * Custom footer with context gauge + subscription usage bars.
 * Auto-detects provider from current model and shows relevant usage.
 *
 * Supports: Claude Max, Codex, Copilot, Gemini
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildSessionContext } from "@mariozechner/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ============ Types ============

interface RateWindow {
  label: string;
  usedPercent: number;
  resetsIn?: string; // human readable "2h38m"
}

interface UsageSnapshot {
  provider: string;
  windows: RateWindow[];
  error?: string;
  fetchedAt: number;
}

interface GitCache {
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  isJj: boolean;
}

// ============ Usage Cache ============

const USAGE_REFRESH_INTERVAL = 5 * 60_000; // 5 minutes
const usageCache = new Map<string, UsageSnapshot>(); // keyed by provider

// ============ Identity Cache ============

let codexEmailPrefix: string | null | undefined; // undefined = not yet resolved

// ============ Git Cache ============

let gitCache: GitCache | null = null;

function refreshGitCache(): void {
  gitCache = null;

  try {
    const gitRoot = execSync("git rev-parse --show-toplevel 2>/dev/null", {
      encoding: "utf8",
      timeout: 500,
    }).trim();

    if (!gitRoot) return;

    const isJj = existsSync(`${gitRoot}/.jj`);
    let branch: string | null = null;

    if (isJj) {
      try {
        const jjBranch = execSync(
          `jj log -r 'heads(ancestors(@) & bookmarks())' --no-graph -T 'bookmarks.map(|b| b.name()).join(" ")' --limit 1 2>/dev/null`,
          { encoding: "utf8", timeout: 1000 }
        ).trim();
        branch = jjBranch ? jjBranch.split(" ")[0] : null;
      } catch {}
    } else {
      try {
        const gitBranch = execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", {
          encoding: "utf8",
          timeout: 500,
        }).trim();
        branch = gitBranch && gitBranch !== "HEAD" ? gitBranch : null;
      } catch {}
    }

    let dirty = false;
    try {
      const status = execSync("git status --porcelain 2>/dev/null", {
        encoding: "utf8",
        timeout: 500,
      });
      dirty = status.trim().length > 0;
    } catch {}

    let ahead = 0;
    let behind = 0;
    try {
      const counts = execSync("git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null", {
        encoding: "utf8",
        timeout: 500,
      }).trim();
      const [a, b] = counts.split(/\s+/);
      ahead = parseInt(a, 10) || 0;
      behind = parseInt(b, 10) || 0;
    } catch {}

    gitCache = { branch, dirty, ahead, behind, isJj };
  } catch {
    gitCache = null;
  }
}

// ============ JWT Helpers ============

function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    let payload = parts[1];
    // Add base64 padding
    payload += "=".repeat((4 - (payload.length % 4)) % 4);
    const decoded = Buffer.from(payload, "base64url").toString("utf-8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function getEmailPrefixFromJwt(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const email = payload?.["https://api.openai.com/profile"]?.email;
  if (!email || typeof email !== "string") return null;
  const prefix = email.split("@")[0];
  return prefix || null;
}

// ============ Auth Loading ============

function loadAuthJson(): Record<string, any> {
  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  try {
    if (existsSync(authPath)) {
      return JSON.parse(readFileSync(authPath, "utf-8"));
    }
  } catch {}
  return {};
}

function resolveAuthValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("!")) {
    try {
      const output = execSync(trimmed.slice(1), {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 2000,
      }).trim();
      return output || undefined;
    } catch {
      return undefined;
    }
  }

  if (/^[A-Z][A-Z0-9_]*$/.test(trimmed) && process.env[trimmed]) {
    return process.env[trimmed];
  }

  return trimmed;
}

function getApiKey(providerKey: string, envVar: string): string | undefined {
  if (process.env[envVar]) return process.env[envVar];

  const auth = loadAuthJson();
  const entry = auth[providerKey];
  if (!entry) return undefined;

  if (typeof entry === "string") {
    return resolveAuthValue(entry);
  }

  return resolveAuthValue(entry.key ?? entry.access ?? entry.refresh);
}

function getClaudeToken(): string | undefined {
  const auth = loadAuthJson();
  if (auth.anthropic?.access) return auth.anthropic.access;

  // Fallback: Claude CLI keychain (macOS)
  try {
    const keychainData = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    if (keychainData) {
      const parsed = JSON.parse(keychainData);
      if (parsed.claudeAiOauth?.accessToken) {
        return parsed.claudeAiOauth.accessToken;
      }
    }
  } catch {}

  return undefined;
}

function getCopilotToken(): string | undefined {
  const auth = loadAuthJson();
  return auth["github-copilot"]?.refresh;
}

function getCodexToken(): { token: string; accountId?: string } | undefined {
  const auth = loadAuthJson();
  if (auth["openai-codex"]?.access) {
    return { token: auth["openai-codex"].access, accountId: auth["openai-codex"]?.accountId };
  }

  // Fallback: ~/.codex/auth.json
  const codexPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
  try {
    if (existsSync(codexPath)) {
      const data = JSON.parse(readFileSync(codexPath, "utf-8"));
      if (data.OPENAI_API_KEY) {
        return { token: data.OPENAI_API_KEY };
      }
      if (data.tokens?.access_token) {
        return { token: data.tokens.access_token, accountId: data.tokens.account_id };
      }
    }
  } catch {}

  return undefined;
}

function getGeminiToken(): string | undefined {
  const auth = loadAuthJson();
  if (auth["google-gemini-cli"]?.access) return auth["google-gemini-cli"].access;

  // Fallback: ~/.gemini/oauth_creds.json
  const geminiPath = join(homedir(), ".gemini", "oauth_creds.json");
  try {
    if (existsSync(geminiPath)) {
      const data = JSON.parse(readFileSync(geminiPath, "utf-8"));
      return data.access_token;
    }
  } catch {}

  return undefined;
}

function getMinimaxToken(provider: "minimax" | "minimax-cn"): string | undefined {
  return provider === "minimax"
    ? getApiKey("minimax", "MINIMAX_API_KEY")
    : getApiKey("minimax-cn", "MINIMAX_CN_API_KEY");
}

// ============ Time Formatting ============

function formatResetTime(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs < 0) return "now";

  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;

  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d${remainingHours}h` : `${days}d`;
}

/** Clamp a percentage to [0, 100]. Does NOT auto-normalize 0-1 fractions. */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** Normalize a value that might be 0-1 fraction OR 0-100 percent, then clamp. */
function normalizePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const normalized = value <= 1 && value >= 0 ? value * 100 : value;
  return Math.max(0, Math.min(100, normalized));
}

function getWindowLabel(durationMs: number | undefined, fallback: string): string {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return fallback;

  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;

  // Check if duration is close to a standard window and use the fallback label.
  // This preserves "5h" / "Week" / "Day" labels even when the actual
  // rolling window start/end times don't align perfectly.
  const isCloseToWeek = Math.abs(durationMs - weekMs) <= hourMs * 2;
  const isCloseToDay = Math.abs(durationMs - dayMs) <= hourMs * 2;
  const isCloseTo5h = Math.abs(durationMs - 5 * hourMs) <= hourMs * 2;

  if (isCloseToWeek || fallback === "Week") return "Week";
  if (isCloseToDay || fallback === "Day") return "Day";
  if (isCloseTo5h || fallback === "5h") return fallback;

  const hours = Math.round(durationMs / hourMs);
  if (hours >= 1 && hours < 48) return `${hours}h`;

  const days = Math.round(durationMs / dayMs);
  if (days >= 1) return `${days}d`;

  const mins = Math.max(1, Math.round(durationMs / 60000));
  return `${mins}m`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ============ Usage Fetchers ============

async function fetchClaudeUsage(): Promise<UsageSnapshot> {
  const token = getClaudeToken();
  if (!token) {
    return { provider: "Claude", windows: [], error: "no-auth", fetchedAt: Date.now() };
  }

  try {
    const res = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    if (!res.ok) {
      return { provider: "Claude", windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };
    }

    const data = (await res.json()) as any;
    const windows: RateWindow[] = [];

    if (data.five_hour?.utilization !== undefined) {
      windows.push({
        label: "5h",
        usedPercent: normalizePercent(data.five_hour.utilization),
        resetsIn: data.five_hour.resets_at ? formatResetTime(new Date(data.five_hour.resets_at)) : undefined,
      });
    }

    if (data.seven_day?.utilization !== undefined) {
      windows.push({
        label: "Week",
        usedPercent: normalizePercent(data.seven_day.utilization),
        resetsIn: data.seven_day.resets_at ? formatResetTime(new Date(data.seven_day.resets_at)) : undefined,
      });
    }

    return { provider: "Claude", windows, fetchedAt: Date.now() };
  } catch (e) {
    return { provider: "Claude", windows: [], error: String(e), fetchedAt: Date.now() };
  }
}

async function fetchCopilotUsage(): Promise<UsageSnapshot> {
  const token = getCopilotToken();
  if (!token) {
    return { provider: "Copilot", windows: [], error: "no-auth", fetchedAt: Date.now() };
  }

  try {
    const res = await fetchWithTimeout("https://api.github.com/copilot_internal/user", {
      headers: {
        "Editor-Version": "vscode/1.96.2",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
        Accept: "application/json",
        Authorization: `token ${token}`,
      },
    });

    if (!res.ok) {
      return { provider: "Copilot", windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };
    }

    const data = (await res.json()) as any;
    const windows: RateWindow[] = [];

    const resetDate = data.quota_reset_date_utc ? new Date(data.quota_reset_date_utc) : undefined;
    const resetsIn = resetDate ? formatResetTime(resetDate) : undefined;

    if (data.quota_snapshots?.premium_interactions) {
      const pi = data.quota_snapshots.premium_interactions;
      const usedPercent = clampPercent(100 - (pi.percent_remaining || 0));
      windows.push({ label: "Premium", usedPercent, resetsIn });
    }

    if (data.quota_snapshots?.chat && !data.quota_snapshots.chat.unlimited) {
      const chat = data.quota_snapshots.chat;
      windows.push({
        label: "Chat",
        usedPercent: clampPercent(100 - (chat.percent_remaining || 0)),
        resetsIn,
      });
    }

    return { provider: "Copilot", windows, fetchedAt: Date.now() };
  } catch (e) {
    return { provider: "Copilot", windows: [], error: String(e), fetchedAt: Date.now() };
  }
}

async function fetchCodexUsage(): Promise<UsageSnapshot> {
  const creds = getCodexToken();
  if (!creds) {
    return { provider: "Codex", windows: [], error: "no-auth", fetchedAt: Date.now() };
  }

  const providerLabel = "Codex";

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${creds.token}`,
      "User-Agent": "pi-agent",
      Accept: "application/json",
    };

    if (creds.accountId) {
      headers["ChatGPT-Account-Id"] = creds.accountId;
    }

    const res = await fetchWithTimeout("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers,
    });

    if (!res.ok) {
      return { provider: providerLabel, windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };
    }

    const data = (await res.json()) as any;
    const windows: RateWindow[] = [];

    if (data.rate_limit?.primary_window) {
      const pw = data.rate_limit.primary_window;
      const resetDate = pw.reset_at ? new Date(pw.reset_at * 1000) : undefined;
      const durationMs = typeof pw.limit_window_seconds === "number" ? pw.limit_window_seconds * 1000 : undefined;
      windows.push({
        label: getWindowLabel(durationMs, "5h"),
        usedPercent: clampPercent(pw.used_percent || 0),
        resetsIn: resetDate ? formatResetTime(resetDate) : undefined,
      });
    }

    if (data.rate_limit?.secondary_window) {
      const sw = data.rate_limit.secondary_window;
      const resetDate = sw.reset_at ? new Date(sw.reset_at * 1000) : undefined;
      const durationMs = typeof sw.limit_window_seconds === "number" ? sw.limit_window_seconds * 1000 : undefined;
      windows.push({
        label: getWindowLabel(durationMs, "Week"),
        usedPercent: clampPercent(sw.used_percent || 0),
        resetsIn: resetDate ? formatResetTime(resetDate) : undefined,
      });
    }

    return { provider: providerLabel, windows, fetchedAt: Date.now() };
  } catch (e) {
    return { provider: providerLabel, windows: [], error: String(e), fetchedAt: Date.now() };
  }
}

async function fetchGeminiUsage(): Promise<UsageSnapshot> {
  const token = getGeminiToken();
  if (!token) {
    return { provider: "Gemini", windows: [], error: "no-auth", fetchedAt: Date.now() };
  }

  try {
    const res = await fetchWithTimeout("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });

    if (!res.ok) {
      return { provider: "Gemini", windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };
    }

    const data = (await res.json()) as any;
    const quotas: Record<string, number> = {};

    for (const bucket of data.buckets || []) {
      const model = bucket.modelId || "unknown";
      const frac = bucket.remainingFraction ?? 1;
      if (!quotas[model] || frac < quotas[model]) quotas[model] = frac;
    }

    const windows: RateWindow[] = [];
    let proMin = 1,
      flashMin = 1;
    let hasProModel = false,
      hasFlashModel = false;

    for (const [model, frac] of Object.entries(quotas)) {
      if (model.toLowerCase().includes("pro")) {
        hasProModel = true;
        if (frac < proMin) proMin = frac;
      }
      if (model.toLowerCase().includes("flash")) {
        hasFlashModel = true;
        if (frac < flashMin) flashMin = frac;
      }
    }

    if (hasProModel) windows.push({ label: "Pro", usedPercent: clampPercent((1 - proMin) * 100) });
    if (hasFlashModel) windows.push({ label: "Flash", usedPercent: clampPercent((1 - flashMin) * 100) });

    return { provider: "Gemini", windows, fetchedAt: Date.now() };
  } catch (e) {
    return { provider: "Gemini", windows: [], error: String(e), fetchedAt: Date.now() };
  }
}

async function fetchMinimaxUsage(provider: "minimax" | "minimax-cn"): Promise<UsageSnapshot> {
  const token = getMinimaxToken(provider);
  const providerLabel = provider === "minimax-cn" ? "MiniMax CN" : "MiniMax";
  const endpoint =
    provider === "minimax-cn"
      ? "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains"
      : "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";

  if (!token) {
    return { provider: providerLabel, windows: [], error: "no-auth", fetchedAt: Date.now() };
  }

  try {
    const res = await fetchWithTimeout(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      return { provider: providerLabel, windows: [], error: `HTTP ${res.status}`, fetchedAt: Date.now() };
    }

    const data = (await res.json()) as any;
    const baseResp = data?.base_resp;
    if (baseResp?.status_code && baseResp.status_code !== 0) {
      return {
        provider: providerLabel,
        windows: [],
        error: baseResp.status_msg || `API ${baseResp.status_code}`,
        fetchedAt: Date.now(),
      };
    }

    const remains = Array.isArray(data?.model_remains) ? data.model_remains : [];
    const textBucket =
      remains.find((entry: any) => typeof entry?.model_name === "string" && /^minimax-m/i.test(entry.model_name)) ||
      remains.find((entry: any) => typeof entry?.model_name === "string" && /minimax/i.test(entry.model_name)) ||
      remains[0];

    if (!textBucket) {
      return { provider: providerLabel, windows: [], error: "no-usage-data", fetchedAt: Date.now() };
    }

    const windows: RateWindow[] = [];

    const intervalTotal = Number(textBucket.current_interval_total_count) || 0;
    const intervalRemaining = Number(textBucket.current_interval_usage_count) || 0;
    if (intervalTotal > 0) {
      // current_*_usage_count = remaining (confirmed against MiniMax website UI)
      const used = intervalTotal - intervalRemaining;
      const usedPercent = clampPercent((used / intervalTotal) * 100);
      const resetDate = textBucket.end_time ? new Date(Number(textBucket.end_time)) : undefined;
      const durationMs =
        textBucket.start_time && textBucket.end_time
          ? Number(textBucket.end_time) - Number(textBucket.start_time)
          : undefined;
      windows.push({
        label: getWindowLabel(durationMs, "5h"),
        usedPercent,
        resetsIn: resetDate ? formatResetTime(resetDate) : undefined,
      });
    }

    const weeklyTotal = Number(textBucket.current_weekly_total_count) || 0;
    const weeklyRemaining = Number(textBucket.current_weekly_usage_count) || 0;
    if (weeklyTotal > 0) {
      // current_*_usage_count = remaining (confirmed against MiniMax website UI)
      const used = weeklyTotal - weeklyRemaining;
      const usedPercent = clampPercent((used / weeklyTotal) * 100);
      const resetDate = textBucket.weekly_end_time ? new Date(Number(textBucket.weekly_end_time)) : undefined;
      const durationMs =
        textBucket.weekly_start_time && textBucket.weekly_end_time
          ? Number(textBucket.weekly_end_time) - Number(textBucket.weekly_start_time)
          : undefined;
      windows.push({
        label: getWindowLabel(durationMs, "Week"),
        usedPercent,
        resetsIn: resetDate ? formatResetTime(resetDate) : undefined,
      });
    }

    return { provider: providerLabel, windows, fetchedAt: Date.now() };
  } catch (e) {
    return { provider: providerLabel, windows: [], error: String(e), fetchedAt: Date.now() };
  }
}

// ============ Provider Detection ============

// Map pi provider names to our internal usage provider keys
const PROVIDER_MAP: Record<string, string> = {
  anthropic: "claude", // Claude Max subscription
  "openai-codex": "codex", // Codex subscription
  "github-copilot": "copilot", // Copilot subscription
  "google-gemini-cli": "gemini", // Gemini CLI subscription
  minimax: "minimax", // MiniMax Token Plan / Coding Plan
  "minimax-cn": "minimax-cn", // MiniMax China plan
};

function detectProvider(modelProvider: string): string | null {
  return PROVIDER_MAP[modelProvider] || null;
}

async function fetchUsageForProvider(provider: string): Promise<UsageSnapshot> {
  switch (provider) {
    case "claude":
      return fetchClaudeUsage();
    case "codex":
      return fetchCodexUsage();
    case "copilot":
      return fetchCopilotUsage();
    case "gemini":
      return fetchGeminiUsage();
    case "minimax":
      return fetchMinimaxUsage("minimax");
    case "minimax-cn":
      return fetchMinimaxUsage("minimax-cn");
    default:
      return { provider: "Unknown", windows: [], error: "unknown-provider", fetchedAt: Date.now() };
  }
}

// ============ Extension ============

export default function (pi: ExtensionAPI) {
  const CTX_GAUGE_WIDTH = 12;

  // Thin bar characters (same style for both context and usage)
  const BAR_FILLED = "━";
  const BAR_EMPTY = "─";

  function formatTokenCount(tokens: number): string {
    if (tokens >= 1_000_000) {
      const m = tokens / 1_000_000;
      return m % 1 === 0 ? `${m}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
    }
    if (tokens >= 1_000) {
      return `${Math.round(tokens / 1_000)}k`;
    }
    return `${tokens}`;
  }

  function renderContextGauge(percentage: number, theme: any, used?: number, total?: number): string {
    const clamped = Math.max(0, Math.min(100, percentage));
    const filled = Math.round((clamped / 100) * CTX_GAUGE_WIDTH);
    const empty = CTX_GAUGE_WIDTH - filled;

    let color: string;
    if (clamped >= 90) color = "error";
    else if (clamped >= 70) color = "warning";
    else if (clamped >= 50) color = "accent";
    else color = "success";

    const bar = theme.fg(color, BAR_FILLED.repeat(filled)) + theme.fg("dim", BAR_EMPTY.repeat(empty));
    const pct = `${Math.round(clamped)}%`;
    const counts = used !== undefined && total ? ` ${formatTokenCount(used)}/${formatTokenCount(total)}` : "";

    return theme.fg("dim", "ctx ") + bar + " " + theme.fg("dim", pct + counts);
  }

  function renderUsageBar(usedPercent: number, barWidth: number, theme: any): string {
    const clamped = Math.max(0, Math.min(100, usedPercent));
    const filled = Math.round((clamped / 100) * barWidth);
    const empty = barWidth - filled;

    let color: string;
    if (clamped >= 92) color = "error";
    else if (clamped >= 85) color = "warning";
    else color = "success";

    return theme.fg(color, BAR_FILLED.repeat(filled)) + theme.fg("dim", BAR_EMPTY.repeat(empty));
  }

  function renderUsageLine(usage: UsageSnapshot, width: number, theme: any): string[] {
    if (!usage.windows.length) return [];

    const dim = (s: string) => theme.fg("dim", s);
    const sep = " " + dim(">") + " ";
    const USAGE_BAR_WIDTH = 10;
    const NARROW_THRESHOLD = 60;

    if (width < NARROW_THRESHOLD) {
      // Narrow: one line per window
      const lines: string[] = [];
      for (const w of usage.windows) {
        const bar = renderUsageBar(w.usedPercent, USAGE_BAR_WIDTH, theme);
        const pct = dim(`${Math.round(w.usedPercent)}%`);
        const timeStr = w.resetsIn ? " " + dim(w.resetsIn) : "";
        lines.push(`${dim(w.label)} ${bar} ${pct}${timeStr}`);
      }
      return lines;
    }

    // Wide: single line with > separators, fixed-width bars
    // Format: "Codex > 5h ━━━━━━━━━━ 46% 2h38m > 7d ━━━━━━━━━━ 46% 2d1h"
    const parts: string[] = [theme.fg("accent", usage.provider)];

    for (const w of usage.windows) {
      const bar = renderUsageBar(w.usedPercent, USAGE_BAR_WIDTH, theme);
      const pct = dim(`${Math.round(w.usedPercent)}%`);
      const timeStr = w.resetsIn ? " " + dim(w.resetsIn) : "";
      parts.push(`${dim(w.label)} ${bar} ${pct}${timeStr}`);
    }

    return [parts.join(sep)];
  }

  function getThinkingLevel(ctx: any): string {
    const entries = ctx.sessionManager.getEntries();
    const leafId = ctx.sessionManager.getLeafId();
    const context = buildSessionContext(entries, leafId);
    return context.thinkingLevel || "off";
  }

  function getContextInfo(ctx: any): { percentage: number; used: number; total: number } {
    const model = ctx.model;
    const contextWindow = model?.contextWindow ?? 0;
    if (contextWindow === 0) return { percentage: 0, used: 0, total: 0 };

    const entries = ctx.sessionManager.getEntries();
    const leafId = ctx.sessionManager.getLeafId();
    const context = buildSessionContext(entries, leafId);
    const messages = context.messages;

    const lastAssistant = messages
      .slice()
      .reverse()
      .find((m: any) => m.role === "assistant" && m.stopReason !== "aborted");

    if (!lastAssistant?.usage) return { percentage: 0, used: 0, total: contextWindow };

    const usage = lastAssistant.usage;
    const contextTokens = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);

    return { percentage: (contextTokens / contextWindow) * 100, used: contextTokens, total: contextWindow };
  }

  // Track usage state for rendering
  let latestUsage: UsageSnapshot | null = null;
  let activeProvider: string | null = null; // internal provider key for the current model
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  
  // Store tui reference for triggering re-renders from event handlers
  let tuiRef: { requestRender: () => void } | null = null;

  /** Fetch usage for the active provider. Shows cached data immediately,
   *  then fetches fresh in the background. Discards results if provider
   *  changed while the fetch was in flight. */
  function fetchUsage(modelProvider: string): void {
    const provider = detectProvider(modelProvider);
    if (!provider) return;

    activeProvider = provider;

    // Show cached data immediately if available
    const cached = usageCache.get(provider);
    if (cached && cached.windows.length > 0) {
      latestUsage = cached;
      tuiRef?.requestRender();
    }

    // Fetch fresh in background
    fetchUsageForProvider(provider)
      .then((u) => {
        if (!u || activeProvider !== provider) return;
        usageCache.set(provider, u);
        latestUsage = u;
        tuiRef?.requestRender();
      })
      .catch(() => {});
  }

  /** Start (or restart) the periodic refresh timer. */
  function startRefreshTimer(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (activeProvider) {
        fetchUsageForProvider(activeProvider)
          .then((u) => {
            if (!u) return;
            usageCache.set(activeProvider!, u);
            latestUsage = u;
            tuiRef?.requestRender();
          })
          .catch(() => {});
      }
    }, USAGE_REFRESH_INTERVAL);
  }

  function stopRefreshTimer(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    refreshGitCache();

    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      // Store tui reference for event handlers — must be set before any async
      // fetch completes so requestRender() works on first load.
      tuiRef = tui;
      
      const unsub = footerData.onBranchChange(() => {
        refreshGitCache();
        tui.requestRender();
      });

      return {
        dispose: () => {
          unsub();
          tuiRef = null;
          stopRefreshTimer();
        },
        invalidate() {},
        render(width: number): string[] {
          const { percentage, used: ctxUsed, total: ctxTotal } = getContextInfo(ctx);

          // Build parts for status line
          let pwd = process.cwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) {
            pwd = `~${pwd.slice(home.length)}`;
          }

          let branchStr = "";
          if (gitCache?.branch) {
            const branchColor = gitCache.dirty ? "warning" : "success";
            branchStr = theme.fg(branchColor, gitCache.branch);
            if (gitCache.dirty) branchStr += theme.fg("warning", " *");
            if (gitCache.ahead) branchStr += theme.fg("success", ` ↑${gitCache.ahead}`);
            if (gitCache.behind) branchStr += theme.fg("error", ` ↓${gitCache.behind}`);
          }

          // Model + thinking
          const modelName = ctx.model?.id?.split("/").pop() || "no-model";
          let modelStr = theme.fg("muted", modelName);
          if (ctx.model?.reasoning) {
            const thinkingLevel = getThinkingLevel(ctx);
            if (thinkingLevel !== "off") {
              modelStr += " " + theme.fg("dim", ">") + " " + theme.fg("accent", thinkingLevel);
            }
          }

          // Context gauge
          const gauge = renderContextGauge(percentage, theme, ctxUsed, ctxTotal);

          const sep = " " + theme.fg("dim", ">") + " ";
          const NARROW_THRESHOLD = 60;

          const lines: string[] = [];

          if (width < NARROW_THRESHOLD) {
            // Narrow: stack vertically
            const pwdColored = theme.fg("accent", pwd);
            if (branchStr) {
              lines.push(truncateToWidth(pwdColored + sep + branchStr, width));
            } else {
              lines.push(truncateToWidth(pwdColored, width));
            }
            lines.push(truncateToWidth(modelStr, width));
            lines.push(truncateToWidth(gauge, width));
          } else {
            // Wide: single line
            const pwdColored = theme.fg("accent", pwd);
            const branchPart = branchStr ? sep + branchStr : "";
            const modelPart = sep + modelStr;
            const gaugePart = sep + gauge;
            lines.push(truncateToWidth(pwdColored + branchPart + modelPart + gaugePart, width));
          }

          if (latestUsage && latestUsage.windows.length > 0) {
            const usageLines = renderUsageLine(latestUsage, width, theme);
            for (const line of usageLines) {
              lines.push(truncateToWidth(line, width));
            }
          }

          return lines;
        },
      };
    });

    // Initial usage fetch — after setFooter so tuiRef is set
    if (ctx.model?.provider) {
      fetchUsage(ctx.model.provider);
      startRefreshTimer();
    }
  });

  // Refresh when model changes — fetch immediately, restart timer
  pi.on("model_select", (event, _ctx) => {
    if (!event.model?.provider) return;
    fetchUsage(event.model.provider);
    startRefreshTimer(); // reset the 5min countdown since we just fetched
  });
}
