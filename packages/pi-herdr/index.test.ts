import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import herdrExtension from "./index";

const currentPane = {
	pane_id: "w1:p1",
	workspace_id: "w1",
	tab_id: "w1:t1",
	focused: false,
	cwd: "/repo",
	foreground_cwd: "/repo",
	agent: "pi",
	agent_status: "working",
};

const reviewer = {
	name: "reviewer",
	agent: "codex",
	display_agent: "Codex",
	agent_status: "idle",
	workspace_id: "w1",
	tab_id: "w1:t1",
	pane_id: "w1:p2",
	focused: false,
	cwd: "/repo",
};

function response(result: unknown, stdout?: string) {
	return {
		stdout: stdout ?? JSON.stringify({ id: "test", result }),
		stderr: "",
		code: 0,
		killed: false,
	};
}

function registerToolsWithExec(exec: (command: string, args: string[]) => Promise<any>) {
	const tools = new Map<string, any>();
	const pi = {
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		exec,
	};
	herdrExtension(pi as any);
	return tools;
}

function registerTools(handler: (args: string[]) => unknown | string) {
	return registerToolsWithExec(async (command, args) => {
		expect(command).toBe("herdr");
		const result = handler(args);
		return typeof result === "string" ? response(undefined, result) : response(result);
	});
}

beforeEach(() => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = currentPane.pane_id;
});

afterEach(() => {
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_PANE_ID;
});

