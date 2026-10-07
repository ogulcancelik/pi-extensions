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

function registerTools(handler: (args: string[]) => unknown | string) {
	const tools = new Map<string, any>();
	const pi = {
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		async exec(command: string, args: string[]) {
			expect(command).toBe("herdr");
			const result = handler(args);
			return typeof result === "string" ? response(undefined, result) : response(result);
		},
	};
	herdrExtension(pi as any);
	return tools;
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

	describe("pane_move", () => {
		const movedPane = { ...currentPane, pane_id: "w2:p6", tab_id: "w2:t3", workspace_id: "w2" };
		const moveResult = {
			changed: true,
			pane: movedPane,
			previous_pane_id: "w1:p2",
			previous_tab_id: "w1:t1",
			previous_workspace_id: "w1",
		};

		test("documents the action and changed pane IDs in the schema and prompts", () => {
			const tool = registerTools(() => ({})).get("herdr_layout");
			expect(JSON.stringify(tool.parameters.properties.action)).toContain("pane_move");
			expect(tool.parameters.properties.pane.description).toContain("Required for pane_move");
			expect(tool.parameters.properties.focus.description).toContain("Defaults to false");
			expect(tool.description).toContain("use the returned pane ID afterwards");
			expect(tool.promptGuidelines.join("\n")).toContain("Agent names follow the pane");
		});

		const modes = [
			{
				name: "existing tab with default target and ratio",
				params: { tab: "w2:t3", direction: "down" },
				flags: ["--tab", "w2:t3", "--split", "down", "--no-focus"],
			},
			{
				name: "existing tab with target, ratio, and focus",
				params: { tab: "w2:t3", direction: "right", targetPane: "w2:p1", ratio: 0.4, focus: true },
				flags: ["--tab", "w2:t3", "--split", "right", "--target-pane", "w2:p1", "--ratio", "0.4", "--focus"],
			},
			{
				name: "new tab in the source workspace",
				params: { newTab: true },
				flags: ["--new-tab", "--no-focus"],
			},
			{
				name: "new tab in an explicit workspace with label and focus",
				params: { newTab: true, workspace: "w2", label: "review tab", focus: true },
				flags: ["--new-tab", "--workspace", "w2", "--label", "review tab", "--focus"],
			},
			{
				name: "new workspace with default labels",
				params: { newWorkspace: true, focus: false },
				flags: ["--new-workspace", "--no-focus"],
			},
			{
				name: "new workspace with both labels and focus",
				params: { newWorkspace: true, label: "review workspace", tabLabel: "agent tab", focus: true },
				flags: ["--new-workspace", "--label", "review workspace", "--tab-label", "agent tab", "--focus"],
			},
		];

		for (const machine of [undefined, "devbox"]) {
			for (const mode of modes) {
				test(`moves to ${mode.name} ${machine ? "remotely" : "locally"} and returns the new IDs`, async () => {
					const calls: string[][] = [];
					const tools = registerTools((args) => {
						calls.push(args);
						return { type: "pane_move", move_result: moveResult };
					});
					const result = await tools.get("herdr_layout").execute(
						"test",
						{ action: "pane_move", pane: "w1:p2", ...mode.params, machine },
						undefined,
						undefined,
						{},
					);

					expect(calls).toEqual([[
						...(machine ? ["--machine", machine] : []), "pane", "move", "w1:p2", ...mode.flags,
					]]);
					expect(result.content[0].text).toContain("pane w2:p6, tab w2:t3, workspace w2");
					expect(result.content[0].text).toContain("Use pane w2:p6 for subsequent calls");
					expect(result.details.pane).toEqual(movedPane);
					expect(result.details.sourcePaneId).toBe("w1:p2");
					expect(result.details.moveResult).toEqual(moveResult);
				});
			}
		}

		const invalid = [
			{ params: { newTab: true }, error: "'pane' is required" },
			{ params: { pane: "w1:p2" }, error: "exactly one" },
			{ params: { pane: "w1:p2", newTab: false, newWorkspace: false }, error: "exactly one" },
			{ params: { pane: "w1:p2", newTab: true, newWorkspace: true }, error: "exactly one" },
			{ params: { pane: "w1:p2", tab: "w2:t1", newTab: true }, error: "exactly one" },
			{ params: { pane: "w1:p2", tab: "w2:t1", newWorkspace: true }, error: "exactly one" },
			{ params: { pane: "w1:p2", tab: "w2:t1" }, error: "'direction' is required" },
			{ params: { pane: "w1:p2", tab: "w2:t1", direction: "right", workspace: "w2" }, error: "'workspace' is only valid" },
			{ params: { pane: "w1:p2", newWorkspace: true, workspace: "w2" }, error: "'workspace' is only valid" },
			{ params: { pane: "w1:p2", newTab: true, tabLabel: "agent" }, error: "'tabLabel' is only valid" },
			{ params: { pane: "w1:p2", tab: "w2:t1", direction: "right", label: "tab" }, error: "'label' requires" },
			{ params: { pane: "w1:p2", newTab: true, direction: "right" }, error: "require 'tab'" },
			{ params: { pane: "w1:p2", newWorkspace: true, targetPane: "w2:p1" }, error: "require 'tab'" },
			{ params: { pane: "w1:p2", newTab: true, ratio: 0.5 }, error: "require 'tab'" },
		];

		for (const { params, error } of invalid) {
			test(`rejects invalid move ${JSON.stringify(params)} before executing`, async () => {
				const calls: string[][] = [];
				const tools = registerTools((args) => {
					calls.push(args);
					return {};
				});
				await expect(
					tools.get("herdr_layout").execute("test", { action: "pane_move", ...params }, undefined, undefined, {}),
				).rejects.toThrow(error);
				expect(calls).toEqual([]);
			});
		}

		test("reports the returned IDs even when the pane ID stays the same", async () => {
			const tools = registerTools(() => ({
				type: "pane_move",
				move_result: { ...moveResult, pane: { ...currentPane, tab_id: "w1:t2" }, previous_pane_id: "w1:p1" },
			}));
			const result = await tools.get("herdr_layout").execute(
				"test", { action: "pane_move", pane: "w1:p1", newTab: true }, undefined, undefined, {},
			);
			expect(result.content[0].text).toContain("pane w1:p1, tab w1:t2, workspace w1");
			expect(result.details.pane.pane_id).toBe("w1:p1");
		});

		test("propagates Herdr move errors", async () => {
			const tools = registerTools(() => JSON.stringify({ error: { code: "pane_not_found", message: "No such pane" } }));
			await expect(
				tools.get("herdr_layout").execute("test", { action: "pane_move", pane: "w1:p2", newTab: true }, undefined, undefined, {}),
			).rejects.toThrow("No such pane");
		});
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

	describe("machine", () => {
		const remotePane = {
			...currentPane,
			pane_id: "w2:p1",
			workspace_id: "w2",
			tab_id: "w2:t1",
			cwd: "/remote/repo",
			foreground_cwd: "/remote/repo",
		};

		function rejectCurrent(args: string[]) {
			const command = args[0] === "--machine" ? args.slice(2) : args;
			if (command[0] === "pane" && command[1] === "current") throw new Error("remote calls must not resolve the caller pane");
		}

		test("lists saved machines", async () => {
			const calls: string[][] = [];
			const tools = registerTools((args) => {
				calls.push(args);
				return JSON.stringify([
					{ id: "abc123", label: "devbox", target: "devbox", session: "default", enabled: true, selected: false },
					{ id: "def456", label: "box", target: "me@box.local", session: "default", enabled: false, selected: false },
				]);
			});

			const result = await tools.get("herdr_layout").execute("test", { action: "machine_list" }, undefined, undefined, {});

			expect(calls).toEqual([["machine", "list", "--json"]]);
			expect(result.content[0].text).toBe("devbox: [abc123]\nbox: [def456] (target me@box.local, disabled)");
			expect(result.details.machines).toHaveLength(2);
		});

		test("prefixes agent commands with --machine", async () => {
			const calls: string[][] = [];
			const tools = registerTools((args) => {
				calls.push(args);
				return { type: "agent_prompted", agent: { ...reviewer, agent_status: "done" } };
			});

			await tools.get("herdr_agent").execute(
				"test",
				{ action: "prompt", target: "w2:p1", prompt: "hi", machine: "devbox" },
				undefined,
				undefined,
				{},
			);

			expect(calls).toEqual([["--machine", "devbox", "agent", "prompt", "w2:p1", "hi", "--wait"]]);
		});

		test("rejects machine values that look like flags", async () => {
			const tools = registerTools(() => ({ type: "agent_list", agents: [] }));

			await expect(
				tools.get("herdr_agent").execute("test", { action: "list", machine: "--help" }, undefined, undefined, {}),
			).rejects.toThrow("Invalid machine");
		});

		test("refuses caller-relative current on a remote machine", async () => {
			const tools = registerTools((args) => {
				rejectCurrent(args);
				return {};
			});

			await expect(
				tools.get("herdr_layout").execute("test", { action: "current", machine: "devbox" }, undefined, undefined, {}),
			).rejects.toThrow("not available with 'machine'");
		});

		test("lists every remote pane when no workspace is given", async () => {
			const calls: string[][] = [];
			const tools = registerTools((args) => {
				calls.push(args);
				rejectCurrent(args);
				return { type: "pane_list", panes: [remotePane] };
			});

			const result = await tools.get("herdr_layout").execute(
				"test",
				{ action: "pane_list", machine: "devbox" },
				undefined,
				undefined,
				{},
			);

			expect(calls).toEqual([["--machine", "devbox", "pane", "list"]]);
			expect(result.content[0].text).not.toContain("current");
		});

		test("requires an explicit pane to split on a remote machine", async () => {
			const tools = registerTools((args) => {
				rejectCurrent(args);
				return {};
			});

			await expect(
				tools.get("herdr_layout").execute("test", { action: "pane_split", machine: "devbox" }, undefined, undefined, {}),
			).rejects.toThrow("'pane' is required for pane_split with 'machine'");
		});

		test("splits a remote pane using the remote pane's cwd", async () => {
			const calls: string[][] = [];
			const splitPane = { ...remotePane, pane_id: "w2:p2" };
			const tools = registerTools((args) => {
				calls.push(args);
				rejectCurrent(args);
				if (args[2] === "pane" && args[3] === "get") return { type: "pane_info", pane: remotePane };
				if (args[2] === "pane" && args[3] === "split") return { type: "pane_info", pane: splitPane };
				throw new Error(`unexpected command: ${args.join(" ")}`);
			});

			const result = await tools.get("herdr_layout").execute(
				"test",
				{ action: "pane_split", pane: "w2:p1", direction: "down", machine: "devbox" },
				undefined,
				undefined,
				{},
			);

			expect(calls).toEqual([
				["--machine", "devbox", "pane", "get", "w2:p1"],
				["--machine", "devbox", "pane", "split", "w2:p1", "--direction", "down", "--cwd", "/remote/repo", "--no-focus"],
			]);
			expect(result.details.pane.pane_id).toBe("w2:p2");
		});

		test("leaves cwd to the remote server when creating a workspace", async () => {
			const calls: string[][] = [];
			const tools = registerTools((args) => {
				calls.push(args);
				rejectCurrent(args);
				return {
					type: "workspace_created",
					workspace: { workspace_id: "w3", label: "ops", focused: false, agent_status: "unknown" },
					tab: { tab_id: "w3:t1", workspace_id: "w3", label: "1", focused: false, agent_status: "unknown" },
					root_pane: { ...remotePane, pane_id: "w3:p1" },
				};
			});

			await tools.get("herdr_layout").execute(
				"test",
				{ action: "workspace_create", label: "ops", machine: "devbox" },
				undefined,
				undefined,
				{},
			);

			expect(calls).toEqual([["--machine", "devbox", "workspace", "create", "--label", "ops", "--no-focus"]]);
		});

		test("closes a remote pane whose ID matches the caller pane", async () => {
			const calls: string[][] = [];
			const tools = registerTools((args) => {
				calls.push(args);
				rejectCurrent(args);
				return { type: "ok" };
			});

			await tools.get("herdr_pane").execute(
				"test",
				{ action: "close", pane: currentPane.pane_id, machine: "devbox" },
				undefined,
				undefined,
				{},
			);

			expect(calls).toEqual([["--machine", "devbox", "pane", "close", "w1:p1"]]);
		});
	});
});
