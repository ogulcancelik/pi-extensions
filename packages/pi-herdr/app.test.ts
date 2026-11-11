import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import herdrExtension from "./index";

/**
 * A small Herdr app: one space with one tab, Pi in pane p1 (terminal t1) and a
 * shell in pane p2 (terminal t2). It answers `herdr-app` and `hc` as the real
 * CLIs print, and records what was asked of it.
 */
class FakeApp {
	calls: string[][] = [];
	focusedPane = "p1";
	spaces = [
		{
			id: "sp1",
			name: "repo",
			folder: "/repo",
			active: true,
			tabs: [
				{
					id: "tb1",
					name: "1",
					active: true,
					terminals: [
						{ terminal: "t1", pane: "p1", status: "working", app: "pi", name: null as string | null },
						{ terminal: "t2", pane: "p2", status: null as string | null, app: null as string | null, name: null as string | null },
					],
				},
			],
		},
	];
	core: Record<string, any> = {
		t1: { address: "t1", name: null, cwd: "/repo", cols: 160, rows: 40, status: { app: "pi", state: "working" }, reported: true, labels: {}, foreground: { name: "pi", cwd: "/repo" } },
		t2: { address: "t2", name: null, cwd: "/repo", cols: 60, rows: 40, status: null, reported: false, labels: {}, foreground: { name: "nu", cwd: "/repo" } },
	};
	screen: Record<string, { text: string; complete: boolean; why?: string }> = {
		t2: { text: "$ npm test\n12 pass", complete: true },
	};
	/** What `hc send --wait` reports. */
	sendWait = { ended: true, reason: "status", status: "idle" };
	/** Runs after `hc send`, as the program reacting to what was typed. */
	onSend: (terminal: string, text: string) => void = () => {};

	handle(command: string, args: string[]): { stdout: string; code: number } {
		this.calls.push([command, ...args]);
		const ok = (value: unknown) => ({ stdout: JSON.stringify(value), code: 0 });
		if (command === "herdr-app") {
			if (args[0] === "ls") return ok({ spaces: this.spaces });
			if (args[0] === "status") return ok({ space: "sp1", tab: "tb1", focused_pane: this.focusedPane });
			const [, name, json] = args;
			const input = JSON.parse(json ?? "{}");
			switch (name) {
				case "pane.split": {
					this.spaces[0]?.tabs[0]?.terminals.push({ terminal: "t3", pane: "p3", status: null, app: null, name: null });
					this.core.t3 = { ...this.core.t2, address: "t3", cwd: input.argv ? input.argv[4] : "/repo" };
					this.focusedPane = "p3";
					return ok({ pane: "p3", terminal: "t3" });
				}
				case "pane.focus":
					this.focusedPane = input.pane;
					return ok({ ok: true });
				case "pane.close":
				case "agent.focus":
					return ok({ ok: true });
				default:
					return { stdout: JSON.stringify({ error: `unexpected ${name}` }), code: 1 };
			}
		}
		const [verb, address = ""] = args;
		const core = this.core[address];
		switch (verb) {
			case "ls":
				// hc ls gives the status word; hc get the whole report.
				return ok({ terminals: Object.values(this.core).map((t) => ({ address: t.address, cwd: t.cwd, ...(t.status ? { status: t.status.state } : {}) })) });
			case "get":
				return core ? ok(core) : { stdout: JSON.stringify({ error: { message: `no terminal "${address}"` } }), code: 3 };
			case "read":
				return ok(this.screen[address] ?? { text: "", complete: true });
			case "label": {
				const [key, value] = (args[2] ?? "").split("=");
				if (value) core.labels[key as string] = value;
				else delete core.labels[key as string];
				return ok({ ok: true });
			}
			case "send":
				this.onSend(address, args[2] ?? "");
				return ok(args.includes("--wait") ? this.sendWait : { ok: true });
			case "wait":
				return ok({ ended: true, reason: "status", status: core.status?.state ?? null });
			case "keys":
				return ok({ ok: true });
			default:
				return { stdout: JSON.stringify({ error: { message: `unexpected hc ${verb}` } }), code: 2 };
		}
	}

	/** The shell in t2 starts an agent once its command line is typed. */
	startsAgentInShell() {
		this.onSend = (terminal) => {
			if (terminal !== "t2") return;
			// herdr-core knows at once; the window's listing (herdr-app ls) catches up later.
			Object.assign(this.core.t2, { reported: true, status: { app: "codex", state: "idle" }, foreground: { name: "codex", cwd: "/repo" } });
		};
	}
}

function registerTools(app: FakeApp) {
	const tools = new Map<string, any>();
	const pi = {
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		async exec(command: string, args: string[]) {
			return { ...app.handle(command, args), stderr: "", killed: false };
		},
	};
	herdrExtension(pi as any);
	return tools;
}

