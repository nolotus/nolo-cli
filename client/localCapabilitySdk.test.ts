// packages/cli/client/localCapabilitySdk.test.ts
//
// Local Host Reachability — proves the shared `runLocalAgentTurn` loop scope
// (via createLocalCapabilitySdk) yields a real CapabilitySdk, and that
// tools.agents.run() goes through AgentRuntimeHostAdapter.executeTool → the
// host's real local startAgentRun / controlAgentRun executors.
//
// Covers: A real local agents.run integration, H Promise.all concurrency,
// E abort → adapter.executeTool(controlAgentRun stop) real cancel.

import { describe, expect, it, beforeEach } from "bun:test";
import type { FsLike, SpawnLike } from "../agentRunControl";
import {
  createLocalCapabilitySdk,
  buildLocalExecShellContext,
  type AgentRuntimeHostAdapter,
  type AgentRuntimeToolResult,
} from "../agent-runtime";
import {
  createCliStartAgentRunExecutor,
  createCliControlAgentRunExecutor,
  type CliAgentRunToolExecutorDeps,
} from "./cliAgentRunToolExecutors";

const RUN_ID = "run-1";
const RUNS_DIR = "/home/test/.nolo/runs";

function buildMemFs() {
  const files = new Map<string, string>();
  const fs = {
    mkdirSync: () => {},
    writeFileSync: (path: string, content: string) => {
      files.set(path, content);
    },
    readFileSync: (path: string) => files.get(path) ?? "",
    readdirSync: () => Array.from(files.keys()),
    existsSync: (path: string) => files.has(path),
    openSync: () => 0,
    unlinkSync: (path: string) => {
      files.delete(path);
    },
  } as unknown as FsLike;
  return { files, fs };
}

function buildDeps(overrides: Partial<CliAgentRunToolExecutorDeps> = {}) {
  const mem = buildMemFs();
  const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
  const killCalls: Array<{ pid: number; signal: string | number }> = [];
  const deps: CliAgentRunToolExecutorDeps & {
    mem: typeof mem;
    spawnCalls: typeof spawnCalls;
    killCalls: typeof killCalls;
  } = {
    env: {},
    cliEntrypoint: "/cli/entrypoint",
    cwd: "/work",
    homedir: () => "/home/test",
    generateRunId: () => RUN_ID,
    now: () => new Date("2026-07-31T00:00:00.000Z"),
    spawn: ((_cmd: string, _args: string[], _opts: any) => ({
      pid: 123,
      unref: () => {},
    })) as SpawnLike,
    kill: (pid: number, signal: string | number) => {
      killCalls.push({ pid, signal });
    },
    fs: mem.fs,
    mem,
    spawnCalls,
    killCalls,
    ...overrides,
  };
  return deps;
}

function markRunDone(deps: ReturnType<typeof buildDeps>, runId: string) {
  deps.mem.files.set(
    `${RUNS_DIR}/${runId}.json`,
    JSON.stringify({
      runId,
      agentKey: "agent-pub-x",
      status: "done",
      pid: 123,
      startedAt: "2026-07-31T00:00:00.000Z",
      logPath: `${RUNS_DIR}/${runId}.log`,
      dialogId: "dialog-abc",
      exitCode: 0,
    }),
  );
}

/** Build a real local AgentRuntimeHostAdapter whose executeTool dispatches to
 *  the real CLI local startAgentRun / controlAgentRun executors. After a
 *  startAgentRun it simulates the child finishing so wait resolves. */
function buildLocalAdapter(
  deps: ReturnType<typeof buildDeps>,
  autoComplete = true,
) {
  const startExec = createCliStartAgentRunExecutor(deps);
  const controlExec = createCliControlAgentRunExecutor(deps);
  const adapter = {
    executeTool: async (
      call: { id: string; name: string; arguments: string },
      opts?: { abortSignal?: AbortSignal },
    ): Promise<AgentRuntimeToolResult> => {
      const executor = call.name === "startAgentRun" ? startExec : controlExec;
      const res = await executor({ arguments: call.arguments }, opts);
      if (call.name === "startAgentRun" && autoComplete) {
        markRunDone(deps, JSON.parse(res.content).runId);
      }
      return res;
    },
  } as unknown as AgentRuntimeHostAdapter;
  return { adapter, startExec, controlExec };
}

