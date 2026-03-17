#!/usr/bin/env node

/**
 * Web Browse - search the web and fetch/read pages via a real browser (CDP)
 *
 * Usage:
 *   ./web-browse.js "query"              # search, show snippets, cache results
 *   ./web-browse.js "query" -n 10        # more results
 *   ./web-browse.js --fetch 1,3,5        # fetch cached results by index
 *   ./web-browse.js --url <url>          # fetch a specific URL
 *   ./web-browse.js --url <url> --full   # fetch without truncation
 */

import { spawn } from "node:child_process";
import { searchWebFromContext } from "./lib/search.js";
import { fetchUrlViaHttp } from "./lib/http-fetch.js";
import { fetchUrlFromContext, fetchUrlsFromContext, cleanupContextPages } from "./lib/fetch.js";
import { fetch as undiciFetch, Agent } from "undici";
import { chromium } from "playwright";
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { checkDaemonHealth, ensureDaemonRunning, sendDaemonCommand, stopDaemon } from "./lib/daemon-client.js";
import { fileURLToPath } from "node:url";

import { runWebBrowseDaemon } from "./lib/daemon.js";
import { startBrowserForCdp, killBrowserProcess, resolveCdpOptions as resolveCdpOptionsModule } from "./lib/cdp.js";
import { platform } from "node:os";

const IS_WINDOWS = platform() === "win32";

const CACHE_FILE = join(tmpdir(), "web-browse-cache.json");
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Daemon: keep a persistent headless Brave+CDP session to avoid startup cost and
// reduce bot-protection flakiness (JS challenges benefit from a warm session).
const DAEMON_PORT = parseInt(
  process.env.WEB_BROWSE_DAEMON_PORT || process.env.LOCAL_SEARCH_DAEMON_PORT || "9377",
  10,
);
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
const DAEMON_PID_FILE = join(tmpdir(), "web-browse-daemon.pid");

// Force IPv4 to avoid timeout issues with some hosts (e.g., GitHub Pages)
const agent = new Agent({ connect: { family: 4 } });
const httpFetch = (url, opts = {}) => undiciFetch(url, { ...opts, dispatcher: agent });

// Use a generic Windows Chrome user agent (works well across platforms)
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const USER_AGENT = process.env.WEB_BROWSE_USER_AGENT || DEFAULT_USER_AGENT;

const DEBUG_DUMP_ENABLED = ["1", "true", "yes"].includes(String(process.env.WEB_BROWSE_DEBUG_DUMP || "").toLowerCase());
const DEBUG_DUMP_BASE_DIR = process.env.WEB_BROWSE_DEBUG_DUMP_DIR || tmpdir();
const FETCH_OPTS = {
  botProtectionTimeoutMs: 30000,
  debugDumpEnabled: DEBUG_DUMP_ENABLED,
  debugDumpBaseDir: DEBUG_DUMP_BASE_DIR,
};

const HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": process.env.WEB_BROWSE_ACCEPT_LANGUAGE || "en-US,en;q=0.9",
};


const spawnedBraveProcessGroupPids = new Set();

function cleanupSpawnedBraveProcesses() {
  for (const pid of spawnedBraveProcessGroupPids) {
    try {
      if (IS_WINDOWS) {
        // Windows: use taskkill to kill process tree
        spawn("taskkill", ["/pid", pid.toString(), "/T", "/F"], { stdio: "ignore" });
      } else {
        // Unix: kill process group (negative PID)
        process.kill(-pid);
      }
    } catch {
      // ignore
    }
  }

  spawnedBraveProcessGroupPids.clear();
}

process.on("SIGINT", () => {
  cleanupSpawnedBraveProcesses();
  process.exit(130);
});

process.on("SIGTERM", () => {
  cleanupSpawnedBraveProcesses();
  process.exit(143);
});

process.on("exit", () => {
  cleanupSpawnedBraveProcesses();
});

// --- Argument Parsing ---
const args = process.argv.slice(2);

function getArg(flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("-")) {
    return args[idx + 1];
  }
  return null;
}

function hasFlag(flag) {
  return args.includes(flag);
}

