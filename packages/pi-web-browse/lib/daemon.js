import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { platform } from "node:os";

const IS_WINDOWS = platform() === "win32";

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
}) {
  console.error(`Starting web-browse daemon on ${daemonUrl} (headless browser + CDP)...`);

  const browserProcess = await startBraveForCdp(preferredCdpPort, cdpProfile, browserBinArg);
  console.error(`Browser started for daemon (pid=${browserProcess.proc.pid}, cdpPort=${browserProcess.port})`);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${browserProcess.port}`);
  const context = browser.contexts()[0] ?? await browser.newContext();

  // Inject stealth scripts to avoid bot detection (e.g., Google checks chrome.runtime)
  await context.addInitScript(() => {
    // Chrome extensions always define chrome.runtime - headless doesn't by default
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = { id: undefined };
  });

  // Keep one blank tab open so the browser doesn't exit when we close work tabs.
  const keepAlivePage = context.pages()[0] ?? await context.newPage();
  try {
    if (keepAlivePage.url() !== "about:blank") {
      await keepAlivePage.goto("about:blank").catch(() => {});
    }
  } catch {
    // ignore
  }

  let requestCount = 0;
  let queue = Promise.resolve();

  const enqueue = (fn) => {
    queue = queue.then(fn, fn);
    return queue;
  };

  const server = createHttpServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const pages = (() => {
        try {
          return context.pages().map((p) => ({ url: p.url(), closed: p.isClosed() }));
        } catch {
          return [];
        }
      })();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          pid: process.pid,
          bravePid: browserProcess.proc.pid,
          cdpPort: browserProcess.port,
          requests: requestCount,
          pageCount: pages.length,
          pages,
          uptimeSec: Math.round(process.uptime()),
        }),
      );
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

            requestCount += 1;

            let data;
            if (command === "fetch") {
              if (!payload.url) throw new Error("fetch requires payload.url");
              data = await fetchUrlFromContext(context, payload.url, Boolean(payload.truncate), fetchOpts);
            } else if (command === "fetchMany") {
              if (!Array.isArray(payload.urls)) throw new Error("fetchMany requires payload.urls[]");
              data = await fetchUrlsFromContext(context, payload.urls, Boolean(payload.truncate), fetchOpts);
            } else if (command === "search") {
              if (!payload.query) throw new Error("search requires payload.query");
              const n = Number.isFinite(payload.numResults) ? payload.numResults : 5;

              data = await searchWebFromContext({
                context,
                httpFetch,
                headers,
                query: payload.query,
                numResults: n,
                // Daemon should be relatively quiet; only log on hard failures.
                log: (msg) => {
                  if (String(msg).toLowerCase().includes("failed")) console.error(msg);
                },
              });
            } else {
              throw new Error(`unknown command: ${command}`);
            }

            await cleanupContextPages(context, keepAlivePage);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, data }));
          } catch (err) {
            await cleanupContextPages(context, keepAlivePage);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
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
    try {
      server.close();
    } catch {
      // ignore
    }

    try {
      await browser.close();
    } catch {
      // ignore
    }

    try {
      const pid = browserProcess.proc.pid;
      if (spawnedBrowserProcessGroupPids) spawnedBrowserProcessGroupPids.delete(pid);
      if (IS_WINDOWS) {
        spawn("taskkill", ["/pid", pid.toString(), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(-pid);
      }
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
