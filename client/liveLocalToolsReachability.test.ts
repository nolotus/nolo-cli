import { describe, expect, it } from "bun:test";
import {
  runLocalAgentTurn,
  type AgentRuntimeHostAdapter,
  type AgentRuntimeToolCallInput,
} from "../agent-runtime";

function buildTestAdapter(options: {
  agentKey?: string;
  executeTool?: AgentRuntimeHostAdapter["executeTool"];
  host?: "cli" | "desktop";
} = {}) {
  const agentKey = options.agentKey ?? "agent-pub-test";
  const executedCalls: Array<{ call: AgentRuntimeToolCallInput; opts?: any }> = [];
  const adapter: AgentRuntimeHostAdapter = {
    host: (options.host ?? "cli") as any,
    capabilities: ["local-tools", "local-provider"],
    loadAgentConfig: async (ref: string) => ({
      key: ref,
      name: "Test Agent",
      model: "test-model",
      provider: "test-provider",
      toolNames: ["execShell", "startAgentRun", "controlAgentRun"],
    }),
    loadDialogHistory: async () => [],
    saveTurn: async () => ({ dialogId: "dialog-test-123" }),
    resolveProvider: async () => ({
      model: "test-model",
      complete: async () => ({
        content: "Turn completed successfully",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    }),
    executeTool: options.executeTool ?? (async (call, opts) => {
      executedCalls.push({ call, opts });
      if (call.name === "startAgentRun") {
        return {
          content: JSON.stringify({ runId: "child-run-1", status: "running" }),
        };
      }
      if (call.name === "controlAgentRun") {
        return {
          content: JSON.stringify({ runId: "child-run-1", status: "done", exitCode: 0 }),
        };
      }
      return { content: JSON.stringify({ status: "ok" }) };
    }),
  };
  return { adapter, executedCalls, agentKey };
}

describe("Live Local Tools Reachability (runLocalAgentTurn CapabilitySdk wiring)", () => {
  it("runs end-to-end subprocess probe (live reachability, workspace parity, abort & destructive guard)", () => {
    const proc = Bun.spawnSync(["bun", "packages/cli/client/liveLocalToolsReachability.subprocessProbe.ts"], {
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
    });
    expect(proc.exitCode).toBe(0);
  });

  it("A: live turn reachability — runLocalAgentTurn execution scope constructs and provides live tools", async () => {
    const { adapter, executedCalls } = buildTestAdapter();
    let programExecuted = false;

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "agent-pub-test",
      input: "hello reachability",
      __testProgram: async (tools) => {
        programExecuted = true;
        expect(typeof tools.execShell).toBe("function");
        expect(typeof tools.agents.run).toBe("function");

        const agentRes = await tools.agents.run({
          agentId: "agent-pub-child",
          task: "Run child task from live turn",
        });
        expect(agentRes.runId).toBe("child-run-1");
      },
    });

    expect(programExecuted).toBe(true);
    expect(result.dialogId).toBe("dialog-test-123");
    expect(executedCalls.length).toBeGreaterThanOrEqual(1);
    expect(executedCalls[0].call.name).toBe("startAgentRun");
  });

  it("B: workspace parity — program tools context inherits turn workspaceRoot", async () => {
    const { adapter } = buildTestAdapter();
    const customRoot = "/custom/test/workspace/root";

    let escapeBlocked = false;
    await runLocalAgentTurn({
      adapter,
      agentRef: "agent-pub-test",
      input: "test workspace parity",
      runtimeContext: {
        workspaceRoot: customRoot,
        restrictToWorkspace: true,
      },
      __testProgram: async (tools) => {
        const res = await tools.execShell({ command: "cat /etc/passwd" });
        if (res.metadata?.blockedToken === "workspace_shell_escape_blocked" || String(res.content).includes("blocked")) {
          escapeBlocked = true;
        }
      },
    });

    expect(escapeBlocked).toBe(true);
  });

  it("C: agent host parity — program tools.agents.run routes through current adapter.executeTool", async () => {
    const { adapter, executedCalls } = buildTestAdapter();

    await runLocalAgentTurn({
      adapter,
      agentRef: "agent-pub-test",
      input: "test agent parity",
      __testProgram: async (tools) => {
        await tools.agents.run({
          agentId: "agent-pub-target",
          task: "execute target task",
        });
      },
    });

    const startRunCall = executedCalls.find((c) => c.call.name === "startAgentRun");
    expect(startRunCall).toBeDefined();
    const parsedArgs = JSON.parse(startRunCall!.call.arguments);
    expect(parsedArgs.agentKey).toBe("agent-pub-target");
    expect(parsedArgs.task).toBe("execute target task");
  });

  it("D: abort parity — current turn abortSignal propagates to tools.agents.run", async () => {
    const { adapter } = buildTestAdapter({
      executeTool: async (call, opts) => {
        if (opts?.abortSignal?.aborted) {
          throw new Error("aborted by signal");
        }
        if (call.name === "startAgentRun") {
          return { content: JSON.stringify({ runId: "child-run-abort", status: "running" }) };
        }
        return { content: "{}" };
      },
    });

    const controller = new AbortController();
    let agentRunAborted = false;

    try {
      await runLocalAgentTurn({
        adapter,
        agentRef: "agent-pub-test",
        input: "test abort",
        abortSignal: controller.signal,
        __testProgram: async (tools) => {
          controller.abort();
          try {
            await tools.agents.run({
              agentId: "agent-pub-x",
              task: "should abort",
              signal: controller.signal,
            });
          } catch {
            agentRunAborted = true;
          }
        },
      });
    } catch {
      // turn aborts as expected when abortSignal triggers
    }

    expect(agentRunAborted).toBe(true);
  });

  it("E: CLI + Desktop shared seam — runs identically across host types without per-host SDK wiring", async () => {
    const cliHost = buildTestAdapter({ host: "cli" });
    const desktopHost = buildTestAdapter({ host: "desktop" });

    let cliRan = false;
    let desktopRan = false;

    await runLocalAgentTurn({
      adapter: cliHost.adapter,
      agentRef: "agent-pub-test",
      input: "cli turn",
      __testProgram: async (tools) => {
        cliRan = typeof tools.execShell === "function" && typeof tools.agents.run === "function";
      },
    });

    await runLocalAgentTurn({
      adapter: desktopHost.adapter,
      agentRef: "agent-pub-test",
      input: "desktop turn",
      __testProgram: async (tools) => {
        desktopRan = typeof tools.execShell === "function" && typeof tools.agents.run === "function";
      },
    });

    expect(cliRan).toBe(true);
    expect(desktopRan).toBe(true);
  });

  it("F: regression — normal turn execution without __testProgram remains unchanged", async () => {
    const { adapter } = buildTestAdapter();
    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "agent-pub-test",
      input: "normal turn execution",
    });

    expect(result.dialogId).toBe("dialog-test-123");
    expect(result.content).toBe("Turn completed successfully");
  });
});
