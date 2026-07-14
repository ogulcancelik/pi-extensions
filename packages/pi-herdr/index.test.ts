import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import herdrExtension from "./index";

const currentPane = {
	pane_id: "w1:p1",
	terminal_id: "term_current",
	workspace_id: "w1",
	tab_id: "w1:t1",
	focused: false,
	cwd: "/repo",
	agent: "pi",
	agent_status: "working",
	revision: 1,
};

function response(result: unknown) {
	return { stdout: JSON.stringify({ id: "test", result }), stderr: "", code: 0, killed: false };
}

function registerTool(handler: (args: string[]) => unknown) {
	let tool: any;
	const pi = {
		on() {},
		registerTool(definition: unknown) {
			tool = definition;
		},
		async exec(command: string, args: string[]) {
			expect(command).toBe("herdr");
			return response(handler(args));
		},
	};
	herdrExtension(pi as any);
	if (!tool) throw new Error("herdr tool was not registered");
	return tool;
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
	test("does not register outside Herdr", () => {
		delete process.env.HERDR_ENV;
		let registered = false;
		herdrExtension({ registerTool: () => { registered = true; } } as any);
		expect(registered).toBeFalse();
	});

	test("resolves the caller pane through pane current", async () => {
		const calls: string[][] = [];
		const tool = registerTool((args) => {
			calls.push(args);
			return { type: "pane_current", pane: currentPane };
		});

		const result = await tool.execute("test", { action: "current" }, undefined, undefined, {});

		expect(calls).toEqual([["pane", "current", "--current"]]);
		expect(result.details.pane.pane_id).toBe(currentPane.pane_id);
	});

	test("chooses split direction from geometry and labels the pane", async () => {
		const calls: string[][] = [];
		const splitPane = { ...currentPane, pane_id: "w1:p2", terminal_id: "term_split", agent_status: "unknown" };
		const tool = registerTool((args) => {
			calls.push(args);
			if (args[0] === "pane" && args[1] === "current") return { type: "pane_current", pane: currentPane };
			if (args[0] === "pane" && args[1] === "get") return { type: "pane_info", pane: currentPane };
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
			if (args[0] === "pane" && args[1] === "rename") return { type: "pane_info", pane: { ...splitPane, label: "reviewer" } };
			throw new Error(`unexpected command: ${args.join(" ")}`);
		});

		const result = await tool.execute(
			"test",
			{ action: "pane_split", newPane: "reviewer" },
			undefined,
			undefined,
			{},
		);

		expect(calls).toContainEqual(["pane", "layout", "--pane", "w1:p1"]);
		expect(calls).toContainEqual(["pane", "split", "w1:p1", "--direction", "right", "--no-focus"]);
		expect(calls).toContainEqual(["pane", "rename", "w1:p2", "reviewer"]);
		expect(result.details.newPaneId).toBe("w1:p2");
	});

	test("focuses the exact pane through agent focus", async () => {
		const calls: string[][] = [];
		const tool = registerTool((args) => {
			calls.push(args);
			if (args[1] === "current") return { type: "pane_current", pane: currentPane };
			if (args[1] === "get") return { type: "pane_info", pane: currentPane };
			if (args[0] === "agent" && args[1] === "focus") {
				return { type: "agent_info", agent: { ...currentPane, name: "main", terminal_id: "term_current" } };
			}
			throw new Error(`unexpected command: ${args.join(" ")}`);
		});

		await tool.execute("test", { action: "focus", pane: "w1:p1" }, undefined, undefined, {});

		expect(calls).toContainEqual(["agent", "focus", "w1:p1"]);
	});

	test("keeps aliases usable across workspaces", async () => {
		const calls: string[][] = [];
		const remotePane = {
			...currentPane,
			pane_id: "w2:p1",
			terminal_id: "term_remote",
			workspace_id: "w2",
			tab_id: "w2:t1",
			agent_status: "idle",
		};
		const remoteWorkspace = {
			workspace_id: "w2",
			number: 2,
			label: "remote",
			focused: false,
			pane_count: 1,
			tab_count: 1,
			active_tab_id: "w2:t1",
			agent_status: "idle",
		};
		const tool = registerTool((args) => {
			calls.push(args);
			if (args[0] === "pane" && args[1] === "current") return { type: "pane_current", pane: currentPane };
			if (args[0] === "workspace" && args[1] === "create") {
				return { type: "workspace_created", workspace: remoteWorkspace, root_pane: remotePane };
			}
			if (args[0] === "pane" && args[1] === "get") return { type: "pane_info", pane: remotePane };
			if (args[0] === "agent" && args[1] === "focus") {
				return { type: "agent_info", agent: { ...remotePane, name: "remote" } };
			}
			throw new Error(`unexpected command: ${args.join(" ")}`);
		});

		await tool.execute(
			"create",
			{ action: "workspace_create", label: "remote", pane: "remote" },
			undefined,
			undefined,
			{},
		);
		await tool.execute("focus", { action: "focus", pane: "remote" }, undefined, undefined, {});

		expect(calls).toContainEqual(["pane", "get", "w2:p1"]);
		expect(calls).toContainEqual(["agent", "focus", "w2:p1"]);
	});
});
