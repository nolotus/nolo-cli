// packages/cli/client/hostToolAgentRunService.test.ts
//
// Integration tests proving `tools.agents.run()` can be backed by a host's
// existing tool-execution seam (`executeTool`), so CLI/Desktop/Server each
// inherit their own startAgentRun/controlAgentRun executor — without a
// per-host AgentRunService.
//
// A  real CLI local executor as the bridge backend (start + wait full chain)
// B  parentDialogId / persistence / authority inherited through the same seam
// C  no recursion: calling agents.run does not re-enter the SDK
// D  server executeToolOnServer can be wrapped by a thin adapter (same bridge)
// E  abort → controlAgentRun(stop) real cancel
// H  Promise.all true concurrency

import { describe, expect, it, beforeEach } from "bun:test";
import type { FsLike, SpawnLike } from "../agentRunControl";
import { createHostToolAgentRunService, createCapabilitySdk } from "../agent-runtime";
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
  deps.mem.files.set(`${RUNS_DIR}/${runId}.log`, "done line\n");
}

function buildCliHostExecuteTool(deps: ReturnType<typeof buildDeps>) {
  const startExec = createCliStartAgentRunExecutor(deps);
  const controlExec = createCliControlAgentRunExecutor(deps);
  return async (call: { name: string; arguments: string }) => {
    const executor = call.name === "startAgentRun" ? startExec : controlExec;
    const res = await executor({ arguments: call.arguments });
    if (call.name === "startAgentRun") {
      markRunDone(deps, JSON.parse(res.content).runId);
    }
    return res;
  };
}

