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
    saveTurn: async () => ({ dialogId: "dialog-test-ptc-slice" }),
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
          content: JSON.stringify({ runId: "child-run-slice-1", status: "running" }),
        };
      }
      if (call.name === "controlAgentRun") {
        return {
          content: JSON.stringify({ runId: "child-run-slice-1", status: "done", exitCode: 0, content: "Child task completed" }),
        };
      }
      return { content: JSON.stringify({ status: "ok" }) };
    }),
  };
  return { adapter, executedCalls, agentKey };
}

async function run() {
  const wsRoot = process.cwd();

  // 1. Real Vertical Slice: runLocalAgentTurn → fail-closed PTC context → current-turn CapabilitySdk
  //    → QuickJS sandbox → tools.execShell / tools.agents.run RPC (Promise.all) → same CapabilitySdk
  {
    const { adapter, executedCalls } = buildTestAdapter();
    let ptcResult: any = null;
    const turnAbortController = new AbortController();

    const turnResult = await runLocalAgentTurn({
      adapter,
      agentRef: "agent-pub-test",
      input: "execute ptc vertical slice",
      abortSignal: turnAbortController.signal,
      runtimeContext: {
        workspaceRoot: wsRoot,
        restrictToWorkspace: true,
        enableDestructiveShellGuard: true,
      },
      __testPtcProgram: {
        code: `
          async function main(tools) {
            const [shellRes, agentRes] = await Promise.all([
              tools.execShell({ command: "echo REAL_LOCAL_PTC_SLICE_OK" }),
              tools.agents.run({
                agentId: "agent-pub-child",
                task: "Execute child task through QuickJS RPC"
              })
            ]);
            return {
              shellOutput: shellRes.content,
              shellExit: shellRes.metadata ? shellRes.metadata.exitCode : 0,
              agentRunId: agentRes.runId,
              agentStatus: agentRes.status,
              agentContent: agentRes.content
            };
          }
        `,
        onResult: (res) => {
          ptcResult = res;
        },
      },
    });

    assert(turnResult.dialogId === "dialog-test-ptc-slice", "dialogId matches");
    assert(ptcResult !== null, "ptcResult must be populated");
    assert(ptcResult.ok === true, `ptcResult failed: ${ptcResult.error}`);
    assertContains(String(ptcResult.result.shellOutput), "REAL_LOCAL_PTC_SLICE_OK", "shellOutput");
    assert(ptcResult.result.agentRunId === "child-run-slice-1", "agentRunId matches");
    assert(ptcResult.result.agentStatus === "completed", "agentStatus matches completed");
    assertContains(String(ptcResult.result.agentContent), "Child task completed", "agentContent");

    const startAgentCalls = executedCalls.filter((c) => c.call.name === "startAgentRun");
    assert(startAgentCalls.length === 1, "startAgentRun should be called exactly once");
    const controlAgentCalls = executedCalls.filter((c) => c.call.name === "controlAgentRun");
    assert(controlAgentCalls.length >= 1, "controlAgentRun should be called");
  }

  // 2. Real workspace containment parity through QuickJS sandbox
  {
    const { adapter } = buildTestAdapter();
    const tempDir = mkdtempSync(join(tmpdir(), "nolo-ptc-slice-ws-"));
    writeFileSync(join(tempDir, "sandbox-marker.txt"), "inside-slice-ws-content");

    try {
      let readInsideResult: any = null;
      let escapeResult: any = null;

      // 2a. Valid command within workspace
      await runLocalAgentTurn({
        adapter,
        agentRef: "agent-pub-test",
        input: "test workspace valid via QuickJS",
        abortSignal: new AbortController().signal,
        runtimeContext: {
          workspaceRoot: tempDir,
          restrictToWorkspace: true,
          enableDestructiveShellGuard: true,
        },
        __testPtcProgram: {
          code: `
            async function main(tools) {
              return await tools.execShell({ command: "cat sandbox-marker.txt" });
            }
          `,
          onResult: (res) => {
            readInsideResult = res;
          },
        },
      });

      // 2b. Escape attempt to outside path
      await runLocalAgentTurn({
        adapter,
        agentRef: "agent-pub-test",
        input: "test workspace escape via QuickJS",
        abortSignal: new AbortController().signal,
        runtimeContext: {
          workspaceRoot: tempDir,
          restrictToWorkspace: true,
          enableDestructiveShellGuard: true,
        },
        __testPtcProgram: {
          code: `
            async function main(tools) {
              return await tools.execShell({ command: "cat /etc/hostname" });
            }
          `,
          onResult: (res) => {
            escapeResult = res;
          },
        },
      });

      assert(readInsideResult?.ok === true, "inside read should succeed");
      assertContains(String(readInsideResult.result.content), "inside-slice-ws-content", "readInsideResult");

      assert(escapeResult?.ok === true, "escape result returned structured rejection");
      const blockedToken = escapeResult.result?.metadata?.blockedToken;
      const blockedContent = String(escapeResult.result?.content);
      assert(
        blockedToken === "workspace_shell_escape_blocked" || blockedContent.toLowerCase().includes("workspace"),
        "workspace escape must be blocked with policy parity",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // 3. Real destructive shell guard parity through QuickJS sandbox
  {
    const { adapter } = buildTestAdapter();
    let destructiveResult: any = null;

    await runLocalAgentTurn({
      adapter,
      agentRef: "agent-pub-test",
      input: "test destructive guard via QuickJS",
      abortSignal: new AbortController().signal,
      runtimeContext: {
        workspaceRoot: wsRoot,
        restrictToWorkspace: true,
        enableDestructiveShellGuard: true,
        blockDestructiveWithoutConfirmation: true,
      },
      __testPtcProgram: {
        code: `
          async function main(tools) {
            try {
              const res = await tools.execShell({ command: "rm -rf /tmp/dangerous-ptc-slice" });
              return { success: true, res };
            } catch (err) {
              return { success: false, error: err.message };
            }
          }
        `,
        onResult: (res) => {
          destructiveResult = res;
        },
      },
    });

    assert(destructiveResult?.ok === true, "destructive test should execute cleanly");
    assert(destructiveResult.result?.success === false, "destructive command must be blocked");
    assertContains(
      String(destructiveResult.result?.error).toLowerCase(),
      "destructive shell command blocked",
      "destructive error message",
    );
  }

  // 4. Real agent cancel seam through current turn abortSignal
  {
    const stopCalls: Array<{ call: AgentRuntimeToolCallInput; opts?: any }> = [];
    const turnAbortController = new AbortController();

    const { adapter } = buildTestAdapter({
      executeTool: async (call, opts) => {
        if (call.name === "startAgentRun") {
          return { content: JSON.stringify({ runId: "child-run-cancel-seam", status: "running" }) };
        }
        if (call.name === "controlAgentRun") {
          const args = JSON.parse(call.arguments);
          if (args.action === "stop") {
            stopCalls.push({ call, opts });
            return { content: JSON.stringify({ runId: "child-run-cancel-seam", status: "cancelled", wasActive: true }) };
          }
          if (args.action === "wait") {
            while (!opts?.abortSignal?.aborted && !turnAbortController.signal.aborted) {
              await new Promise((r) => setTimeout(r, 10));
            }
            if (opts?.abortSignal?.aborted || turnAbortController.signal.aborted) {
              return { content: JSON.stringify({ runId: "child-run-cancel-seam", status: "cancelled" }) };
            }
          }
        }
        return { content: "{}" };
      },
    });

    let cancelOutcome: any = null;
    let turnAbortedErrorCaught = false;

    try {
      const turnPromise = runLocalAgentTurn({
        adapter,
        agentRef: "agent-pub-test",
        input: "test cancel seam via QuickJS",
        abortSignal: turnAbortController.signal,
        runtimeContext: {
          workspaceRoot: wsRoot,
          restrictToWorkspace: true,
          enableDestructiveShellGuard: true,
        },
        __testPtcProgram: {
          code: `
            async function main(tools) {
              try {
                const res = await tools.agents.run({
                  agentId: "agent-pub-slow",
                  task: "Slow task that will be cancelled"
                });
                return { success: true, res };
              } catch (err) {
                return { success: false, error: err.message };
              }
            }
          `,
          onResult: (res) => {
            cancelOutcome = res;
          },
        },
      });

      // Abort after start
      await new Promise((r) => setTimeout(r, 50));
      turnAbortController.abort(new Error("Turn aborted by user"));

      await turnPromise;
    } catch (err: any) {
      if (err?.code === "LOCAL_TURN_ABORTED" || String(err?.message).includes("aborted")) {
        turnAbortedErrorCaught = true;
      }
    }

    assert(turnAbortedErrorCaught, "turn should abort cleanly with LOCAL_TURN_ABORTED");
    assert(stopCalls.length >= 1, "Host controlAgentRun action:stop must be called on abort (real cancel seam)");
    assert(cancelOutcome !== null, "QuickJS execution should settle upon abort");
  }

  console.log("realLocalPtcSlice subprocess probe passed.");
}

await run();
