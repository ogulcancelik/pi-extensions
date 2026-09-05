import { beforeAll, describe, expect, test } from "bun:test";
import { initTheme, type ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { SubagentPeekOverlay } from "./peek.js";

beforeAll(() => initTheme("dark", false));

function createTool(name: string, args: Record<string, unknown>): ToolExecutionComponent {
  return SubagentPeekOverlay.prototype["createToolComponent"].call(
    { cwd: process.cwd(), tui: { requestRender() {} } } as any,
    name,
    "call-1",
    args,
  );
}

function renderTool(component: ToolExecutionComponent): string {
  return stripVTControlCharacters(component.render(100).join("\n"));
}

describe("peek tool rendering", () => {
  test.each(["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"])(
    "passes an explicit built-in definition for %s",
    (name) => {
      const component = createTool(name, {});
      expect(component["toolDefinition"]?.name).toBe(name);
      expect(component["toolDefinition"]?.renderCall).toBeFunction();
      expect(component["toolDefinition"]?.renderResult).toBeFunction();
    },
  );

  test("read shows only its compact header instead of raw arguments and the full file", () => {
    const component = createTool("read", { path: "src/catalog.rs", offset: 100, limit: 45 });
    component.updateResult({
      content: [{ type: "text", text: Array.from({ length: 45 }, (_, i) => `file_line_${i + 1}`).join("\n") }],
      isError: false,
    });

    const text = renderTool(component);
    expect(text).toContain("src/catalog.rs");
    expect(text).not.toContain('"path":');
    expect(text).toContain("100-144");
    expect(text).not.toContain("file_line_");
  });

  test("bash output stays collapsed while streaming and after completion", () => {
    const component = createTool("bash", { command: "printf output" });
    const result = {
      content: [{ type: "text" as const, text: Array.from({ length: 30 }, (_, i) => `output_line_${i + 1}`).join("\n") }],
      isError: false,
    };

    for (const isPartial of [true, false]) {
      component.updateResult(result, isPartial);
      const text = renderTool(component);
      expect(text).toContain("printf output");
      expect(text).not.toContain('"command":');
      expect(text).not.toContain("output_line_1");
      expect(text).toContain("output_line_30");
      expect(text).toContain("25 earlier lines");
    }
  });
});