function getQuery() {
  for (const arg of args) {
    if (
      !arg.startsWith("-") &&
      arg !== getArg("-n") &&
      arg !== getArg("--url") &&
      arg !== getArg("--fetch") &&
      arg !== getArg("--cdp-profile") &&
      arg !== getArg("--cdp-port") &&
      arg !== getArg("--stress") &&
      arg !== getArg("--daemon") &&
      arg !== getArg("--browser-bin")
    ) {
      return arg;
    }
  }
  return null;
}

const numResults = parseInt(getArg("-n") || "5", 10);
const fetchIndices = getArg("--fetch");
const directUrl = getArg("--url");
const fullContent = hasFlag("--full");
const cdpStart = hasFlag("--cdp-start");
const useCdp = hasFlag("--cdp") || cdpStart;
const cdpPort = parseInt(getArg("--cdp-port") || (cdpStart ? "9225" : "9222"), 10);
const cdpProfile = getArg("--cdp-profile") || join(homedir(), ".config", "web-browse-cdp-profile");
const browserBinArg = getArg("--browser-bin");
const stressCount = parseInt(getArg("--stress") || "0", 10);
const daemonCommand = getArg("--daemon"); // start|stop|status|restart
const daemonRun = hasFlag("--daemon-run");
const noDaemon = hasFlag("--no-daemon");
const query = getQuery();

// --- Help ---
if (hasFlag("--help") || hasFlag("-h") || (args.length === 0)) {
  console.log(`Web Browse - search the web and fetch/read pages (no API keys needed)

Usage:
  ./web-browse.js "query"              # search, show snippets, cache results
  ./web-browse.js "query" -n 10        # more results
  ./web-browse.js --fetch 1,3,5        # fetch cached results by index
  ./web-browse.js --url <url>          # fetch a specific URL (truncated)
  ./web-browse.js --url <url> --full   # fetch without truncation

  # Daemon (persistent headless browser session)
  ./web-browse.js --daemon start|stop|status|restart
  ./web-browse.js --no-daemon ...      # bypass daemon (one-shot mode)

  # Config
  ./web-browse.js --browser-bin <path> ...
  WEB_BROWSE_USER_AGENT="..." ./web-browse.js ...

Default behavior:
  Direct calls automatically start/use a local daemon that keeps a persistent headless Brave+CDP session.
  This avoids browser startup overhead and helps with bot-protection pages that auto-clear.

Examples:
  ./web-browse.js --daemon start
  ./web-browse.js "rust async runtime"
  ./web-browse.js --fetch 1,3
  ./web-browse.js --url https://example.com
  ./web-browse.js --no-daemon --url https://example.com

Notes:
  ./search.js is kept as a wrapper for backwards compatibility.`);
  process.exit(0);
}

// --- Cache ---
function saveCache(query, results) {
  const cache = { query, timestamp: Date.now(), results };
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function loadCache() {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    const cache = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    if (Date.now() - cache.timestamp > CACHE_TTL_MS) {
      return null; // expired
    }
    return cache;
  } catch {
    return null;
  }
}

function getScriptPath() {
  return fileURLToPath(import.meta.url);
}

function getDaemonForwardedArgs() {
  const forwarded = [];

  // Forward relevant CLI config to the daemon so the background session matches.
  const explicitCdpProfile = getArg("--cdp-profile");
  if (explicitCdpProfile) forwarded.push("--cdp-profile", explicitCdpProfile);

  const explicitBrowserBin = getArg("--browser-bin");
  if (explicitBrowserBin) forwarded.push("--browser-bin", explicitBrowserBin);

  return forwarded;
}

async function daemonHealth(timeoutMs = 600) {
  return await checkDaemonHealth({ daemonUrl: DAEMON_URL, timeoutMs });
}

async function daemonEnsureRunning() {
  return await ensureDaemonRunning({
    scriptPath: getScriptPath(),
    daemonUrl: DAEMON_URL,
    daemonPidFile: DAEMON_PID_FILE,
    forwardedArgs: getDaemonForwardedArgs(),
    env: process.env,
  });
}