function run(tools: Map<string, any>, tool: string, params: Record<string, unknown>) {
	return tools.get(tool).execute("test", params, undefined, undefined, {});
}

const saved = { ...process.env };

beforeEach(() => {
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_PANE_ID;
	process.env.HC_TERMINAL_ID = "t1";
});

afterEach(() => {
	for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HC_TERMINAL_ID"]) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

describe("pi-herdr in the Herdr app", () => {
	test("registers the same three tools as in the TUI", () => {
		expect([...registerTools(new FakeApp()).keys()]).toEqual(["herdr_layout", "herdr_pane", "herdr_agent"]);
	});

	test("finds the caller's pane from its herdr-core terminal", async () => {
		const result = await run(registerTools(new FakeApp()), "herdr_layout", { action: "current" });
		expect(result.details.pane).toMatchObject({ pane_id: "p1", workspace_id: "sp1", tab_id: "tb1", focused: true, cwd: "/repo", agent: "pi" });
	});

	test("splits from the pane's size and gives the focus back", async () => {
		const app = new FakeApp();
		const result = await run(registerTools(app), "herdr_layout", { action: "pane_split" });
		expect(result.details).toMatchObject({ direction: "right", sourcePaneId: "p1" });
		expect(result.details.pane.pane_id).toBe("p3");
		const split = app.calls.find((c) => c[2] === "pane.split");
		expect(JSON.parse(split?.[3] ?? "{}")).toEqual({ pane: "p1", direction: "right" });
		expect(app.focusedPane).toBe("p1");
	});

	test("starts a split's shell elsewhere when asked for another cwd", async () => {
		const app = new FakeApp();
		const result = await run(registerTools(app), "herdr_layout", { action: "pane_split", direction: "down", cwd: "/elsewhere" });
		const split = JSON.parse(app.calls.find((c) => c[2] === "pane.split")?.[3] ?? "{}");
		expect(split.argv.at(-1)).toBe("/elsewhere");
		expect(result.details.pane.cwd).toBe("/elsewhere");
	});

	test("says pane_layout is not available rather than inventing geometry", async () => {
		await expect(run(registerTools(new FakeApp()), "herdr_layout", { action: "pane_layout" })).rejects.toThrow(
			"pane_layout is not available in the Herdr app",
		);
	});

	test("finds existing output before waiting", async () => {
		const app = new FakeApp();
		const result = await run(registerTools(app), "herdr_pane", { action: "wait_output", pane: "p2", match: "\\d+ pass", regex: true, timeout: 1000 });
		expect(result.details.matchedLine).toBe("12 pass");
		expect(app.calls.filter((c) => c[1] === "read")).toHaveLength(1);
	});

	test("starts a named agent by typing into the pane's shell", async () => {
		const app = new FakeApp();
		app.startsAgentInShell();
		const result = await run(registerTools(app), "herdr_agent", {
			action: "start",
			name: "reviewer",
			kind: "codex",
			pane: "p2",
			agentArgs: ["--model", "gpt 6"],
		});
		expect(app.calls).toContainEqual(["hc", "send", "t2", "codex --model 'gpt 6'", "--json"]);
		expect(result.details.agent).toMatchObject({ name: "reviewer", pane_id: "p2", agent: "codex", agent_status: "idle" });
	});

	test("prompts an agent by name and waits for it to settle", async () => {
		const app = new FakeApp();
		app.startsAgentInShell();
		const tools = registerTools(app);
		await run(tools, "herdr_agent", { action: "start", name: "reviewer", kind: "codex", pane: "p2" });
		const result = await run(tools, "herdr_agent", { action: "prompt", target: "reviewer", prompt: "Review the diff." });
		expect(app.calls).toContainEqual(["hc", "send", "t2", "Review the diff.", "--wait", "--json"]);
		expect(result.details.agent.agent_status).toBe("idle");
	});

	test("reports a prompt that never started a turn as stalled", async () => {
		const app = new FakeApp();
		app.startsAgentInShell();
		const tools = registerTools(app);
		await run(tools, "herdr_agent", { action: "start", name: "reviewer", kind: "codex", pane: "p2" });
		app.sendWait = { ended: true, reason: "not_started", status: "idle" };
		await expect(run(tools, "herdr_agent", { action: "prompt", target: "reviewer", prompt: "Hi" })).rejects.toThrow("agent_prompt_stalled");
	});

	test("says when herdr-core could only read an agent's screen", async () => {
		const app = new FakeApp();
		app.screen.t1 = { text: "thinking…", complete: false, why: "only its screen: it is working" };
		const result = await run(registerTools(app), "herdr_agent", { action: "read", target: "p1" });
		expect(result.content[0].text).toBe("thinking…\n[only its screen: it is working]");
	});
});
