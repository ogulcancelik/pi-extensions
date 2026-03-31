import { createServer as createHttpServer } from "node:http";
import { writeFileSync, rmSync } from "node:fs";

import { killBrowserProcess, waitForCdpVersion, isLikelyUsableBrowserCdp } from "./cdp.js";
import { applyFingerprintToContext } from "./fingerprint.js";

const DEFAULT_MAX_BROWSER_AGE_MS = parseInt(
  process.env.WEB_BROWSE_MAX_BROWSER_AGE_MS || "14400000",
  10,
); // 4 hours
const DEFAULT_MAX_REQUESTS_PER_BROWSER = parseInt(
  process.env.WEB_BROWSE_MAX_REQUESTS_PER_BROWSER || "75",
  10,
);

function isProcessRunning(pid) {
  if (!pid) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRecoverableBrowserError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  const markers = [
    "target page, context or browser has been closed",
    "browser has been closed",
    "context closed",
    "page has been closed",
    "session closed",
    "connection closed",
    "connection terminated",
    "websocket",
    "ecconnreset",
    "econnreset",
    "socket hang up",
    "target closed",
    "channel closed",
    "pipe closed",
    "closed",
  ];

  return markers.some((marker) => message.includes(marker));
}

/**
 * Start the persistent web-browse daemon.
 * Keeps a headless browser session alive and exposes a tiny HTTP API.
 */