async function daemonStop() {
  return await stopDaemon({ daemonUrl: DAEMON_URL, daemonPidFile: DAEMON_PID_FILE });
}

async function daemonSendCommand(command, payload) {
  return await sendDaemonCommand({ daemonUrl: DAEMON_URL, command, payload });
}

async function startBraveForCdp(preferredPort, profileDir, browserBin = null) {
  const launched = await startBrowserForCdp(preferredPort, profileDir, browserBin, spawnedBraveProcessGroupPids);
  return { proc: launched.proc, port: launched.port };
}

async function resolveCdpOptions(useCdpFlag, cdpStartFlag, cdpPortValue) {
  return await resolveCdpOptionsModule({ useCdpFlag, cdpStartFlag, cdpPortValue });
}

// --- Search (browser-first) ---
async function searchWebOneShot(
  query,
  num,
  useCdpConnection = false,
  cdpPortValue = 9222,
  cdpAutoStart = false,
  cdpProfileValue = join(homedir(), ".config", "web-browse-cdp-profile"),
) {
  const profileDir = mkdtempSync(join(tmpdir(), "web-browse-profile-"));
  const clampedNum = Math.max(1, Math.min(num, 20));

  let context;
  let browser;
  let braveProcess;
  let ownedContext = false;

  try {
    if (useCdpConnection) {
      let effectiveCdpPort = cdpPortValue;

      if (cdpAutoStart) {
        console.error(`Starting browser for CDP (preferred port ${cdpPortValue})...`);
        braveProcess = await startBraveForCdp(cdpPortValue, cdpProfileValue, browserBinArg);
        effectiveCdpPort = braveProcess.port;
        console.error(`Browser started (pid=${braveProcess.proc.pid}, port=${effectiveCdpPort})`);
      }

      browser = await chromium.connectOverCDP(`http://127.0.0.1:${effectiveCdpPort}`);
      const contexts = browser.contexts();
      if (contexts.length > 0) {
        context = contexts[0];
      } else {
        context = await browser.newContext();
        ownedContext = true;
      }

      // Inject stealth scripts for CDP mode (avoid bot detection)
      await context.addInitScript(() => {
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) window.chrome.runtime = { id: undefined };
      });
    } else {
      context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        viewport: { width: 1280, height: 720 },
        locale: "en-US",
        timezoneId: "UTC",
        userAgent: HEADERS["User-Agent"],
        colorScheme: "light",
        extraHTTPHeaders: {
          "Accept-Language": "en-US,en;q=0.9",
          "Upgrade-Insecure-Requests": "1",
        },
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--disable-features=IsolateOrigins,site-per-process",
        ],
      });
      ownedContext = true;

      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
        Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, "platform", { get: () => "Linux x86_64" });
        Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
        Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
        window.chrome = { runtime: {} };
      });
    }

    const results = await searchWebFromContext({
      context,
      httpFetch,
      headers: HEADERS,
      query,
      numResults: clampedNum,
      log: (msg) => console.error(msg),
    });

    return results.slice(0, clampedNum);
  } finally {
    if (context && cdpAutoStart) {
      const pages = context.pages();
      for (const openPage of pages) {
        await openPage.close().catch(() => {});
      }
    }

    if (ownedContext && context) {
      await context.close().catch(() => {});
    }

    if (browser) {
      await browser.close().catch(() => {});
    }

    if (braveProcess?.proc?.pid) {
      const pid = braveProcess.proc.pid;
      spawnedBraveProcessGroupPids.delete(pid);

      try {
        if (IS_WINDOWS) {
          spawn("taskkill", ["/pid", pid.toString(), "/T", "/F"], { stdio: "ignore" });
        } else {
          process.kill(-pid);
        }
      } catch {
        // ignore
      }
    }

    rmSync(profileDir, { recursive: true, force: true });
  }
}

// --- Fetch URL Content ---

