import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  AgentManager,
  getAgentDefinitionsDescription,
  type AgentInfo,
  type ThinkingLevel,
  writeFullToolOutput,
} from "./core.js";
import { SubagentPeekOverlay } from "./peek.js";

function textResult(text: string, details?: any) {
  return { content: [{ type: "text" as const, text }], details };
}

function boundedTextResult(text: string, details?: any) {
  const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!truncation.truncated) return textResult(text, details);
  const fullOutputPath = writeFullToolOutput(text);
  const notice = `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
  return textResult(truncation.content + notice, { ...details, fullOutputPath, truncated: true });
}

function cleanTarget(target: string): string {
  return target.trim().replace(/^\/+/, "");
}

function parseTargets(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((target) => cleanTarget(String(target))).filter(Boolean) : undefined;
}

function parentSessionId(ctx: any): string {
  const id = ctx?.sessionManager?.getSessionId?.();
  if (!id) throw new Error("The parent Pi session has no session id.");
  return String(id);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function runtimeLabel(info: AgentInfo): string {
  const start = info.startedAt || info.createdAt;
  const final = ["completed", "failed", "interrupted", "closed"].includes(info.status);
  const end = final ? (info.completedAt || info.closedAt || info.updatedAt || Date.now()) : Date.now();
  return formatDuration(end - start);
}

export default function (pi: ExtensionAPI) {
  let cachedSkills: Array<{ name: string; description: string; filePath: string }> = [];
  let cachedSkillsSignature = "";
  const manager = new AgentManager();

  const spawnAgentTool = {
    name: "spawn_agent",
    label: "Spawn Agent",
    get description() {
      return `Spawn a fresh-context Pi subagent for a concrete task. Automatic extension, skill, and prompt-template discovery is disabled. Agent templates may explicitly configure a provider/model pair, thinking level, tools, skills, and extensions. Omitted template settings inherit from the parent where applicable.