export async function runWebBrowseDaemon({
  daemonPort,
  daemonUrl,
  daemonPidFile,
  preferredCdpPort,
  cdpProfile,
  browserBinArg,
  startBraveForCdp,
  chromium,
  fetchUrlFromContext,
  fetchUrlsFromContext,
  searchWebFromContext,
  httpFetch,
  headers,
  cleanupContextPages,
  fetchOpts,
  spawnedBrowserProcessGroupPids,
  browserFingerprint,
}) {
  const browserKind = browserFingerprint?.browserKind || null;
  const browserBrand = browserFingerprint?.browserBrand || null;
  console.error(`Starting web-browse daemon on ${daemonUrl} (headless browser + CDP)...`);

  let shuttingDown = false;
  let requestCount = 0;
  let requestCountSinceRestart = 0;
  let restartCount = 0;
  let queueDepth = 0;
  let activeCommandCount = 0;
  let lastError = null;
  let restartPromise = null;
  let queue = Promise.resolve();

  const state = {
    browserProcess: null,
    browser: null,
    context: null,
    keepAlivePage: null,
    sessionStartedAt: 0,
    needsRestart: false,
    restartReason: null,
    lastDisconnectAt: null,
    adoptedBrowser: false,
  };

  const browserLifecycle = {
    maxAgeMs: Number.isFinite(DEFAULT_MAX_BROWSER_AGE_MS) ? DEFAULT_MAX_BROWSER_AGE_MS : 4 * 60 * 60 * 1000,
    maxRequests: Number.isFinite(DEFAULT_MAX_REQUESTS_PER_BROWSER) ? DEFAULT_MAX_REQUESTS_PER_BROWSER : 75,
  };

  const enqueue = (fn) => {
    queueDepth += 1;
    queue = queue
      .then(fn, fn)
      .finally(() => {
        queueDepth = Math.max(0, queueDepth - 1);
      });
    return queue;
  };

  function getReadyState() {
    const browserPid = state.browserProcess?.proc?.pid || null;
    const browserConnected = Boolean(state.browser?.isConnected?.());
    const browserProcessAlive = browserPid ? isProcessRunning(browserPid) : browserConnected;
    const keepAliveReady = Boolean(state.keepAlivePage && !state.keepAlivePage.isClosed?.());
    const ready = browserConnected && browserProcessAlive && Boolean(state.context) && keepAliveReady && !state.needsRestart;

    return {
      ready,
      browserPid,
      browserConnected,
      browserProcessAlive,
      keepAliveReady,
    };
  }

  async function closeBrowserSession() {
    const browser = state.browser;
    const browserProcess = state.browserProcess;

    state.browser = null;
    state.context = null;
    state.keepAlivePage = null;
    state.browserProcess = null;
    state.sessionStartedAt = 0;
    state.adoptedBrowser = false;

    if (browser) {
      await browser.close().catch(() => {});
    }

    if (browserProcess?.proc?.pid) {
      if (spawnedBrowserProcessGroupPids) spawnedBrowserProcessGroupPids.delete(browserProcess.proc.pid);
      killBrowserProcess(browserProcess.proc);
    }
  }

  function scheduleRestart(reason) {
    state.needsRestart = true;
    state.restartReason = reason;
    state.lastDisconnectAt = new Date().toISOString();
    lastError = reason;

    if (!shuttingDown && activeCommandCount === 0) {
      void ensureBrowserReady({ forceRestart: true, reason }).catch((error) => {
        lastError = error instanceof Error ? error.message : String(error);
        console.error(`Background browser restart failed: ${lastError}`);
      });
    }
  }

  async function prepareContext(context) {
    if (browserFingerprint) {
      await applyFingerprintToContext(context, browserFingerprint);
    }

    const keepAlivePage = context.pages()[0] ?? await context.newPage();
    try {
      if (keepAlivePage.url() !== "about:blank") {
        await keepAlivePage.goto("about:blank").catch(() => {});
      }
    } catch {
      // ignore
    }

    return keepAlivePage;
  }

  async function tryConnectToExistingBrowserSession() {
    const existingVersion = await waitForCdpVersion(preferredCdpPort, 750);
    if (!isLikelyUsableBrowserCdp(existingVersion)) return null;

    try {
      console.error(`Adopting existing browser on CDP port ${preferredCdpPort}...`);
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${preferredCdpPort}`);
      const context = browser.contexts()[0] ?? await browser.newContext();
      const keepAlivePage = await prepareContext(context);
      return {
        browser,
        context,
        keepAlivePage,
        browserProcess: { proc: null, port: preferredCdpPort, adopted: true },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to adopt existing browser on CDP port ${preferredCdpPort}: ${message}`);
      return null;
    }
  }

  async function ensureBrowserReady({ forceRestart = false, reason = null } = {}) {
    if (restartPromise) return await restartPromise;

    const { ready } = getReadyState();
    if (!forceRestart && ready) {
      return { browser: state.browser, context: state.context, keepAlivePage: state.keepAlivePage };
    }

    restartPromise = (async () => {
      const restartReason = reason || state.restartReason || (forceRestart ? "forced restart" : "browser not ready");
      if (state.browserProcess || state.browser) {
        console.error(`Restarting browser session (${restartReason})...`);
      }

      await closeBrowserSession();

      const adoptedSession = await tryConnectToExistingBrowserSession();
      const browserProcess = adoptedSession?.browserProcess
        ?? await startBraveForCdp(preferredCdpPort, cdpProfile, browserBinArg);

      if (browserProcess.adopted) {
        console.error(`Using existing browser for daemon (cdpPort=${browserProcess.port})`);
      } else {
        console.error(`Browser started for daemon (pid=${browserProcess.proc.pid}, cdpPort=${browserProcess.port})`);
      }

      const browser = adoptedSession?.browser
        ?? await chromium.connectOverCDP(`http://127.0.0.1:${browserProcess.port}`);
      const context = adoptedSession?.context ?? browser.contexts()[0] ?? await browser.newContext();
      const keepAlivePage = adoptedSession?.keepAlivePage ?? await prepareContext(context);

      browser.on("disconnected", () => {
        if (!shuttingDown) {
          scheduleRestart("browser disconnected");
        }
      });

      if (browserProcess.proc?.once) {
        browserProcess.proc.once("exit", (code, signal) => {
          if (!shuttingDown) {
            scheduleRestart(`browser process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
          }
        });
      }

      state.browserProcess = browserProcess;
      state.browser = browser;
      state.context = context;
      state.keepAlivePage = keepAlivePage;
      state.sessionStartedAt = Date.now();
      state.needsRestart = false;
      state.adoptedBrowser = Boolean(browserProcess.adopted);
      state.restartReason = null;
      requestCountSinceRestart = 0;
      lastError = null;

      if (forceRestart) restartCount += 1;

      return { browser, context, keepAlivePage };
    })().finally(() => {
      restartPromise = null;
    });

    return await restartPromise;
  }

  function getRecycleReason() {
    if (!state.sessionStartedAt) return null;

    const ageMs = Date.now() - state.sessionStartedAt;
    if (browserLifecycle.maxAgeMs > 0 && ageMs >= browserLifecycle.maxAgeMs) {
      return `session age ${Math.round(ageMs / 1000)}s exceeded ${Math.round(browserLifecycle.maxAgeMs / 1000)}s`;
    }
    if (browserLifecycle.maxRequests > 0 && requestCountSinceRestart >= browserLifecycle.maxRequests) {
      return `request count ${requestCountSinceRestart} exceeded ${browserLifecycle.maxRequests}`;
    }

    return null;
  }

  async function maybeRecycleBrowser() {
    const recycleReason = getRecycleReason();
    if (!recycleReason) return;
    await ensureBrowserReady({ forceRestart: true, reason: recycleReason });
  }

  async function executeCommand(command, payload, context) {
    if (command === "fetch") {
      if (!payload.url) throw new Error("fetch requires payload.url");
      return await fetchUrlFromContext(context, payload.url, Boolean(payload.truncate), fetchOpts);
    }

    if (command === "fetchMany") {
      if (!Array.isArray(payload.urls)) throw new Error("fetchMany requires payload.urls[]");
      return await fetchUrlsFromContext(context, payload.urls, Boolean(payload.truncate), fetchOpts);
    }

    if (command === "search") {
      if (!payload.query) throw new Error("search requires payload.query");
      const n = Number.isFinite(payload.numResults) ? payload.numResults : 5;

      return await searchWebFromContext({
        context,
        httpFetch,
        headers,
        query: payload.query,
        numResults: n,
        log: (msg) => {
          if (String(msg).toLowerCase().includes("failed")) console.error(msg);
        },
      });
    }

    throw new Error(`unknown command: ${command}`);
  }

  async function runCommand(command, payload) {
    let attempts = 0;

    while (attempts < 2) {
      attempts += 1;
      let activeContext = null;
      let keepAlivePage = null;

      try {
        const session = await ensureBrowserReady({
          forceRestart: attempts > 1,
          reason: attempts > 1 ? `retrying command after browser failure (${command})` : null,
        });
        activeContext = session.context;
        keepAlivePage = session.keepAlivePage;

        requestCount += 1;
        requestCountSinceRestart += 1;
        activeCommandCount += 1;

        const data = await executeCommand(command, payload, activeContext);
        await cleanupContextPages(activeContext, keepAlivePage);
        await maybeRecycleBrowser();
        return data;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = message;

        await cleanupContextPages(activeContext, keepAlivePage).catch(() => {});

        if (attempts < 2 && (state.needsRestart || isRecoverableBrowserError(error))) {
          console.error(`Daemon command ${command} hit a browser failure (${message}). Retrying once...`);
          await ensureBrowserReady({ forceRestart: true, reason: `recovering from command failure: ${message}` });
          continue;
        }

        throw error;
      } finally {
        if (activeCommandCount > 0) activeCommandCount -= 1;
      }
    }

    throw new Error(`command failed after retry: ${command}`);
  }

  await ensureBrowserReady({ reason: "initial startup" });

  const server = createHttpServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const readyState = getReadyState();
      const pages = (() => {
        try {
          return state.context?.pages().map((p) => ({ url: p.url(), closed: p.isClosed() })) || [];
        } catch {
          return [];
        }
      })();

      const payload = {
        status: readyState.ready ? "ok" : "degraded",
        pid: process.pid,
        browserPid: readyState.browserPid,
        bravePid: readyState.browserPid,
        cdpPort: state.browserProcess?.port || null,
        profileDir: cdpProfile,
        browserKind,
        browserBrand,
        requests: requestCount,
        requestsSinceRestart: requestCountSinceRestart,
        restartCount,
        queueDepth,
        activeCommandCount,
        pageCount: pages.length,
        pages,
        uptimeSec: Math.round(process.uptime()),
        sessionAgeSec: state.sessionStartedAt ? Math.round((Date.now() - state.sessionStartedAt) / 1000) : null,
        ready: readyState.ready,
        browserConnected: readyState.browserConnected,
        browserProcessAlive: readyState.browserProcessAlive,
        keepAliveReady: readyState.keepAliveReady,
        needsRestart: state.needsRestart,
        restartReason: state.restartReason,
        lastDisconnectAt: state.lastDisconnectAt,
        lastError,
        adoptedBrowser: state.adoptedBrowser,
      };

      res.writeHead(readyState.ready ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));

      if (!readyState.ready && !shuttingDown && activeCommandCount === 0) {
        void ensureBrowserReady({ forceRestart: true, reason: state.restartReason || "health check detected degraded session" }).catch((error) => {
          lastError = error instanceof Error ? error.message : String(error);
          console.error(`Health-triggered restart failed: ${lastError}`);
        });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/command") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        enqueue(async () => {
          try {
            const parsed = JSON.parse(body || "{}");
            const command = parsed.command;
            const payload = parsed.payload || {};
            const data = await runCommand(command, payload);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, data }));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            lastError = message;
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: message }));
          }
        }).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          lastError = message;
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: message }));
          }
        });
      });
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.listen(daemonPort, "127.0.0.1", () => {
    try {
      writeFileSync(daemonPidFile, String(process.pid));
    } catch {
      // ignore
    }
    console.error(`Daemon listening on ${daemonUrl}`);
  });

  const shutdown = async () => {
    shuttingDown = true;

    try {
      server.close();
    } catch {
      // ignore
    }

    try {
      await closeBrowserSession();
    } catch {
      // ignore
    }

    try {
      rmSync(daemonPidFile, { force: true });
    } catch {
      // ignore
    }

    process.exit(0);
  };

  // Override any default one-shot signal handlers.
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