describe("createHostToolAgentRunService → tools.agents.run (host executeTool seam)", () => {
  let deps: ReturnType<typeof buildDeps>;

  beforeEach(() => {
    deps = buildDeps();
  });

  it("A: real CLI local executor backs the bridge — start + wait full chain", async () => {
    const hostExecuteTool = buildCliHostExecuteTool(deps);
    const service = createHostToolAgentRunService(hostExecuteTool);
    const sdk = createCapabilitySdk({
      context: { agentRunService: service },
    });

    const res = await sdk.agents.run({
      agentKey: "agent-pub-x",
      task: "查一下资料",
    });

    expect(res).toMatchObject({
      runId: RUN_ID,
      status: "completed",
    });
    const record = JSON.parse(deps.mem.files.get(`${RUNS_DIR}/${RUN_ID}.json`)!);
    expect(record.agentKey).toBe("agent-pub-x");
    expect(record.status).toBe("done");
  });

  it("B: parentDialogId is forwarded + persistence goes through the same seam", async () => {
    let seen: Record<string, unknown> | undefined;
    const hostExecuteTool = async (call: { name: string; arguments: string }) => {
      if (call.name === "startAgentRun") seen = JSON.parse(call.arguments);
      const executor =
        call.name === "startAgentRun"
          ? createCliStartAgentRunExecutor(deps)
          : createCliControlAgentRunExecutor(deps);
      const res = await executor({ arguments: call.arguments });
      if (call.name === "startAgentRun") markRunDone(deps, JSON.parse(res.content).runId);
      return res;
    };
    const service = createHostToolAgentRunService(hostExecuteTool);

    await service.start(
      { agentKey: "agent-pub-x", task: "t", parentDialogId: "dialog-parent" },
      {},
    );
    expect(seen?.parentDialogId).toBe("dialog-parent");
    expect(deps.mem.files.has(`${RUNS_DIR}/${RUN_ID}.json`)).toBe(true);
  });

  it("C: no recursion — agents.run drives executeTool a bounded number of times", async () => {
    const hostExecuteTool = buildCliHostExecuteTool(deps);
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const countingTool = async (call: { name: string; arguments: string }) => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        return await hostExecuteTool(call);
      } finally {
        active--;
      }
    };
    const service = createHostToolAgentRunService(countingTool);
    const sdk = createCapabilitySdk({ context: { agentRunService: service } });

    const res = await sdk.agents.run({ agentKey: "agent-pub-x", task: "t" });

    expect(calls).toBe(2);
    expect(maxActive).toBeLessThanOrEqual(1);
    expect(res.status).toBe("completed");
  });

  it("D: server executeToolOnServer can be wrapped by a thin adapter (same bridge)", async () => {
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    const executeToolOnServer = async (toolCall: {
      function: { name: string; arguments: string };
    }): Promise<string> => {
      const name = toolCall.function.name.replace(/^functions\./, "").trim();
      const args = JSON.parse(toolCall.function.arguments || "{}");
      seen.push({ name, args });
      if (name === "startAgentRun") return JSON.stringify({ runId: "run-srv", status: "running", batchId: "b" });
      if (name === "controlAgentRun" && args.action === "wait")
        return JSON.stringify({ runId: "run-srv", status: "done", content: "完成" });
      return JSON.stringify({});
    };
    const serverHostExecuteTool = async (call: { name: string; arguments: string }) => ({
      content: await executeToolOnServer({ function: { name: call.name, arguments: call.arguments } }),
    });

    const service = createHostToolAgentRunService(serverHostExecuteTool);
    const sdk = createCapabilitySdk({ context: { agentRunService: service } });

    const res = await sdk.agents.run({ agentKey: "agent-pub-x", task: "t" });

    expect(res.status).toBe("completed");
    expect(seen.some((c) => c.name === "startAgentRun")).toBe(true);
    expect(seen.some((c) => c.name === "controlAgentRun" && c.args.action === "wait")).toBe(true);
  });

  it("E: abort → controlAgentRun(stop) real cancel via the host seam", async () => {
    const seenStops: Array<{ runId: string }> = [];
    const startExec = createCliStartAgentRunExecutor(deps);
    const controlExec = createCliControlAgentRunExecutor(deps);
    const hostExecuteTool = async (
      call: { name: string; arguments: string },
      opts?: { abortSignal?: AbortSignal },
    ) => {
      if (call.name === "startAgentRun") return startExec({ arguments: call.arguments });
      const args = JSON.parse(call.arguments);
      if (args.action === "stop") seenStops.push({ runId: args.runId });
      return controlExec({ arguments: call.arguments }, opts);
    };
    const service = createHostToolAgentRunService(hostExecuteTool);
    const sdk = createCapabilitySdk({ context: { agentRunService: service } });

    const controller = new AbortController();
    const runPromise = sdk.agents.run({
      agentKey: "agent-pub-x",
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

  it("H: Promise.all runs run concurrently through the same seam", async () => {
    const hostExecuteTool = buildCliHostExecuteTool(deps);
    const service = createHostToolAgentRunService(hostExecuteTool);
    const sdk = createCapabilitySdk({ context: { agentRunService: service } });

    const results = await Promise.all([
      sdk.agents.run({ agentKey: "agent-pub-x", task: "a" }),
      sdk.agents.run({ agentKey: "agent-pub-x", task: "b" }),
    ]);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.status)).toEqual(["completed", "completed"]);
  });

  it("I: host { error } content (authority/policy denial) propagates as a rejection", async () => {
    const hostExecuteTool = async (call: { name: string; arguments: string }) => {
      if (call.name === "startAgentRun") {
        return {
          content: JSON.stringify({
            error: "startAgentRun: agentKey is not allowed by parent runtimeContext.allowedChildAgentKeys",
          }),
        };
      }
      const args = JSON.parse(call.arguments);
      if (args.action === "wait") {
        return { content: JSON.stringify({ runId: "run-1", status: "done" }) };
      }
      return { content: JSON.stringify({}) };
    };
    const service = createHostToolAgentRunService(hostExecuteTool);
    const sdk = createCapabilitySdk({ context: { agentRunService: service } });

    let sdkError: string | undefined;
    try {
      await sdk.agents.run({ agentKey: "agent-pub-x", task: "t" });
    } catch (e: any) {
      sdkError = e?.message;
    }
    expect(sdkError).toBeTruthy();
    expect(sdkError).toContain("not allowed");
  });
});
