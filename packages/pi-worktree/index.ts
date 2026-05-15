import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readFile, stat, realpath, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "@sinclair/typebox";

let pendingWorktreeSwitch = false;

function blockForWorktreeSwitch(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (pendingWorktreeSwitch) return;
	pendingWorktreeSwitch = true;
	ctx.ui.setStatus("worktree", "switch pending — press Enter");
	if (process.env.HERDR_ENV) {
		pi.events.emit("herdr:blocked", { active: true, label: "press Enter to switch worktree" });
	}
}

function clearWorktreeBlock(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!pendingWorktreeSwitch) return;
	pendingWorktreeSwitch = false;
	ctx.ui.setStatus("worktree", undefined);
	if (process.env.HERDR_ENV) {
		pi.events.emit("herdr:blocked", { active: false });
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		if (event.source === "interactive" && pendingWorktreeSwitch) {
			clearWorktreeBlock(pi, ctx);
		}
	});

	pi.registerTool({
		name: "switch_worktree",
		label: "Switch Worktree",
		description:
			"Use this immediately after creating a new git worktree (or when you want to resume work in an existing one) " +
			"that is not the current cwd. It validates the worktree, then prefills the editor so you can press Enter to " +
			"relocate the active pi session there. The conversation history is preserved and continues from the new worktree directory.",
		promptSnippet: "Move the active session to a git worktree you just created (or want to resume work in)",
		promptGuidelines: [
			"Use switch_worktree when you have just created a new git worktree and want to start working in it.",
			"Also use switch_worktree when you want to resume work in an existing worktree that is not the current cwd.",
			"Do not use this tool if you are already inside the target worktree; the session is already there.",
			"After calling this tool, tell the user to press Enter to complete the relocation.",
		],
		parameters: Type.Object({
			path: Type.String({
				description:
					"Absolute or relative path to the worktree directory. " +
					"Must be a valid git worktree registered with git worktree add.",
			}),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const targetPath = resolve(ctx.cwd, params.path.replace(/^@/, ""));

			try {
				const s = await stat(targetPath);
				if (!s.isDirectory()) {
					throw new Error(`Path is not a directory: ${targetPath}`);
				}
			} catch {
				throw new Error(`Path does not exist: ${targetPath}`);
			}

			const porcelain = await pi.exec(
				"git",
				["worktree", "list", "--porcelain"],
				{ cwd: ctx.cwd, signal, timeout: 5000 },
			);
			if (porcelain.code !== 0) {
				throw new Error(`Failed to list worktrees: ${porcelain.stderr || porcelain.stdout}`);
			}

			const canonicalTarget = await realpath(targetPath);
			const worktrees = await parsePorcelain(porcelain.stdout);
			const match = worktrees.find((w) => w.canonical === canonicalTarget);
			if (match?.bare) {
				throw new Error(`Bare worktrees are not supported: ${canonicalTarget}`);
			}
			if (!match) {
				throw new Error(
					`Not a registered git worktree: ${targetPath}\n` +
						`Registered worktrees:\n${worktrees.map((w) => `  ${w.path}`).join("\n")}`,
				);
			}

			ctx.ui.setEditorText(`/switch-worktree ${canonicalTarget}`);
			ctx.ui.notify("Press Enter to switch worktree", "info");
			blockForWorktreeSwitch(pi, ctx);

			return {
				content: [
					{
						type: "text",
						text:
							`Validated worktree: ${canonicalTarget}\n` +
							`Branch: ${displayBranch(match.branch)}\n\n` +
							`The editor is prefilled with the switch command. Press Enter to relocate the session.`,
					},
				],
				details: { worktreePath: canonicalTarget, branch: match.branch },
				terminate: true,
			};
		},
	});

	pi.registerCommand("switch-worktree", {
		description: "Relocate the active session to a git worktree",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const rawPath = args?.trim().replace(/^@/, "");
			const worktreePath = rawPath ? resolve(ctx.cwd, rawPath) : undefined;
			if (!worktreePath) {
				ctx.ui.notify("Usage: /switch-worktree <worktree-path>", "error");
				clearWorktreeBlock(pi, ctx);
				return;
			}

			const canonicalTarget = await realpath(worktreePath).catch(() => worktreePath);

			try {
				const s = await stat(canonicalTarget);
				if (!s.isDirectory()) {
					ctx.ui.notify(`Not a directory: ${canonicalTarget}`, "error");
					clearWorktreeBlock(pi, ctx);
					return;
				}
			} catch {
				ctx.ui.notify(`Path does not exist: ${canonicalTarget}`, "error");
				clearWorktreeBlock(pi, ctx);
				return;
			}

			const porcelain = await pi.exec("git", ["worktree", "list", "--porcelain"], {
				cwd: ctx.cwd,
				timeout: 5000,
			});
			if (porcelain.code !== 0) {
				ctx.ui.notify(`Cannot verify worktrees: ${porcelain.stderr || porcelain.stdout}`, "error");
				clearWorktreeBlock(pi, ctx);
				return;
			}
			const worktrees = await parsePorcelain(porcelain.stdout);
			const match = worktrees.find((w) => w.canonical === canonicalTarget);
			if (match?.bare) {
				ctx.ui.notify(`Bare worktrees are not supported: ${canonicalTarget}`, "error");
				clearWorktreeBlock(pi, ctx);
				return;
			}
			if (!match) {
				ctx.ui.notify(`Not a registered git worktree: ${canonicalTarget}`, "error");
				clearWorktreeBlock(pi, ctx);
				return;
			}

			const currentFile = ctx.sessionManager.getSessionFile();
			if (!currentFile) {
				ctx.ui.notify("Session is not persisted, cannot switch worktree", "error");
				clearWorktreeBlock(pi, ctx);
				return;
			}

			const ok = await ctx.ui.confirm(
				"Switch worktree?",
				`Relocate session to:\n${canonicalTarget}\n\nBranch: ${displayBranch(match.branch)}`,
			);
			if (!ok) {
				clearWorktreeBlock(pi, ctx);
				ctx.ui.notify("Worktree switch cancelled", "info");
				return;
			}

			let newFile: string | undefined;
			try {
				const forked = SessionManager.forkFrom(currentFile, canonicalTarget);
				newFile = forked.getSessionFile();
				if (!newFile) {
					throw new Error("Failed to create forked session file");
				}

				// Remove parentSession to avoid a dangling reference after we delete the old file.
				const raw = await readFile(newFile, "utf8");
				const lines = raw.trimEnd().split("\n");
				if (lines.length > 0) {
					const header = JSON.parse(lines[0]);
					if (header.parentSession !== undefined) {
						delete header.parentSession;
						lines[0] = JSON.stringify(header);
						await writeFile(newFile, lines.join("\n") + "\n");
					}
				}

				const result = await ctx.switchSession(newFile, {
					withSession: async (newCtx) => {
						try {
							await unlink(currentFile);
						} catch (_err) {
							// Best-effort cleanup; don't block the switch on unlink failure.
						}
						clearWorktreeBlock(pi, newCtx);
						newCtx.ui.notify(`Session relocated to worktree: ${canonicalTarget}`, "success");

						// Trigger the next agent turn so work continues automatically.
						try {
							await newCtx.sendUserMessage(
								`Session relocated to worktree: ${canonicalTarget}. Continue working.`,
							);
						} catch (_err) {
							// If auto-continue fails, the user can still prompt manually.
						}
					},
				});

				if (result.cancelled) {
					clearWorktreeBlock(pi, ctx);
					try {
						if (newFile) await unlink(newFile);
					} catch (_err) {
						// ignore
					}
					ctx.ui.notify("Worktree switch was cancelled by another extension", "info");
				}
			} catch (err: any) {
				if (newFile) {
					try {
						await unlink(newFile);
					} catch (_err) {
						// ignore
					}
				}
				clearWorktreeBlock(pi, ctx);
				ctx.ui.notify(`Failed to switch worktree: ${err.message}`, "error");
			}
		},
	});
}

function displayBranch(branch?: string): string {
	if (!branch) return "(detached)";
	return branch.replace(/^refs\/heads\//, "");
}

interface WorktreeInfo {
	path: string;
	canonical: string;
	head?: string;
	branch?: string;
	detached?: boolean;
	bare?: boolean;
}

async function parsePorcelain(stdout: string): Promise<WorktreeInfo[]> {
	const worktrees: WorktreeInfo[] = [];
	let current: Partial<WorktreeInfo> = {};

	for (const raw of stdout.split("\n")) {
		const line = raw.trimEnd();
		if (!line) {
			if (current.path) {
				worktrees.push(current as WorktreeInfo);
			}
			current = {};
			continue;
		}

		if (line.startsWith("worktree ")) {
			current.path = line.slice(9);
			current.canonical = await realpath(current.path).catch(() => current.path!);
		} else if (line.startsWith("HEAD ")) {
			current.head = line.slice(5);
		} else if (line.startsWith("branch ")) {
			current.branch = line.slice(7);
		} else if (line === "detached") {
			current.detached = true;
		} else if (line === "bare") {
			current.bare = true;
		}
	}

	if (current.path) {
		worktrees.push(current as WorktreeInfo);
	}

	return worktrees;
}
