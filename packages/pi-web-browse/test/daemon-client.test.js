import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { checkDaemonHealth, sendDaemonCommand } from "../lib/daemon-client.js";

async function withServer(handler, run) {
  const server = createServer(handler);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test("checkDaemonHealth returns degraded payloads so callers can avoid double-spawning", async () => {
  await withServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "degraded", ready: false, pid: 123 }));
      return;
    }

    res.writeHead(404);
    res.end();
  }, async (baseUrl) => {
    const health = await checkDaemonHealth({ daemonUrl: baseUrl, timeoutMs: 1000 });
    assert.deepEqual(health, { status: "degraded", ready: false, pid: 123 });
  });
});

test("sendDaemonCommand honors timeoutMs overrides", async () => {
  await withServer((req, res) => {
    if (req.method === "POST" && req.url === "/command") {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, data: { ok: true } }));
      }, 120);
      return;
    }

    res.writeHead(404);
    res.end();
  }, async (baseUrl) => {
    await assert.rejects(
      sendDaemonCommand({ daemonUrl: baseUrl, command: "fetch", payload: {}, timeoutMs: 20 }),
      /timeout|abort/i,
    );

    const data = await sendDaemonCommand({ daemonUrl: baseUrl, command: "fetch", payload: {}, timeoutMs: 1000 });
    assert.deepEqual(data, { ok: true });
  });
});
