import { describe, expect, it } from "bun:test";
import type { FsLike, SpawnLike } from "../agentRunControl";
import {
  createCliControlAgentRunExecutor,
  createCliStartAgentRunExecutor,
  type CliAgentRunToolExecutorDeps,
} from "./cliAgentRunToolExecutors";

const buildMemFs = () => {
  const files = new Map<string, string>();
  const fs = {
    mkdirSync: () => {},
    writeFileSync: (path: string, content: string) => {
      files.set(path, content);
    },
    readFileSync: (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("ENOENT");
      return value;
    },
    readdirSync: (path: string) =>
      [...files.keys()]
        .filter((key) => key.startsWith(`${path}/`))
        .map((key) => key.slice(path.length + 1)),
    existsSync: (path: string) => files.has(path),
    openSync: () => 1,
    unlinkSync: (path: string) => {
      files.delete(path);
    },
  } as unknown as FsLike;
  return { files, fs };
};

const buildDeps = (overrides: Partial<CliAgentRunToolExecutorDeps> = {}) => {
  const mem = buildMemFs();
  const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
  const killCalls: Array<{ pid: number; signal: string }> = [];
  const deps: CliAgentRunToolExecutorDeps & { mem: typeof mem; spawnCalls: typeof spawnCalls; killCalls: typeof killCalls } = {
    env: {},
    cliEntrypoint: "/cli/entrypoint",
    cwd: "/work",
    homedir: () => "/home/test",
    generateRunId: () => "run-1",
    now: () => new Date("2026-07-31T00:00:00.000Z"),
    spawn: ((cmd: string, args: string[], _opts: any) => {
      spawnCalls.push({ cmd, args });
      return { pid: 123, unref: () => {} };
    }) as SpawnLike,
    kill: (pid: number, signal: string) => {
      killCalls.push({ pid, signal });
    },
    fs: mem.fs,
    mem,
    spawnCalls,
    killCalls,
    ...overrides,
  };
  return deps;
};

describe("cli startAgentRun executor", () => {
  it("spawns a local --bg run and returns runId/status", async () => {
    const deps = buildDeps();
    const executor = createCliStartAgentRunExecutor(deps);
    const result = await executor({
      arguments: JSON.stringify({ agentKey: "agent-pub-x", task: "帮我查一下资料" }),
    });

    expect(JSON.parse(result.content)).toEqual({ runId: "run-1", status: "running" });
    expect(result.metadata?.displayData).toContain("runId   run-1");

    // 注册表记录已写入
    const record = JSON.parse(deps.mem.files.get("/home/test/.nolo/runs/run-1.json")!);
    expect(record.agentKey).toBe("agent-pub-x");
    expect(record.status).toBe("running");
    expect(record.pid).toBe(123);

    // 任务内容已快照到 runs 目录
    expect(deps.mem.files.get("/home/test/.nolo/runs/run-1.msg.md")).toBe("帮我查一下资料");

    // 子进程命令：entrypoint + agent run + --agent + --msg-file(快照)
    const spawnCall = deps.spawnCalls[0];
    expect(spawnCall.args).toContain("agent");
    expect(spawnCall.args).toContain("run");
    expect(spawnCall.args).toContain("--agent");
    expect(spawnCall.args).toContain("agent-pub-x");
    expect(spawnCall.args).toContain("--msg-file");
    // --bg 必须被剥离（子进程不能再次进入 --bg 分支）
    expect(spawnCall.args).not.toContain("--bg");
  });

  it("attaches structured input as an extra section in the task snapshot", async () => {
    const deps = buildDeps();
    const executor = createCliStartAgentRunExecutor(deps);
    await executor({
      arguments: JSON.stringify({
        agentKey: "agent-pub-x",
        task: "总结",
        input: { raw: "data", n: 1 },
      }),
    });
    const snapshot = deps.mem.files.get("/home/test/.nolo/runs/run-1.msg.md")!;
    expect(snapshot).toContain("总结");
    expect(snapshot).toContain("--- 附加输入 ---");
    expect(snapshot).toContain('"raw":"data"');
  });

  it("throws when agentKey/task missing", async () => {
    const deps = buildDeps();
    const executor = createCliStartAgentRunExecutor(deps);
    await expect(
      executor({ arguments: JSON.stringify({ agentKey: "" }) }),
    ).rejects.toThrow("agentKey");
    await expect(
      executor({ arguments: JSON.stringify({ task: "x" }) }),
    ).rejects.toThrow("agentKey");
    await expect(
      executor({ arguments: JSON.stringify({ agentKey: "a", task: "" }) }),
    ).rejects.toThrow("task");
  });
});