describe("pi-herdr", () => {
	test("registers only inside Herdr", () => {
		delete process.env.HERDR_ENV;
		const tools = registerTools(() => ({}));
		expect(tools.size).toBe(0);
	});

	test("registers separate layout, pane, and agent primitives", () => {
		const tools = registerTools(() => ({}));
		expect([...tools.keys()]).toEqual(["herdr_layout", "herdr_pane", "herdr_agent"]);
		expect(tools.get("herdr_layout").description).toContain("Workspaces contain tabs; tabs contain panes");
		expect(tools.get("herdr_pane").description).toContain("ordinary processes");
		expect(tools.get("herdr_agent").description).toContain("existing Herdr pane");
	});

	test("splits the caller pane from geometry while preserving cwd and focus", async () => {
		const calls: string[][] = [];
		const splitPane = { ...currentPane, pane_id: "w1:p2", agent: undefined, agent_status: "unknown" };
		const tools = registerTools((args) => {
			calls.push(args);
			if (args[0] === "pane" && args[1] === "current") return { type: "pane_current", pane: currentPane };
			if (args[0] === "pane" && args[1] === "layout") {
				return {
					type: "pane_layout",
					layout: {
						workspace_id: "w1",
						tab_id: "w1:t1",
						zoomed: false,
						focused_pane_id: "w1:p1",
						area: { x: 0, y: 0, width: 160, height: 40 },
						panes: [{ pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 160, height: 40 } }],
						splits: [],
					},
				};
			}
			if (args[0] === "pane" && args[1] === "split") return { type: "pane_info", pane: splitPane };
			throw new Error(`unexpected command: ${args.join(" ")}`);
		});

		const result = await tools.get("herdr_layout").execute(
			"test",
			{ action: "pane_split" },
			undefined,
			undefined,
			{},
		);

		expect(calls).toContainEqual(["pane", "layout", "--pane", "w1:p1"]);
		expect(calls).toContainEqual([
			"pane",
			"split",
			"w1:p1",
			"--direction",
			"right",
			"--cwd",
			"/repo",
			"--no-focus",
		]);
		expect(result.details.pane.pane_id).toBe("w1:p2");
	});

	test("waits for ordinary output through pane wait-output", async () => {
		const calls: string[][] = [];
		const tools = registerTools((args) => {
			calls.push(args);
			return {
				type: "pane_output_matched",
				pane_id: "w1:p2",
				matched_line: "server ready",
				read: { text: "booting\nserver ready\n" },
			};
		});

		const result = await tools.get("herdr_pane").execute(
			"test",
			{ action: "wait_output", pane: "w1:p2", match: "ready", timeout: 30000 },
			undefined,
			undefined,
			{},
		);

		expect(calls).toEqual([["pane", "wait-output", "w1:p2", "--match", "ready", "--timeout", "30000"]]);
		expect(result.content[0].text).toContain("server ready");
	});

	test("submits a silent pane command exactly once and separates command status", async () => {
		const calls: string[][] = [];
		const tools = registerToolsWithExec(async (command, args) => {
			expect(command).toBe("herdr");
			calls.push(args);
			return { stdout: "", stderr: "", code: 0, killed: false };
		});

		const result = await tools.get("herdr_pane").execute(
			"test",
			{ action: "run", pane: "w1:p2", command: ":" },
			undefined,
			undefined,
			{},
		);

		expect(calls).toEqual([["pane", "run", "w1:p2", ":"]]);
		expect(result.content[0].text).toContain("submission accepted");
		expect(result.details).toEqual({
			action: "run",
			pane: "w1:p2",
			command: ":",
			submissionStatus: "accepted",
			commandStatus: "not_observed",
			commandExitCode: null,
		});
	});

	test("keeps a confirmed code-zero submission accepted when cancellation races after completion", async () => {
		const controller = new AbortController();
		const calls: string[][] = [];
		const tools = registerToolsWithExec(async (_command, args) => {
			calls.push(args);
			controller.abort();
			return { stdout: "", stderr: "", code: 0, killed: false };
		});

		const result = await tools.get("herdr_pane").execute(
			"test",
			{ action: "run", pane: "w1:p2", command: ":" },
			controller.signal,
			undefined,
			{},
		);

		expect(calls).toHaveLength(1);
		expect(result.details.submissionStatus).toBe("accepted");
	});

	test("does not parse pane banners, ANSI, or stderr as run protocol JSON", async () => {
		const calls: string[][] = [];
		const tools = registerToolsWithExec(async (_command, args) => {
			calls.push(args);
			return {
				stdout: "\u001b[31mstartup banner\u001b[0m\n{not-json}\n",
				stderr: "shell warning that is not protocol output\n",
				code: 0,
				killed: false,
			};
		});

		const result = await tools.get("herdr_pane").execute(
			"test",
			{ action: "run", pane: "w1:p2", command: "printf done" },
			undefined,
			undefined,
			{},
		);

		expect(calls).toHaveLength(1);
		expect(result.details.submissionStatus).toBe("accepted");
		expect(result.details.commandStatus).toBe("not_observed");
	});

	test("does not treat JSON-shaped code-zero stdout as a submission error", async () => {
		const calls: string[][] = [];
		const tools = registerToolsWithExec(async (_command, args) => {
			calls.push(args);
			return {
				stdout: `${JSON.stringify({ error: { code: "not_protocol", message: "pane banner data" } })}\n`,
				stderr: "",
				code: 0,
				killed: false,
			};
		});

		const result = await tools.get("herdr_pane").execute(
			"test",
			{ action: "run", pane: "w1:p2", command: ":" },
			undefined,
			undefined,
			{},
		);

		expect(calls).toHaveLength(1);
		expect(result.details.submissionStatus).toBe("accepted");
	});

	test("reports an explicit Herdr rejection as a failed submission without retry", async () => {
		const calls: string[][] = [];
		const tools = registerToolsWithExec(async (_command, args) => {
			calls.push(args);
			return {
				stdout: "",
				stderr: `${JSON.stringify({ error: { code: "pane_not_found", message: "pane w1:p2 not found" } })}\n`,
				code: 1,
				killed: false,
			};
		});

		expect(
			tools.get("herdr_pane").execute(
				"test",
				{ action: "run", pane: "w1:p2", command: "printf must-not-run" },
				undefined,
				undefined,
				{},
			),
		).rejects.toThrow("Pane command submission failed (pane_not_found): pane w1:p2 not found");
		expect(calls).toHaveLength(1);
	});

	test("reports an unstructured client failure as ambiguous without retry", async () => {
		const calls: string[][] = [];
		const tools = registerToolsWithExec(async (_command, args) => {
			calls.push(args);
			return {
				stdout: "",
				stderr: "socket closed after request write",
				code: 1,
				killed: false,
			};
		});

		expect(
			tools.get("herdr_pane").execute(
				"test",
				{ action: "run", pane: "w1:p2", command: "printf maybe-ran" },
				undefined,
				undefined,
				{},
			),
		).rejects.toThrow(/submission outcome is ambiguous.*do not retry automatically/i);
		expect(calls).toHaveLength(1);
	});

	test("reports a killed Herdr client as ambiguous without retry", async () => {
		const calls: string[][] = [];
		const tools = registerToolsWithExec(async (_command, args) => {
			calls.push(args);
			return { stdout: "", stderr: "", code: 0, killed: true };
		});

		expect(
			tools.get("herdr_pane").execute(
				"test",
				{ action: "run", pane: "w1:p2", command: "printf maybe-ran" },
				undefined,
				undefined,
				{},
			),
		).rejects.toThrow(/submission outcome is ambiguous.*do not retry automatically/i);
		expect(calls).toHaveLength(1);
	});

	test("does not confuse a target command exit with submission acknowledgement", async () => {
		const calls: string[][] = [];
		const tools = registerToolsWithExec(async (_command, args) => {
			calls.push(args);
			return { stdout: "", stderr: "", code: 0, killed: false };
		});

		const result = await tools.get("herdr_pane").execute(
			"test",
			{ action: "run", pane: "w1:p2", command: "sh -c 'exit 7'" },
			undefined,
			undefined,
			{},
		);

		expect(calls).toHaveLength(1);
		expect(result.details.submissionStatus).toBe("accepted");
		expect(result.details.commandStatus).toBe("not_observed");
		expect(result.details.commandExitCode).toBeNull();
	});

	test("refuses to close the caller pane", async () => {
		const tools = registerTools((args) => {
			if (args[0] === "pane" && args[1] === "current") return { type: "pane_current", pane: currentPane };
			throw new Error(`unexpected command: ${args.join(" ")}`);
		});

		expect(
			tools.get("herdr_pane").execute(
				"test",
				{ action: "close", pane: "w1:p1" },
				undefined,
				undefined,
				{},
			),
		).rejects.toThrow("Refusing to close");
	});

	test("starts a named agent in an existing pane", async () => {
		const calls: string[][] = [];
		const tools = registerTools((args) => {
			calls.push(args);
			return { type: "agent_started", agent: reviewer, argv: ["codex", "-m", "gpt-5.4"] };
		});

		const result = await tools.get("herdr_agent").execute(
			"test",
			{
				action: "start",
				name: "reviewer",
				kind: "codex",
				pane: "w1:p2",
				agentArgs: ["-m", "gpt-5.4"],
			},
			undefined,
			undefined,
			{},
		);

		expect(calls).toEqual([
			["agent", "start", "reviewer", "--kind", "codex", "--pane", "w1:p2", "--", "-m", "gpt-5.4"],
		]);
		expect(result.details.agent.name).toBe("reviewer");
	});

	test("prompts through the agent surface and waits by default", async () => {
		const calls: string[][] = [];
		const tools = registerTools((args) => {
			calls.push(args);
			return { type: "agent_prompted", agent: { ...reviewer, agent_status: "done" } };
		});

		const result = await tools.get("herdr_agent").execute(
			"test",
			{
				action: "prompt",
				target: "reviewer",
				prompt: "Review the current diff",
				until: ["idle", "done"],
				timeout: 120000,
			},
			undefined,
			undefined,
			{},
		);

		expect(calls).toEqual([
			[
				"agent",
				"prompt",
				"reviewer",
				"Review the current diff",
				"--wait",
				"--until",
				"idle",
				"--until",
				"done",
				"--timeout",
				"120000",
			],
		]);
		expect(result.details.agent.agent_status).toBe("done");
	});

	test("reads through the resolved agent surface", async () => {
		const calls: string[][] = [];
		const tools = registerTools((args) => {
			calls.push(args);
			return "review complete\n";
		});

		const result = await tools.get("herdr_agent").execute(
			"test",
			{ action: "read", target: "reviewer", lines: 120 },
			undefined,
			undefined,
			{},
		);

		expect(calls).toEqual([
			["agent", "read", "reviewer", "--source", "recent-unwrapped", "--lines", "120"],
		]);
		expect(result.content[0].text).toBe("review complete\n");
	});

	test("sends validated keys without expecting agent data in the response", async () => {
		const calls: string[][] = [];
		const tools = registerTools((args) => {
			calls.push(args);
			return { type: "ok" };
		});

		const result = await tools.get("herdr_agent").execute(
			"test",
			{ action: "send_keys", target: "reviewer", keys: ["esc", "ctrl+c"] },
			undefined,
			undefined,
			{},
		);

		expect(calls).toEqual([["agent", "send-keys", "reviewer", "esc", "ctrl+c"]]);
		expect(result.content[0].text).toBe("Sent esc ctrl+c to reviewer");
	});
});
