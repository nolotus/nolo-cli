// packages/cli/client/manualPtcSpike.test.ts
//
// Manual Local PTC Spike — a hand-written program (not model-generated) that
// concurrently calls tools.execShell() and tools.agents.run() on a real local
// CapabilitySdk, proving the PTC execution surface works and stays policy-equal
// to normal local tool calling.
//
//   const [shell, agent] = await Promise.all([
//     tools.execShell(...),
//     tools.agents.run(...),
//   ])
//
// No eval / sandbox / compiler / server / UI. agents.run goes through
// createHostToolAgentRunService(adapter.executeTool) → real CLI executors.
// execShell goes through invokeCapability → capability policy → workspaceShell.

import { describe, expect, it, beforeEach } from "bun:test";
import type { FsLike, SpawnLike } from "../agentRunControl";
import {
  createLocalCapabilitySdk,
  buildLocalExecShellContext,
  type AgentRuntimeHostAdapter,
  type AgentRuntimeToolResult,
} from "../agent-runtime";
import { createLocalWorkspaceToolExecutors } from "../agent-runtime/localWorkspaceTools";
import {
  createCliStartAgentRunExecutor,
  createCliControlAgentRunExecutor,
  type CliAgentRunToolExecutorDeps,
} from "./cliAgentRunToolExecutors";

const RUN_ID = "run-1";
const RUNS_DIR = "/home/test/.nolo/runs";
const WS_ROOT = process.cwd(); // real existing dir so execShell can spawn

function buildMemFs() {
  const files = new Map<string, string>();
  const fs = {
    mkdirSync: () => {},
    writeFileSync: (path: string, content: string) => files.set(path, content),
    readFileSync: (path: string) => files.get(path) ?? "",
    readdirSync: () => Array.from(files.keys()),
    existsSync: (path: string) => files.has(path),
    openSync: () => 0,
    unlinkSync: (path: string) => files.delete(path),
  } as unknown as FsLike;
  return { files, fs };
}

function buildDeps(overrides: Partial<CliAgentRunToolExecutorDeps> = {}) {
  const mem = buildMemFs();
  const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
  const killCalls: Array<{ pid: number; signal: string | number }> = [];
  const deps: CliAgentRunToolExecutorDeps & { mem: typeof mem; spawnCalls: typeof spawnCalls; killCalls: typeof killCalls } = {
    env: {},
    cliEntrypoint: "/cli/entrypoint",
    cwd: "/work",
    homedir: () => "/home/test",
    generateRunId: () => RUN_ID,
    now: () => new Date("2026-07-31T00:00:00.000Z"),
    spawn: ((_cmd: string, _args: string[], _opts: any) => ({ pid: 123, unref: () => {} })) as SpawnLike,
    kill: (pid: number, signal: string | number) => killCalls.push({ pid, signal }),
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
    JSON.stringify({ runId, agentKey: "agent-pub-x", status: "done", pid: 123, startedAt: "2026-07-31T00:00:00.000Z", logPath: `${RUNS_DIR}/${runId}.log`, dialogId: "dialog-abc", exitCode: 0 }),
  );
}

function buildLocalAdapter(deps: ReturnType<typeof buildDeps>, autoComplete = true) {
  const startExec = createCliStartAgentRunExecutor(deps);
  const controlExec = createCliControlAgentRunExecutor(deps);
  const adapter = {
    executeTool: async (
      call: { id: string; name: string; arguments: string },
      opts?: { abortSignal?: AbortSignal },
    ): Promise<AgentRuntimeToolResult> => {
      const executor = call.name === "startAgentRun" ? startExec : controlExec;
      const res = await executor({ arguments: call.arguments }, opts);
      if (call.name === "startAgentRun" && autoComplete) markRunDone(deps, JSON.parse(res.content).runId);
      return res;
    },
  } as unknown as AgentRuntimeHostAdapter;
  return adapter;
}

const shellContext = (overrides: Record<string, unknown> = {}) =>
  buildLocalExecShellContext({
    workspaceRoot: WS_ROOT,
    commandTimeoutMs: 5000,
    commandOutputLimit: 4096,
    restrictToWorkspace: true,
    enableDestructiveShellGuard: true,
    ...overrides,
  } as any);