describe("cli controlAgentRun executor", () => {
  const seedRun = (deps: ReturnType<typeof buildDeps>, runId: string, extra: Record<string, unknown> = {}) => {
    const logPath = `/home/test/.nolo/runs/${runId}.log`;
    deps.mem.files.set(
      `/home/test/.nolo/runs/${runId}.json`,
      JSON.stringify({
        runId,
        agentKey: "agent-pub-x",
        status: "running",
        pid: 123,
        startedAt: "2026-07-31T00:00:00.000Z",
        logPath,
        ...extra,
      }),
    );
    deps.mem.files.set(logPath, "line1\nline2\nline3\n");
  };

  it("status returns run summary + optional log tail", async () => {
    const deps = buildDeps({ kill: () => {} });
    seedRun(deps, "run-1");
    const executor = createCliControlAgentRunExecutor(deps);

    const result = await executor({
      arguments: JSON.stringify({ action: "status", runId: "run-1", tailLines: 2 }),
    });
    const data = JSON.parse(result.content);
    expect(data.found).toBe(true);
    expect(data.runId).toBe("run-1");
    expect(data.status).toBe("running");
    expect(data.agentKey).toBe("agent-pub-x");
    expect(data.logTail).toBe("line2\nline3");
    expect(result.metadata?.displayData).toContain("⏳ running");
  });

  it("status without tailLines omits log tail", async () => {
    const deps = buildDeps({ kill: () => {} });
    seedRun(deps, "run-1");
    const executor = createCliControlAgentRunExecutor(deps);
    const result = await executor({
      arguments: JSON.stringify({ action: "status", runId: "run-1" }),
    });
    const data = JSON.parse(result.content);
    expect(data.found).toBe(true);
    expect(data.logTail).toBeUndefined();
  });

  it("status for unknown run returns found:false", async () => {
    const deps = buildDeps();
    const executor = createCliControlAgentRunExecutor(deps);
    const result = await executor({
      arguments: JSON.stringify({ action: "status", runId: "run-missing" }),
    });
    expect(JSON.parse(result.content)).toEqual({ runId: "run-missing", found: false });
  });

  it("list returns all registered runs", async () => {
    const deps = buildDeps({ kill: () => {} });
    seedRun(deps, "run-1");
    seedRun(deps, "run-2", { agentKey: "agent-pub-y" });
    const executor = createCliControlAgentRunExecutor(deps);
    const result = await executor({ arguments: JSON.stringify({ action: "list" }) });
    const data = JSON.parse(result.content);
    expect(data.count).toBe(2);
    expect(data.runs.map((r: any) => r.runId)).toEqual(["run-1", "run-2"]);
  });

  it("stop kills the pid and finalizes the run as killed", async () => {
    const deps = buildDeps();
    seedRun(deps, "run-1");
    const executor = createCliControlAgentRunExecutor(deps);
    const result = await executor({
      arguments: JSON.stringify({ action: "stop", runId: "run-1" }),
    });
    expect(JSON.parse(result.content)).toEqual({ runId: "run-1", found: true, status: "killed" });
    expect(deps.killCalls).toEqual([{ pid: 123, signal: "SIGTERM" }]);
    const record = JSON.parse(deps.mem.files.get("/home/test/.nolo/runs/run-1.json")!);
    expect(record.status).toBe("killed");
    expect(record.endedAt).toBeDefined();
  });

  it("stop for unknown run returns found:false and does not crash", async () => {
    const deps = buildDeps();
    const executor = createCliControlAgentRunExecutor(deps);
    const result = await executor({
      arguments: JSON.stringify({ action: "stop", runId: "run-missing" }),
    });
    expect(JSON.parse(result.content)).toEqual({ runId: "run-missing", found: false });
  });

  it("throws on unknown action", async () => {
    const deps = buildDeps();
    const executor = createCliControlAgentRunExecutor(deps);
    await expect(
      executor({ arguments: JSON.stringify({ action: "nope" }) }),
    ).rejects.toThrow("未知 action");
  });
});
