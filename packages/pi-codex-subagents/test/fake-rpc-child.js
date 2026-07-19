#!/usr/bin/env node

import * as fs from "node:fs";
import * as readline from "node:readline";

const sessionIndex = process.argv.indexOf("--session");
const sessionFile = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : undefined;

function record(value) {
  if (sessionFile) fs.appendFileSync(sessionFile, `${JSON.stringify({ pid: process.pid, ...value })}\n`);
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

record({ type: "started" });
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    send({ type: "response", id: command.id, success: true, data: {} });
    return;
  }
  if (command.type === "prompt") {
    record({ type: "prompt", message: command.message });
    send({ type: "response", id: command.id, success: true, data: {} });
    send({ type: "agent_start" });
    if (String(command.message).startsWith("hold")) return;
    setTimeout(() => {
      const failing = String(command.message).startsWith("fail");
      send({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `response:${command.message}` }],
          stopReason: failing ? "error" : "stop",
          ...(failing ? { errorMessage: "fake failure" } : {}),
        },
      });
      send({ type: "agent_settled" });
    }, 50);
    return;
  }
  if (command.type === "steer" || command.type === "abort") {
    send({ type: "response", id: command.id, success: true, data: {} });
  }
});
