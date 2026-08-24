import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

describe("Real Local PTC Vertical Slice", () => {
  const wsRoot = process.cwd();

  it("runs subprocess probe cleanly (clean-room isolation)", () => {
    const proc = Bun.spawnSync(["bun", "packages/cli/client/realLocalPtcSlice.subprocessProbe.ts"], {
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
    });
    expect(proc.exitCode).toBe(0);
  });

  it("1. Real Vertical Slice: runLocalAgentTurn → fail-closed PTC context → current-turn CapabilitySdk → QuickJS sandbox → tools.execShell / tools.agents.run RPC (Promise.all) → same CapabilitySdk", async () => {
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

    expect(turnResult.dialogId).toBe("dialog-test-ptc-slice");
    expect(ptcResult).not.toBeNull();
    expect(ptcResult.ok).toBe(true);
    expect(ptcResult.result.agentRunId).toBe("child-run-slice-1");
    expect(ptcResult.result.agentStatus).toBe("completed");
    expect(String(ptcResult.result.agentContent)).toContain("Child task completed");

    // Verify calls routed through adapter
    const startAgentCalls = executedCalls.filter((c) => c.call.name === "startAgentRun");
    expect(startAgentCalls.length).toBe(1);
    const controlAgentCalls = executedCalls.filter((c) => c.call.name === "controlAgentRun");
    expect(controlAgentCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("2. Real workspace containment parity through QuickJS sandbox", async () => {
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

      expect(readInsideResult?.ok).toBe(true);

      expect(escapeResult?.ok).toBe(true);
      const blockedToken = escapeResult.result?.metadata?.blockedToken;
      const blockedContent = String(escapeResult.result?.content);
      const isBlocked =
        blockedToken === "workspace_shell_escape_blocked" || blockedContent.toLowerCase().includes("workspace");
      expect(isBlocked).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("3. Real destructive shell guard parity through QuickJS sandbox", async () => {
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

    expect(destructiveResult?.ok).toBe(true);
    expect(destructiveResult.result?.success).toBe(false);
    expect(String(destructiveResult.result?.error).toLowerCase()).toContain("destructive shell command blocked");
  });

  it("4. Real agent cancel seam through current turn abortSignal", async () => {
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

      await new Promise((r) => setTimeout(r, 50));
      turnAbortController.abort(new Error("Turn aborted by user"));

      await turnPromise;
    } catch (err: any) {
      if (err?.code === "LOCAL_TURN_ABORTED" || String(err?.message).includes("aborted")) {
        turnAbortedErrorCaught = true;
      }
    }

    expect(turnAbortedErrorCaught).toBe(true);
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);
    expect(cancelOutcome).not.toBeNull();
  });
});
