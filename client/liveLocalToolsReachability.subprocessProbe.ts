import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runLocalAgentTurn,
  type AgentRuntimeHostAdapter,
  type AgentRuntimeToolCallInput,
} from "../agent-runtime";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertContains(value: string, expected: string, label: string) {
  assert(
    value.includes(expected),
    `${label} should contain ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`,
  );
}

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

async function run() {
  // 1. Live turn reachability — runLocalAgentTurn execution scope constructs and provides live tools
  {
    const { adapter, executedCalls } = buildTestAdapter();
    let programExecuted = false;

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "agent-pub-test",
      input: "hello reachability",
      __testProgram: async (tools) => {
        programExecuted = true;
        assert(typeof tools.execShell === "function", "tools.execShell should be a function");
        assert(typeof tools.agents.run === "function", "tools.agents.run should be a function");

        // Run real shell command on live turn SDK
        const shellRes = await tools.execShell({ command: "echo LIVE_SDK_OK" });
        assertContains(String(shellRes.content), "LIVE_SDK_OK", "shellRes.content");
        assert(shellRes.metadata?.exitCode === 0, "shellRes exitCode should be 0");

        // Run child agent through live turn SDK
        const agentRes = await tools.agents.run({
          agentId: "agent-pub-child",
          task: "Run child task from live turn",
        });
        assert(agentRes.runId === "child-run-1", "agentRes.runId should match");
      },
    });

    assert(programExecuted, "program should have executed");
    assert(result.dialogId === "dialog-test-123", "dialogId should match");
    assert(executedCalls.some((c) => c.call.name === "startAgentRun"), "startAgentRun should be called");
  }

  // 2. Workspace parity — program tools.execShell respects current turn workspaceRoot
  {
    const { adapter } = buildTestAdapter();
    const tempDir = mkdtempSync(join(tmpdir(), "nolo-reachability-ws-"));
    writeFileSync(join(tempDir, "marker.txt"), "live-workspace-parity-content");

    try {
      let readMarkerContent = "";
      await runLocalAgentTurn({
        adapter,
        agentRef: "agent-pub-test",
        input: "test workspace parity",
        runtimeContext: {
          workspaceRoot: tempDir,
        },
        __testProgram: async (tools) => {
          const res = await tools.execShell({ command: "cat marker.txt" });
          readMarkerContent = String(res.content);
        },
      });

      assertContains(readMarkerContent, "live-workspace-parity-content", "readMarkerContent");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // 3. Agent host parity — program tools.agents.run routes through current adapter.executeTool
  {
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
    assert(startRunCall !== undefined, "startAgentRun should have been called");
    const parsedArgs = JSON.parse(startRunCall!.call.arguments);
    assert(parsedArgs.agentKey === "agent-pub-target", "agentKey should match");
    assert(parsedArgs.task === "execute target task", "task should match");
  }

  // 4. Abort parity — current turn abortSignal propagates to both execShell and agents.run
  {
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
    let execShellAborted = false;
    let agentRunAborted = false;

    try {
      await runLocalAgentTurn({
        adapter,
        agentRef: "agent-pub-test",
        input: "test abort",
        abortSignal: controller.signal,
        __testProgram: async (tools) => {
          controller.abort();
          const shellRes = await tools.execShell({ command: "echo test" });
          if (shellRes.metadata?.aborted || String(shellRes.content).includes("aborted")) {
            execShellAborted = true;
          }

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

    assert(execShellAborted, "execShell should have observed abortSignal");
    assert(agentRunAborted, "agents.run should have observed abortSignal");
  }

  // 5. Destructive shell guard parity
  {
    const { adapter } = buildTestAdapter();
    let blockedErrorCaught = false;

    await runLocalAgentTurn({
      adapter,
      agentRef: "agent-pub-test",
      input: "test destructive guard",
      runtimeContext: {
        enableDestructiveShellGuard: true,
        blockDestructiveWithoutConfirmation: true,
      },
      __testProgram: async (tools) => {
        try {
          await tools.execShell({ command: "rm -rf /tmp/test-nonexistent" });
        } catch (e: any) {
          if (e?.code === "destructive_action_requires_confirmation") {
            blockedErrorCaught = true;
          }
        }
      },
    });

    assert(blockedErrorCaught, "destructive command should be blocked without confirmation");
  }

  console.log("liveLocalToolsReachability subprocess probe passed.");
}

await run();