async function withCdpBrowser(cdpOptions, cdpProfileValue, handler) {
  let context;
  let browser;
  let braveProcess;

  try {
    if (cdpOptions.useCdp) {
      let effectiveCdpPort = cdpOptions.cdpPort;

      if (cdpOptions.cdpStart) {
        console.error(`Starting Brave for CDP (preferred port ${cdpOptions.cdpPort})...`);
        braveProcess = await startBraveForCdp(cdpOptions.cdpPort, cdpProfileValue, browserBinArg);
        effectiveCdpPort = braveProcess.port;
        console.error(`Brave started (pid=${braveProcess.proc.pid}, port=${effectiveCdpPort})`);
      }

      browser = await chromium.connectOverCDP(`http://127.0.0.1:${effectiveCdpPort}`);
      context = browser.contexts()[0] ?? await browser.newContext();

      // Inject stealth scripts for CDP mode (avoid bot detection)
      await context.addInitScript(() => {
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) window.chrome.runtime = { id: undefined };
      });
    } else {
      throw new Error("CDP is required for this fetch");
    }

    return await handler(context);
  } finally {
    if (context && cdpOptions.cdpStart) {
      const pages = context.pages();
      for (const openPage of pages) {
        await openPage.close().catch(() => {});
      }
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (braveProcess?.proc?.pid) {
      const pid = braveProcess.proc.pid;
      spawnedBraveProcessGroupPids.delete(pid);

      try {
        if (IS_WINDOWS) {
          spawn("taskkill", ["/pid", pid.toString(), "/T", "/F"], { stdio: "ignore" });
        } else {
          process.kill(-pid);
        }
      } catch {
        // ignore
      }
    }
  }
}


async function fetchUrlWithCdp(url, truncate, cdpOptions, cdpProfileValue) {
  return withCdpBrowser(cdpOptions, cdpProfileValue, async (context) => {
    const result = await fetchUrlFromContext(context, url, truncate, FETCH_OPTS);
    await cleanupContextPages(context);
    return result;
  });
}

async function fetchUrlsWithCdp(urls, truncate, cdpOptions, cdpProfileValue) {
  return withCdpBrowser(cdpOptions, cdpProfileValue, async (context) => {
    const results = await fetchUrlsFromContext(context, urls, truncate, FETCH_OPTS);
    await cleanupContextPages(context);
    return results;
  });
}

async function runDaemon() {
  const preferredCdpPort = parseInt(
    process.env.WEB_BROWSE_CDP_PORT || process.env.LOCAL_SEARCH_CDP_PORT || "9225",
    10,
  );

  await runWebBrowseDaemon({
    daemonPort: DAEMON_PORT,
    daemonUrl: DAEMON_URL,
    daemonPidFile: DAEMON_PID_FILE,
    preferredCdpPort,
    cdpProfile,
    browserBinArg,
    startBraveForCdp,
    chromium,
    fetchUrlFromContext,
    fetchUrlsFromContext,
    searchWebFromContext,
    httpFetch,
    headers: HEADERS,
    cleanupContextPages,
    fetchOpts: FETCH_OPTS,
    spawnedBrowserProcessGroupPids: spawnedBraveProcessGroupPids,
  });
}

// --- Output Formatting ---
function printSearchResults(results) {
  console.log("=".repeat(70) + "\n");
  results.forEach((result, i) => {
    console.log(`## ${i + 1}. ${result.title}`);
    console.log(`URL: ${result.link}`);
    console.log(`${result.snippet || "(no snippet)"}\n`);
    console.log("=".repeat(70) + "\n");
  });
  console.log(`💡 Use --fetch 1,2,3 to fetch specific results`);
}

function printFetchedContent(results) {
  console.log("=".repeat(70) + "\n");
  results.forEach((result, i) => {
    console.log(`## ${result.title || result.url}`);
    console.log(`URL: ${result.url}\n`);
    if (result.error) {
      console.log(`❌ Error: ${result.error}`);
    } else {
      console.log(result.content);
    }
    console.log("\n" + "=".repeat(70) + "\n");
  });
}