Returns after the child accepts its initial task. Use \`wait_agent\` or \`wait_all_agents\` when you need the final response before continuing.

\`agent_type\` is optional. Omit it for a generic subagent. Use a template only when the task matches it.

Available agent templates:
${getAgentDefinitionsDescription()}

Available parent skills that may be added by name:
${cachedSkills.length ? cachedSkills.map((skill) => `- \`${skill.name}\` — ${skill.description}`).join("\n") : "No model-invocable skills are loaded in the parent session."}`;
    },
    parameters: Type.Object({
      task_name: Type.String({ description: "Task name for the new agent. Use letters, digits, underscores, dashes, and optional slash path separators." }),
      message: Type.String({ description: "Initial task for the new agent." }),
      agent_type: Type.Optional(Type.String({ description: "Optional agent template name from ~/.pi/agent/pi-codex-subagents/agents/." })),
      skills: Type.Optional(Type.Array(Type.String(), { description: "Additional skill names from the loaded parent skills listed in this tool description." })),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const currentModel = ctx.model;
      if (!currentModel?.provider || !currentModel?.id) throw new Error("spawn_agent failed: the parent has no active provider/model pair.");
      const requestedSkills: string[] = params.skills ?? [];
      const loadedSkillPaths = Object.fromEntries(cachedSkills.map((skill) => [skill.name, skill.filePath]));
      const unavailableSkills = requestedSkills.filter((skill) => !Object.hasOwn(loadedSkillPaths, skill));
      if (unavailableSkills.length) throw new Error(`spawn_agent failed: skills are not loaded in the parent session: ${unavailableSkills.join(", ")}`);
      try {
        const result = await manager.spawnAgent({
          task_name: params.task_name,
          message: params.message,
          agent_type: params.agent_type,
          skills: requestedSkills,
          loadedSkillPaths,
          cwd: ctx.cwd,
          parentSessionId: parentSessionId(ctx),
          parentSessionFile: ctx.sessionManager.getSessionFile?.(),
          inheritedProvider: currentModel.provider,
          inheritedModelId: currentModel.id,
          inheritedThinking: pi.getThinkingLevel() as ThinkingLevel,
          inheritedTools: pi.getActiveTools().join(","),
        });
        return textResult(`Spawned ${result.task_name}.`, result);
      } catch (error) {
        throw new Error(`spawn_agent failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    renderCall(args: any, theme: Theme) {
      return new Text(theme.fg("toolTitle", theme.bold("spawn_agent ")) + theme.fg("accent", args.task_name || "?") + theme.fg("dim", args.agent_type ? ` [${args.agent_type}]` : ""), 0, 0);
    },
    renderResult(result: any, _options: any, theme: Theme) {
      if (result.isError) return new Text(theme.fg("error", `✗ ${result.content?.[0]?.text || "failed"}`), 0, 0);
      return new Text(theme.fg("success", `✓ ${result.details?.task_name || "spawned"}`), 0, 0);
    },
  };

  pi.on("before_agent_start", async (event: any) => {
    const skills = event?.systemPromptOptions?.skills;
    const nextSkills = Array.isArray(skills)
      ? skills
          .filter((skill: any) => !skill?.disableModelInvocation && typeof skill?.name === "string" && typeof skill?.filePath === "string")
          .map((skill: any) => ({ name: skill.name, description: String(skill.description || ""), filePath: skill.filePath }))
      : [];
    const signature = JSON.stringify(nextSkills);
    if (signature !== cachedSkillsSignature) {
      cachedSkills = nextSkills;
      cachedSkillsSignature = signature;
      pi.registerTool(spawnAgentTool);
    }
  });

  pi.on("session_shutdown", async () => {
    await manager.shutdown();
  });

  pi.registerTool(spawnAgentTool);

  pi.registerTool({
    name: "wait_agent",
    label: "Wait Agent",
    description: "Wait for one session-owned agent completion, or for the next completion if targets is omitted. Returns one final response. Use wait_all_agents when every target must finish.",
    parameters: Type.Object({
      targets: Type.Optional(Type.Array(Type.String(), { description: "Agent task names to wait on. Omit to wait for the next completion in this parent session." })),
    }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      try {
        const result = await manager.waitAgent(parentSessionId(ctx), parseTargets(params.targets), signal);
        return boundedTextResult(JSON.stringify(result, null, 2), { message: result.message });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(`wait_agent failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    renderCall(args: any, theme: Theme) {
      const targets = Array.isArray(args.targets) && args.targets.length ? args.targets.join(",") : "any";
      return new Text(theme.fg("toolTitle", theme.bold("wait_agent ")) + theme.fg("accent", targets), 0, 0);
    },
    renderResult(result: any, _options: any, theme: Theme) {
      if (result.isError) return new Text(theme.fg("error", "✗ wait failed"), 0, 0);
      return new Text(theme.fg("success", result.details?.message || "done"), 0, 0);
    },
  });

  pi.registerTool({
    name: "wait_all_agents",
    label: "Wait All Agents",
    description: "Wait until all targeted session-owned agents reach a final status. Returns their final text responses.",
    parameters: Type.Object({
      targets: Type.Optional(Type.Array(Type.String(), { description: "Agent task names to wait for. Omit to wait for agents spawned by this extension instance." })),
    }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      try {
        const result = await manager.waitAllAgents(parentSessionId(ctx), parseTargets(params.targets), signal);
        return boundedTextResult(JSON.stringify(result, null, 2), { message: result.message });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(`wait_all_agents failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    renderCall(args: any, theme: Theme) {
      const targets = Array.isArray(args.targets) && args.targets.length ? args.targets.join(",") : "all";
      return new Text(theme.fg("toolTitle", theme.bold("wait_all_agents ")) + theme.fg("accent", targets), 0, 0);
    },
    renderResult(result: any, _options: any, theme: Theme) {
      if (result.isError) return new Text(theme.fg("error", "✗ wait failed"), 0, 0);
      return new Text(theme.fg("success", result.details?.message || "done"), 0, 0);
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description: "List agents owned by the current parent session. Set include_all only for an explicit read-only historical listing across parent sessions.",
    parameters: Type.Object({
      path_prefix: Type.Optional(Type.String({ description: "Task-path prefix filter without a trailing slash." })),
      include_all: Type.Optional(Type.Boolean({ description: "Include agents from all parent sessions and show parent_session_id. Default false." })),
    }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const agents = manager.listAgents(params.path_prefix, parentSessionId(ctx), params.include_all === true);
      return boundedTextResult(JSON.stringify({ agents }, null, 2), { agents });
    },
    renderCall(_args: any, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("list_agents")), 0, 0); },
    renderResult(result: any, options: any, theme: Theme) {
      const agents = result.details?.agents || [];
      if (!options.expanded) return new Text(theme.fg("success", `✓ ${agents.length} agent${agents.length === 1 ? "" : "s"}`), 0, 0);
      return new Text(result.content?.[0]?.text || JSON.stringify({ agents }, null, 2), 0, 0);
    },
  });

  pi.registerTool({
    name: "read_agent_response",
    label: "Read Agent Response",
    description: "Read one current-session agent's latest final raw text response. Tool calls and intermediate assistant text are excluded.",
    parameters: Type.Object({ target: Type.String({ description: "Session-owned agent task name." }) }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      try {
        const result = manager.readAgentResponse(cleanTarget(params.target), parentSessionId(ctx));
        return boundedTextResult(JSON.stringify(result, null, 2), { agent_name: result.agent_name, status: result.status });
      } catch (error) {
        throw new Error(`read_agent_response failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    renderCall(args: any, theme: Theme) {
      return new Text(theme.fg("toolTitle", theme.bold("read_agent_response ")) + theme.fg("accent", args.target || "?"), 0, 0);
    },
    renderResult(result: any, _options: any, theme: Theme) {
      if (result.isError) return new Text(theme.fg("error", "✗ read failed"), 0, 0);
      return new Text(theme.fg("success", `✓ ${result.details?.agent_name || "response"}`), 0, 0);
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description: "Send a message to a session-owned agent. Steers the current run when active; otherwise starts a new turn. Closed agents cannot be resumed.",
    parameters: Type.Object({
      target: Type.String({ description: "Session-owned agent task name." }),
      message: Type.String({ description: "Message text to send." }),
    }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      try {
        const result = await manager.sendMessage(parentSessionId(ctx), cleanTarget(params.target), params.message);
        return textResult(result.delivery === "steer" ? "Message steered into the running agent." : "Message started a new agent turn.", { target: params.target, ...result });
      } catch (error) {
        throw new Error(`send_message failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    renderCall(args: any, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("send_message ")) + theme.fg("accent", args.target || "?"), 0, 0); },
    renderResult(result: any, _options: any, theme: Theme) {
      if (result.isError) return new Text(theme.fg("error", "✗ send failed"), 0, 0);
      return new Text(theme.fg("success", result.details?.delivery === "steer" ? "✓ steered" : "✓ started"), 0, 0);
    },
  });

  pi.registerTool({
    name: "interrupt_agent",
    label: "Interrupt Agent",
    description: "Abort a session-owned agent's current turn while keeping its session available for later send_message calls.",
    parameters: Type.Object({ target: Type.String({ description: "Session-owned agent task name." }) }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      try {
        const result = await manager.interruptAgent(parentSessionId(ctx), cleanTarget(params.target));
        return textResult("Interrupt request handled.", result);
      } catch (error) {
        throw new Error(`interrupt_agent failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    renderCall(args: any, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("interrupt_agent ")) + theme.fg("accent", args.target || "?"), 0, 0); },
    renderResult(result: any, _options: any, theme: Theme) {
      if (result.isError) return new Text(theme.fg("error", "✗ interrupt failed"), 0, 0);
      return new Text(theme.fg("warning", `↯ previous: ${result.details?.previous_status || "unknown"}`), 0, 0);
    },
  });

  pi.registerTool({
    name: "close_agent",
    label: "Close Agent",
    description: "Permanently close a session-owned agent process. Its history remains readable, but it cannot receive more messages.",
    parameters: Type.Object({ target: Type.String({ description: "Session-owned agent task name." }) }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      try {
        const result = await manager.closeAgent(parentSessionId(ctx), cleanTarget(params.target));
        return textResult("Agent closed.", result);
      } catch (error) {
        throw new Error(`close_agent failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    renderCall(args: any, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("close_agent ")) + theme.fg("accent", args.target || "?"), 0, 0); },
    renderResult(result: any, _options: any, theme: Theme) {
      if (result.isError) return new Text(theme.fg("error", "✗ close failed"), 0, 0);
      return new Text(theme.fg("success", `✓ previous: ${result.details?.previous_status || "unknown"}`), 0, 0);
    },
  });

  async function openAgentOverlay(ctx: any, task: string, scopeId = parentSessionId(ctx), includeAll = false) {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Subagent overlays require interactive TUI mode.", "warning");
      return;
    }
    let info: AgentInfo;
    try { info = manager.getAgentInfo(task, scopeId); }
    catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); return; }

    while (true) {
      const navigation = await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: any) => new SubagentPeekOverlay(tui, theme, info, done), {
        overlay: true,
        overlayOptions: { anchor: "right-center", width: "45%", minWidth: 50, maxHeight: 60, margin: { right: 2, top: 2, bottom: 2 } },
      });
      if (navigation !== "previous" && navigation !== "next") return;

      const currentSessionId = parentSessionId(ctx);
      const entries = manager.listAgents(undefined, currentSessionId, includeAll);
      if (entries.length < 2) return;
      const currentIndex = entries.findIndex((entry) =>
        entry.agent_name === info.canonicalName &&
        (entry.parent_session_id || currentSessionId) === info.parentSessionId
      );
      if (currentIndex === -1) return;
      const offset = navigation === "next" ? 1 : -1;
      const next = entries[(currentIndex + offset + entries.length) % entries.length];
      info = manager.getAgentInfo(next.agent_name, next.parent_session_id || currentSessionId);
    }
  }

  async function pickAgent(ctx: any): Promise<{ task: string; parentSessionId: string; includeAll: boolean } | undefined> {
    const currentSessionId = parentSessionId(ctx);
    return await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: any) => {
      let selected = 0;
      let showAll = false;
      let cached: string[] | undefined;
      const fg = theme.fg.bind(theme);
      const pageSize = 10;
      const refresh = () => { cached = undefined; tui.requestRender(); };
      const agents = () => manager.listAgents(undefined, currentSessionId, showAll);
      return {
        render(width: number): string[] {
          if (cached) return cached;
          const entries = agents();
          if (selected >= entries.length) selected = Math.max(0, entries.length - 1);
          const scopeLabel = showAll ? "all sessions" : "this session";
          const lines = [fg("accent", "─".repeat(width)), fg("accent", theme.bold(" Subagents")) + fg("dim", ` (${entries.length}, ${scopeLabel})`), ""];
          if (!entries.length) lines.push(fg("dim", showAll ? "No subagents found." : "No subagents for this session. Press tab to show all."));
          const viewStart = entries.length > pageSize ? Math.max(0, Math.min(selected - Math.floor(pageSize / 2), entries.length - pageSize)) : 0;
          const viewEnd = Math.min(viewStart + pageSize, entries.length);
          if (viewStart > 0) lines.push(fg("dim", `  ↑ ${viewStart} more`));
          for (let index = viewStart; index < viewEnd; index++) {
            const entry = entries[index];
            const info = manager.getAgentInfo(entry.agent_name, entry.parent_session_id || currentSessionId);
            const pointer = index === selected ? fg("accent", "› ") : "  ";
            const name = truncateToWidth(entry.agent_name, 28).padEnd(28);
            const sessionId = entry.parent_session_id || "";
            const parent = showAll ? ` ${sessionId.slice(-8)}` : "";
            lines.push(pointer + fg(index === selected ? "accent" : "text", name) + " " + fg(entry.agent_status === "failed" ? "error" : entry.agent_status === "completed" ? "success" : "warning", entry.agent_status.padEnd(11)) + " " + fg("dim", `${runtimeLabel(info)}${parent}`));
            if (entry.last_task_message) lines.push("  " + fg("dim", truncateToWidth(entry.last_task_message.replace(/\s+/g, " "), Math.max(20, width - 4))));
          }
          if (viewEnd < entries.length) lines.push(fg("dim", `  ↓ ${entries.length - viewEnd} more`));
          lines.push("", fg("dim", "enter: open  tab: this/all sessions  r: refresh  q/esc: close"));
          cached = lines;
          return lines;
        },
        handleInput(data: string) {
          const entries = agents();
          if (matchesKey(data, "escape") || data === "q") { done(undefined); return; }
          if (matchesKey(data, "tab") || data === "\t") { showAll = !showAll; selected = 0; refresh(); return; }
          if (data === "r") { refresh(); return; }
          if (matchesKey(data, "down") || data === "j") { selected = Math.min(entries.length - 1, selected + 1); refresh(); return; }
          if (matchesKey(data, "up") || data === "k") { selected = Math.max(0, selected - 1); refresh(); return; }
          if (matchesKey(data, "return") && entries[selected]) {
            done({ task: entries[selected].agent_name, parentSessionId: entries[selected].parent_session_id || currentSessionId, includeAll: showAll });
          }
        },
        invalidate() { cached = undefined; },
      };
    });
  }

  pi.registerCommand("subagent", {
    description: "Browse subagents, or open one directly. Usage: /subagent [task-name]",
    handler: async (args, ctx) => {
      const task = args?.trim().replace(/^\//, "");
      if (task) { await openAgentOverlay(ctx, task); return; }
      const selected = await pickAgent(ctx);
      if (selected) await openAgentOverlay(ctx, selected.task, selected.parentSessionId, selected.includeAll);
    },
  });

  pi.registerCommand("agents", {
    description: "Browse subagents",
    handler: async (_args, ctx) => {
      const selected = await pickAgent(ctx);
      if (selected) await openAgentOverlay(ctx, selected.task, selected.parentSessionId, selected.includeAll);
    },
  });
}
