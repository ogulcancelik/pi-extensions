import { accessSync, constants, existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { platform } from "node:os";

const PLATFORM = platform();
const IS_MACOS = PLATFORM === "darwin";
const IS_WINDOWS = PLATFORM === "win32";

// macOS .app bundle paths (checked as absolute paths)
const MACOS_BROWSER_PATHS = [
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

// Linux binary names (searched on PATH)
const LINUX_BROWSER_NAMES = [
  "brave",
  "brave-browser",
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
];

// Windows browser paths (common install locations)
const WINDOWS_BROWSER_PATHS = [
  // Brave
  join(process.env.LOCALAPPDATA || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  join(process.env.PROGRAMFILES || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  join(process.env["PROGRAMFILES(X86)"] || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  // Chrome
  join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
  join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
  // Edge (comes with Windows 10/11)
  join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  // Chromium
  join(process.env.LOCALAPPDATA || "", "Chromium", "Application", "chrome.exe"),
];

function isExecutableFile(filePath) {
  try {
    // On Windows, just check if file exists (no X_OK bit)
    if (IS_WINDOWS) {
      return existsSync(filePath);
    }
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutableOnPath(name, env = process.env) {
  if (!name) return null;

  // Absolute/relative path - check directly
  // Handle both Unix "/" and Windows "\" or "C:\"
  if (name.includes("/") || (IS_WINDOWS && (name.includes("\\") || /^[A-Za-z]:/.test(name)))) {
    return isExecutableFile(name) ? name : null;
  }

  const pathEnv = env.PATH || env.Path || "";
  const dirs = pathEnv.split(delimiter).filter(Boolean);

  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
    // On Windows, try with .exe extension if not provided
    if (IS_WINDOWS && !name.toLowerCase().endsWith(".exe")) {
      const candidateExe = join(dir, name + ".exe");
      if (isExecutableFile(candidateExe)) return candidateExe;
    }
  }

  return null;
}

/**
 * Resolve a browser binary for CDP automation.
 *
 * Precedence:
 *  - preferredBin (CLI)
 *  - WEB_BROWSE_BROWSER_BIN
 *  - BRAVE_BIN (backwards compat)
 *  - OS-specific defaults (macOS .app bundles, Windows paths, or Linux PATH names)
 */
export function resolveBrowserBin(preferredBin = null, env = process.env) {
  // Priority overrides (env vars, CLI arg)
  const overrides = [
    preferredBin,
    env.WEB_BROWSE_BROWSER_BIN,
    env.BRAVE_BIN,
  ].filter(Boolean);

  // Check overrides first
  for (const cand of overrides) {
    const resolved = findExecutableOnPath(cand, env);
    if (resolved) return resolved;
  }

  // OS-specific browser paths
  let osCandidates;
  let osName;
  if (IS_MACOS) {
    osCandidates = MACOS_BROWSER_PATHS;
    osName = "macOS";
  } else if (IS_WINDOWS) {
    osCandidates = WINDOWS_BROWSER_PATHS;
    osName = "Windows";
  } else {
    osCandidates = LINUX_BROWSER_NAMES;
    osName = "Linux";
  }

  for (const cand of osCandidates) {
    // Skip empty paths (from undefined env vars on Windows)
    if (!cand || cand.startsWith(join("", ""))) continue;
    const resolved = IS_WINDOWS ? (isExecutableFile(cand) ? cand : null) : findExecutableOnPath(cand, env);
    if (resolved) return resolved;
  }

  const allTried = [...overrides, ...osCandidates.filter(Boolean)];
  throw new Error(
    `No supported browser binary found on ${osName}. ` +
      "Set WEB_BROWSE_BROWSER_BIN or BRAVE_BIN, or pass --browser-bin <path>. " +
      `Tried: ${allTried.join(", ")}`,
  );
}