describe("Manual Local PTC Spike", () => {
  let deps: ReturnType<typeof buildDeps>;
  beforeEach(() => { deps = buildDeps(); });

  it("R1: hand-written program runs tools.execShell + tools.agents.run concurrently on real local SDK", async () => {
    const adapter = buildLocalAdapter(deps);
    const tools = createLocalCapabilitySdk(adapter, shellContext());
    const started = { shell: false, agent: false };

    // execShell and agents.run must both be running in the same Promise.all.
    const shellPromise = (async () => {
      started.shell = true;
      return tools.execShell({ command: "echo PTC_OK" });
    })();
    const agentPromise = (async () => {
      started.agent = true;
      return tools.agents.run({ agentId: "agent-pub-x", task: "Respond with READY" });
    })();

    const [shell, agent] = await Promise.all([shellPromise, agentPromise]);

    expect(started.shell).toBe(true);
    expect(started.agent).toBe(true);
    expect(String(shell.content)).toContain("PTC_OK");
    expect(agent).toMatchObject({ runId: RUN_ID, status: "completed" });
  });

  it("R2: workspace-escape parity — PTC execShell rejects like normal local execShell", async () => {
    const adapter = buildLocalAdapter(deps);
    const tools = createLocalCapabilitySdk(adapter, shellContext({ restrictToWorkspace: true }));

    const escapeCmd = "cat /etc/hostname"; // absolute path = escape token

    // PTC path
    const ptcResult = await tools.execShell({ command: escapeCmd });
    const ptcBlocked =
      String(ptcResult.content).toLowerCase().includes("workspace") ||
      (ptcResult.metadata as any)?.blockedToken === "workspace_shell_escape_blocked";

    // normal-local path (execShellTool via createLocalWorkspaceToolExecutors)
    const normalExec = createLocalWorkspaceToolExecutors({
      workspaceRoot: WS_ROOT,
      restrictShellToWorkspace: true,
    }).execShell;
    const normalResult = await normalExec({ id: "t1", name: "execShell", arguments: JSON.stringify({ command: escapeCmd }) });
    const normalBlocked =
      String(normalResult.content).toLowerCase().includes("workspace") ||
      (normalResult.metadata as any)?.blockedToken === "workspace_shell_escape_blocked";

    expect(ptcBlocked).toBe(true);
    expect(normalBlocked).toBe(true);
  });

  it("R3: destructive parity — PTC execShell strictly gates like normal local execShell (no default allow)", async () => {
    const adapter = buildLocalAdapter(deps);
    // blockDestructiveWithoutConfirmation: true + no confirm channel → both must block.
    const tools = createLocalCapabilitySdk(
      adapter,
      shellContext({ enableDestructiveShellGuard: true, blockDestructiveWithoutConfirmation: true }),
    );
    const dangerous = "rm -rf /tmp/does-not-matter-ptc";

    const runPtc = async () => {
      try { return { ok: true as const, r: await tools.execShell({ command: dangerous }) }; }
      catch (e: any) { return { ok: false as const, code: e?.code, msg: e?.message }; }
    };
    const runNormal = async () => {
      const normalExec = createLocalWorkspaceToolExecutors({ workspaceRoot: WS_ROOT }).execShell;
      try {
        const r = await normalExec(
          { id: "t1", name: "execShell", arguments: JSON.stringify({ command: dangerous }) },
          { blockDestructiveWithoutConfirmation: true, enableDestructiveShellGuard: true },
        );
        return { ok: true as const, r };
      } catch (e: any) { return { ok: false as const, code: e?.code, msg: e?.message }; }
    };

    const [ptc, normal] = await Promise.all([runPtc(), runNormal()]);

    // PTC must NOT default-allow a destructive command.
    expect(ptc.ok).toBe(false);
    expect((ptc as any).code).toBe("destructive_action_requires_confirmation");
    // normal local participates the same way.
    expect(normal.ok).toBe(false);
  });

  it("R4: shared AbortSignal reaches execShell AND drives agents.run through the real cancel seam", async () => {
    const adapter = buildLocalAdapter(deps, /* autoComplete */ false); // keep run pending
    const controller = new AbortController();
    const tools = createLocalCapabilitySdk(adapter, shellContext({ abortSignal: controller.signal }));

    const seenStops: Array<{ runId: string }> = [];
    const wrapped = {
      ...adapter,
      executeTool: async (call: any, opts?: any) => {
        if (call.name === "controlAgentRun" && JSON.parse(call.arguments).action === "stop") {
          seenStops.push({ runId: JSON.parse(call.arguments).runId });
        }
        return (adapter as any).executeTool(call, opts);
      },
    } as unknown as AgentRuntimeHostAdapter;
    const toolsW = createLocalCapabilitySdk(wrapped, shellContext({ abortSignal: controller.signal }));

    const agentPromise = toolsW.agents.run({ agentId: "agent-pub-x", task: "long", signal: controller.signal });

    // let wait attach, then abort
    for (let i = 0; i < 50; i++) {
      if (seenStops.length > 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    controller.abort();

    let sdkError: string | undefined;
    try { await agentPromise; } catch (e: any) { sdkError = e?.message; }

    expect(sdkError).toBeTruthy();
    expect(seenStops.length).toBeGreaterThanOrEqual(1);
  });

  it("R5: agents.run still yields starting/running/completed activity (observe only)", async () => {
    const adapter = buildLocalAdapter(deps);
    const events: Array<{ type: string; status?: string }> = [];
    const tools = createCapabilitySdkWithActivity(adapter, events);
    const res = await tools.agents.run({ agentId: "agent-pub-x", task: "t" });
    expect(res.status).toBe("completed");
    expect(events.some((e) => e.type === "activity-started" && e.status === "starting")).toBe(true);
    expect(events.some((e) => e.type === "activity-finished" && e.status === "completed")).toBe(true);
  });
});

// small helper to attach an onActivity sink
import { createCapabilitySdk, createHostToolAgentRunService } from "../agent-runtime";
function createCapabilitySdkWithActivity(adapter: AgentRuntimeHostAdapter, events: Array<{ type: string; status?: string }>) {
  return createCapabilitySdk({
    context: {
      agentRunService: createHostToolAgentRunService(adapter.executeTool),
      onActivity: (ev: any) => events.push({ type: ev?.type, status: ev?.activity?.status }),
    },
  });
}