// --- Main ---
async function main() {
  // Daemon: internal entrypoint
  if (daemonRun) {
    await runDaemon();
    return;
  }

  // Daemon: user-facing controls
  if (daemonCommand) {
    const cmd = String(daemonCommand).toLowerCase();

    if (cmd === "status") {
      const health = await daemonHealth(1500);
      console.log(JSON.stringify({ status: health ? "running" : "stopped", health }, null, 2));
      return;
    }

    if (cmd === "start") {
      const health = await daemonEnsureRunning();
      console.log(JSON.stringify({ status: "running", health }, null, 2));
      return;
    }

    if (cmd === "stop") {
      const result = await daemonStop();
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (cmd === "restart") {
      await daemonStop().catch(() => {});
      const health = await daemonEnsureRunning();
      console.log(JSON.stringify({ status: "running", health }, null, 2));
      return;
    }

    console.error(`Unknown --daemon command: ${daemonCommand} (expected: start|stop|status|restart)`);
    process.exit(1);
  }

  // Mode 1: Fetch specific URL
  if (directUrl) {
    console.error(`Fetching: ${directUrl}\n`);

    let result;

    if (!noDaemon) {
      await daemonEnsureRunning();
      result = await daemonSendCommand("fetch", { url: directUrl, truncate: !fullContent });
    } else {
      const cdpOptions = await resolveCdpOptions(useCdp, cdpStart, cdpPort);
      result = cdpOptions.useCdp
        ? await fetchUrlWithCdp(directUrl, !fullContent, cdpOptions, cdpProfile)
        : await fetchUrlViaHttp(httpFetch, HEADERS, directUrl, !fullContent);
    }

    printFetchedContent([result]);
    return;
  }

  // Mode 2: Fetch from cache by index
  if (fetchIndices) {
    const cache = loadCache();
    if (!cache) {
      console.error("No cached search results. Run a search first.");
      process.exit(1);
    }

    const indices = fetchIndices.split(",").map(s => parseInt(s.trim(), 10) - 1);
    const toFetch = indices
      .filter(i => i >= 0 && i < cache.results.length)
      .map(i => cache.results[i]);

    if (toFetch.length === 0) {
      console.error(`Invalid indices. Cache has ${cache.results.length} results (1-${cache.results.length}).`);
      process.exit(1);
    }

    console.error(`Fetching ${toFetch.length} page(s)...\n`);

    let results;

    if (!noDaemon) {
      await daemonEnsureRunning();
      results = await daemonSendCommand("fetchMany", { urls: toFetch.map((item) => item.link), truncate: !fullContent });
    } else {
      const cdpOptions = await resolveCdpOptions(useCdp, cdpStart, cdpPort);
      results = cdpOptions.useCdp
        ? await fetchUrlsWithCdp(toFetch.map((item) => item.link), !fullContent, cdpOptions, cdpProfile)
        : await Promise.all(toFetch.map((item) => fetchUrlViaHttp(httpFetch, HEADERS, item.link, !fullContent)));
    }

    printFetchedContent(results);
    return;
  }

  // Mode 3: Search
  if (query) {
    const attemptSearch = async () => {
      if (!noDaemon) {
        await daemonEnsureRunning();
        return await daemonSendCommand("search", { query, numResults });
      }

      const cdpOptions = await resolveCdpOptions(useCdp, cdpStart, cdpPort);
      return await searchWebOneShot(
        query,
        numResults,
        cdpOptions.useCdp,
        cdpOptions.cdpPort,
        cdpOptions.cdpStart,
        cdpProfile,
      );
    };

    if (stressCount > 0) {
      console.error(`Stress mode: ${stressCount} searches for "${query}"\n`);
      let successCount = 0;

      for (let i = 0; i < stressCount; i += 1) {
        console.error(`Run ${i + 1}/${stressCount}`);
        const results = await attemptSearch();
        if (results.length > 0) {
          successCount += 1;
        }
      }

      console.log(`Stress summary: ${successCount}/${stressCount} successful searches`);
      process.exit(0);
    }

    console.error(`Searching: "${query}"\n`);
    const results = await attemptSearch();

    if (results.length === 0) {
      console.log("No results found.");
      process.exit(0);
    }

    saveCache(query, results);
    printSearchResults(results);
    return;
  }

  console.error("No query provided. Use --help for usage.");
  process.exit(1);
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