describe("createLocalCapabilitySdk → tools (local execution scope)", () => {
  let deps: ReturnType<typeof buildDeps>;

  beforeEach(() => {
    deps = buildDeps();
  });

  it("A: builds a real CapabilitySdk; agents.run goes through adapter.executeTool → real CLI executors", async () => {
    const { adapter } = buildLocalAdapter(deps);
    const tools = createLocalCapabilitySdk(adapter, buildLocalExecShellContext({ workspaceRoot: process.cwd(), restrictToWorkspace: true, enableDestructiveShellGuard: true, blockDestructiveWithoutConfirmation: true }));

    const res = await tools.agents.run({ agentId: "agent-pub-x", task: "查资料" });

    expect(res).toMatchObject({ runId: RUN_ID, status: "completed" });
    // run record persisted via the real local path
    const record = JSON.parse(deps.mem.files.get(`${RUNS_DIR}/${RUN_ID}.json`)!);
    expect(record.agentKey).toBe("agent-pub-x");
    expect(record.status).toBe("done");
    // execShell is available on the same SDK
    expect(typeof tools.execShell).toBe("function");
  });

  it("H: Promise.all stays concurrent under the real local host bridge", async () => {
    const { adapter } = buildLocalAdapter(deps);
    const tools = createLocalCapabilitySdk(adapter, buildLocalExecShellContext({ workspaceRoot: process.cwd(), restrictToWorkspace: true, enableDestructiveShellGuard: true, blockDestructiveWithoutConfirmation: true }));

    const results = await Promise.all([
      tools.agents.run({ agentId: "agent-pub-x", task: "a" }),
      tools.agents.run({ agentId: "agent-pub-x", task: "b" }),
    ]);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.status)).toEqual(["completed", "completed"]);
  });

  it("E: AbortSignal → bridge cancel → adapter.executeTool(controlAgentRun stop) real cancel", async () => {
    const { adapter } = buildLocalAdapter(deps, /* autoComplete */ false);
    const seenStops: Array<{ runId: string }> = [];
    // wrap executeTool to record stop calls
    const wrappedAdapter = {
      ...adapter,
      executeTool: async (call: any, opts?: any) => {
        if (call.name === "controlAgentRun") {
          const args = JSON.parse(call.arguments);
          if (args.action === "stop") seenStops.push({ runId: args.runId });
        }
        return (adapter as any).executeTool(call, opts);
      },
    } as unknown as AgentRuntimeHostAdapter;
    const tools = createLocalCapabilitySdk(wrappedAdapter, buildLocalExecShellContext({ workspaceRoot: process.cwd(), restrictToWorkspace: true, enableDestructiveShellGuard: true, blockDestructiveWithoutConfirmation: true }));

    const controller = new AbortController();
    const runPromise = tools.agents.run({
      agentId: "agent-pub-x",
      task: "long task",
      signal: controller.signal,
    });

    for (let i = 0; i < 50; i++) {
      if (seenStops.length > 0) break;
      await new Promise((r) => setTimeout(r, 5));
      if (deps.mem.files.has(`${RUNS_DIR}/${RUN_ID}.json`)) {
        const rec = JSON.parse(deps.mem.files.get(`${RUNS_DIR}/${RUN_ID}.json`)!);
        if (rec.status === "done") break;
      }
    }
    controller.abort();

    let sdkError: string | undefined;
    try {
      await runPromise;
    } catch (e: any) {
      sdkError = e?.message;
    }
    expect(sdkError).toBeTruthy();
    expect(seenStops.length).toBeGreaterThanOrEqual(1);
  });
});
