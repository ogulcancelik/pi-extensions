/**
 * Sketch extension - quick sketch pad that opens in browser
 * /sketch → opens browser canvas → draw → Enter sends to models
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createServer, type Server } from "node:http";
import { exec } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Load HTML from file
const __dirname = dirname(fileURLToPath(import.meta.url));
const SKETCH_HTML = readFileSync(join(__dirname, "sketch.html"), "utf-8");

function openBrowser(url: string): void {
	const platform = process.platform;
	let cmd: string;

	if (platform === "darwin") {
		cmd = `open "${url}"`;
	} else if (platform === "win32") {
		cmd = `start "" "${url}"`;
	} else {
		cmd = `xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null || x-www-browser "${url}" 2>/dev/null`;
	}

	exec(cmd);
}

interface PaintServer {
	url: string;
	waitForResult: () => Promise<string | null>;
	close: () => void;
}

function launchPaintServer(): PaintServer {
	let resolved = false;
	let resolvePromise: (value: string | null) => void;

	const resultPromise = new Promise<string | null>((resolve) => {
		resolvePromise = resolve;
	});

	const server: Server = createServer((req, res) => {
		// CORS headers for local dev
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		if (req.method === "GET" && (req.url === "/" || req.url === "/sketch")) {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(SKETCH_HTML);
			return;
		}

		if (req.method === "POST" && req.url === "/submit") {
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => {
				res.writeHead(200, { "Content-Type": "text/plain" });
				res.end("OK");

				if (!resolved) {
					resolved = true;
					server.close();
					resolvePromise(body); // base64 PNG data
				}
			});
			return;
		}

		if (req.method === "POST" && req.url === "/cancel") {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("OK");

			if (!resolved) {
				resolved = true;
				server.close();
				resolvePromise(null);
			}
			return;
		}

		// 404 for anything else
		res.writeHead(404);
		res.end("Not found");
	});

	// Handle server errors
	server.on("error", (err) => {
		console.error("Paint server error:", err);
		if (!resolved) {
			resolved = true;
			resolvePromise(null);
		}
	});

	// Get URL synchronously after listen
	let url = "";
	server.listen(0, "127.0.0.1", () => {
		const addr = server.address();
		if (addr && typeof addr === "object") {
			url = `http://127.0.0.1:${addr.port}/sketch`;
		}
	});

	// Timeout after 10 minutes
	const timeout = setTimeout(() => {
		if (!resolved) {
			resolved = true;
			server.close();
			resolvePromise(null);
		}
	}, 10 * 60 * 1000);

	return {
		get url() {
			return url;
		},
		waitForResult: () => resultPromise,
		close: () => {
			clearTimeout(timeout);
			if (!resolved) {
				resolved = true;
				server.close();
				resolvePromise(null);
			}
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("sketch", {
		description: "Open a sketch pad in browser to draw something for models",

		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Sketch requires interactive mode", "error");
				return;
			}

			const paintServer = launchPaintServer();

			// Wait a tick for the server to get its port
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Auto-open browser
			openBrowser(paintServer.url);

			// Use custom UI to show status and handle Escape to cancel
			const imageBase64 = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				// Race between browser result and user pressing Escape
				paintServer.waitForResult().then(done);

				// Simple component that shows status and handles Escape
				return {
					render(width: number): string[] {
						const line1 = theme.fg("success", "Sketch opened in browser");
						const line2 = theme.fg("muted", paintServer.url);
						const line3 = theme.fg("dim", "Press Escape to cancel");
						return [line1, line2, "", line3];
					},
					handleInput(data: string) {
						// Check for Escape
						if (data === "\x1b" || data === "\x1b\x1b") {
							paintServer.close();
							done(null);
						}
					},
				};
			});

			try {
				if (imageBase64) {
					// Save to temp file (same flow as @ image attachments)
					const sketchDir = join(tmpdir(), "pi-sketches");
					mkdirSync(sketchDir, { recursive: true });

					const timestamp = Date.now();
					const sketchPath = join(sketchDir, `sketch-${timestamp}.png`);

					// Decode base64 and write to file
					const buffer = Buffer.from(imageBase64, "base64");
					writeFileSync(sketchPath, buffer);

					// Append to editor instead of auto-sending - user can add more text
					const currentText = ctx.ui.getEditorText?.() || "";
					const prefix = currentText ? currentText + "\n" : "";
					ctx.ui.setEditorText(`${prefix}Sketch: ${sketchPath}`);
				} else {
					ctx.ui.notify("Sketch cancelled", "info");
				}
			} catch (error) {
				paintServer.close();
				ctx.ui.notify(`Sketch error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
