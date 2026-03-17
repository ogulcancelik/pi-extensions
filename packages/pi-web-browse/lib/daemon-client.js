import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export async function checkDaemonHealth({ daemonUrl, timeoutMs = 600 } = {}) {
  if (!daemonUrl) throw new Error("checkDaemonHealth requires daemonUrl");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${daemonUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    return payload && payload.status === "ok" ? payload : null;
  } catch {
    return null;
  }
}

export function getDaemonPid({ daemonPidFile } = {}) {
  if (!daemonPidFile) throw new Error("getDaemonPid requires daemonPidFile");

  try {
    if (!existsSync(daemonPidFile)) return null;
    const pid = parseInt(readFileSync(daemonPidFile, "utf-8").trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function startDaemonInBackground({
  scriptPath,
  daemonUrl,
  daemonPidFile,
  forwardedArgs = [],
  env = process.env,
} = {}) {
  if (!scriptPath) throw new Error("startDaemonInBackground requires scriptPath");
  if (!daemonUrl) throw new Error("startDaemonInBackground requires daemonUrl");
  if (!daemonPidFile) throw new Error("startDaemonInBackground requires daemonPidFile");

  const daemonArgs = [scriptPath, "--daemon-run", ...forwardedArgs];

  // If this client is executed via Bun, spawn the daemon via Node to avoid runtime differences.
  // (Bun is great for running scripts, but Playwright/daemon mode is more predictable under Node.)
  const launcher = process.versions?.bun
    ? (env.WEB_BROWSE_NODE_BIN || "node")
    : process.execPath;

  const child = spawn(launcher, daemonArgs, {
    detached: true,
    stdio: "ignore",
    env,
  });

  child.unref();

  // Wait up to ~5s for daemon to become healthy.
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    const health = await checkDaemonHealth({ daemonUrl, timeoutMs: 800 });
    if (health) return health;
  }

  throw new Error(`daemon failed to start on ${daemonUrl}`);
}

export async function ensureDaemonRunning({
  scriptPath,
  daemonUrl,
  daemonPidFile,
  forwardedArgs = [],
  env = process.env,
} = {}) {
  const health = await checkDaemonHealth({ daemonUrl });
  if (health) return health;

  // If a stale PID file exists, ignore it; health check is the source of truth.
  return await startDaemonInBackground({ scriptPath, daemonUrl, daemonPidFile, forwardedArgs, env });
}

export async function stopDaemon({ daemonUrl, daemonPidFile } = {}) {
  if (!daemonUrl) throw new Error("stopDaemon requires daemonUrl");
  if (!daemonPidFile) throw new Error("stopDaemon requires daemonPidFile");

  const pid = getDaemonPid({ daemonPidFile });
  if (!pid) return { status: "not running" };
  if (!isProcessRunning(pid)) return { status: "not running" };

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to stop daemon pid=${pid}: ${message}`);
  }

  // Wait briefly for shutdown.
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    if (!(await checkDaemonHealth({ daemonUrl, timeoutMs: 500 }))) return { status: "stopped" };
  }

  return { status: "stopping", pid };
}

export async function sendDaemonCommand({ daemonUrl, command, payload } = {}) {
  if (!daemonUrl) throw new Error("sendDaemonCommand requires daemonUrl");
  if (!command) throw new Error("sendDaemonCommand requires command");

  const response = await fetch(`${daemonUrl}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, payload }),
    signal: AbortSignal.timeout(120000),
  });

  const json = await response.json().catch(() => null);
  if (!json || typeof json !== "object") throw new Error("invalid daemon response");
  if (!json.success) throw new Error(json.error || "daemon command failed");

  return json.data;
}
