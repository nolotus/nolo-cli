// packages/cli/client/cliAgentRunToolExecutors.quotaIntegration.test.ts
//
// Q 熔断的**真集成测试**（reviewer BLOCK 的核心诉求）。
//
// 之前的 quotaCircuitBreaker.test.ts 在测试体内手写 dispatch 计数器自证——
// 即使删掉全部生产接线（startAgentRun 前置检查）测试照样绿。本测试导入
// 真实的 createCliStartAgentRunExecutor 执行路径，验证：
//   1. provider 返回 quota 错误 → status 读路径把熔断写入 breakerStore
//   2. 再次 startAgentRun 同一 provider → 不发起远程调用（spawn 不被调用）
//   3. 时间推进到熔断过期 → 再次 startAgentRun → 正常发起远程调用
//
// 失败时给出明确信号（断言消息写明预期），不是默默通过。

import { describe, expect, it } from "bun:test";
import type { FsLike, SpawnLike } from "../agentRunControl";
import {
  createCliControlAgentRunExecutor,
  createCliStartAgentRunExecutor,
  type CliAgentRunToolExecutorDeps,
} from "./cliAgentRunToolExecutors";
import {
  createInMemoryCircuitBreakerStore,
  type CircuitBreakerStore,
} from "../ai/tools/agent/quotaCircuitBreaker";
import { createInMemoryTodoStore } from "./__testHelpers";

const buildMemFs = () => {
  const files = new Map<string, string>();
  const fs = {
    mkdirSync: () => {},
    writeFileSync: (path: string, content: string) => files.set(path, content),
    readFileSync: (path: string) => {
      const v = files.get(path);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    readdirSync: (path: string) =>
      [...files.keys()].filter((k) => k.startsWith(`${path}/`)).map((k) => k.slice(path.length + 1)),
    existsSync: (path: string) => files.has(path),
    openSync: () => 1,
    unlinkSync: (path: string) => files.delete(path),
  } as unknown as FsLike;
  return { files, fs };
};

const buildDeps = (
  overrides: Partial<CliAgentRunToolExecutorDeps> & {
    breakerStore?: CircuitBreakerStore;
    nowMs?: () => number;
  } = {},
) => {
  const mem = buildMemFs();
  const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
  let spawnCallCount = 0;
  const deps: CliAgentRunToolExecutorDeps & {
    mem: typeof mem;
    spawnCalls: typeof spawnCalls;
    spawnCallCount: () => number;
  } = {
    env: {},
    cliEntrypoint: "/cli/entrypoint",
    cwd: "/work",
    homedir: () => "/home/test",
    generateRunId: (() => {
      let n = 0;
      return () => `run-${++n}`;
    })(),
    now: () => new Date("2026-07-31T00:00:00.000Z"),
    spawn: ((cmd: string, args: string[], _opts: any) => {
      spawnCallCount += 1;
      spawnCalls.push({ cmd, args });
      return { pid: 123, unref: () => {} };
    }) as unknown as SpawnLike,
    kill: () => {},
    fs: mem.fs,
    breakerStore: overrides.breakerStore ?? createInMemoryCircuitBreakerStore(),
    todoStore: createInMemoryTodoStore(),
    nowMs: overrides.nowMs ?? (() => 1_000_000),
    ...overrides,
    mem,
    spawnCalls,
    spawnCallCount: () => spawnCallCount,
  };
  return deps;
};

/** 模拟一个 run 已因 quota 失败终态落盘（provider 返回 quota 错误后的产物）。 */
const seedFailedRun = (
  deps: ReturnType<typeof buildDeps>,
  runId: string,
  agentKey: string,
  quotaMessage: string,
) => {
  const record = {
    runId,
    agentKey,
    status: "failed",
    startedAt: "2026-07-31T00:00:00.000Z",
    logPath: `/home/test/.nolo/runs/${runId}.log`,
    pid: undefined,
  };
  deps.mem.files.set(`/home/test/.nolo/runs/${runId}.json`, JSON.stringify(record));
  // 日志里带 quota 文案——classifyRunFailure 据此识别为 quota
  deps.mem.files.set(`/home/test/.nolo/runs/${runId}.log`, quotaMessage);
};

describe("Q quota circuit breaker · 真集成（startAgentRun 执行路径）", () => {
  it("status 读到 quota 失败终态 → 写入熔断表 → 再次派发同 provider 不 spawn", async () => {
    const deps = buildDeps();
    const startExec = createCliStartAgentRunExecutor(deps);
    const controlExec = createCliControlAgentRunExecutor(deps);

    // 1) 模拟 provider 返回 quota 错误：run-1 已 failed，日志含 quota 文案
    seedFailedRun(deps, "run-1", "agent-pub-x", "Error: 429 quota exceeded, rate limit");
    expect(deps.spawnCallCount()).toBe(0);

    // 2) controlAgentRun(status) 读到 failed → classifyRunFailure → buildBreakerEntry → store.set
    const statusRes = await controlExec({
      arguments: JSON.stringify({ action: "status", runId: "run-1", tailLines: 5 }),
    });
    const statusBody = JSON.parse(statusRes.content);
    expect(statusBody.found).toBe(true);
    expect(statusBody.status).toBe("failed");

    // 熔断表应已写入 agent-pub-x（CLI 用 agentKey 作 target）
    const entry = deps.breakerStore!.get("agent-pub-x");
    expect(entry, "熔断表应已写入 agent-pub-x 条目").toBeDefined();
    expect(entry!.kind).toBe("quota");

    // 3) 再次 startAgentRun 同一 provider → 应被前置检查拦截，不 spawn
    const res2 = await startExec({
      arguments: JSON.stringify({ agentKey: "agent-pub-x", task: "第二个任务" }),
    });
    const body2 = JSON.parse(res2.content);
    expect(body2.rejected, "应返回 rejected:true 而非 spawn").toBe(true);
    expect(body2.reason).toBe("quota");
    expect(body2.provider).toBe("agent-pub-x");
    // 关键断言：spawn 从未被调用（不发起远程调用）
    expect(
      deps.spawnCallCount(),
      "熔断期内不应发起远程调用（spawnCallCount 必须为 0）",
    ).toBe(0);
  });

  it("时间推进到熔断过期 → 再次派发 → 正常 spawn", async () => {
    // 用可控时钟：初始 t0，熔断写入后推进到 t0 + TTL + 1
    let clock = 1_000_000;
    const deps = buildDeps({ nowMs: () => clock });
    const startExec = createCliStartAgentRunExecutor(deps);
    const controlExec = createCliControlAgentRunExecutor(deps);

    // 建一个 quota 失败 run 并通过 status 触发熔断写入
    seedFailedRun(deps, "run-1", "agent-pub-y", "429 Too Many Requests");
    await controlExec({
      arguments: JSON.stringify({ action: "status", runId: "run-1", tailLines: 5 }),
    });
    const entry = deps.breakerStore!.get("agent-pub-y");
    expect(entry).toBeDefined();
    const expiresAt = entry!.until;
    expect(expiresAt).toBeGreaterThan(clock);

    // 推进时钟到熔断过期之后
    clock = expiresAt + 1_000;

    // 再次派发 → 应正常 spawn（findActiveBreaker 返回 undefined）
    const res = await startExec({
      arguments: JSON.stringify({ agentKey: "agent-pub-y", task: "过期后重派" }),
    });
    const body = JSON.parse(res.content);
    expect(body.rejected, "熔断过期后不应 rejected").toBeUndefined();
    expect(body.status).toBe("running");
    expect(
      deps.spawnCallCount(),
      "熔断过期后应正常发起远程调用（spawnCallCount 必须为 1）",
    ).toBe(1);
  });

  it("非 quota 失败不写熔断（other reason 不应拦截后续派发）", async () => {
    const deps = buildDeps();
    const startExec = createCliStartAgentRunExecutor(deps);
    const controlExec = createCliControlAgentRunExecutor(deps);

    seedFailedRun(deps, "run-1", "agent-pub-z", "Error: unexpected null pointer");
    await controlExec({
      arguments: JSON.stringify({ action: "status", runId: "run-1", tailLines: 5 }),
    });
    expect(deps.breakerStore!.get("agent-pub-z")).toBeUndefined();

    const res = await startExec({
      arguments: JSON.stringify({ agentKey: "agent-pub-z", task: "重派" }),
    });
    const body = JSON.parse(res.content);
    expect(body.rejected).toBeUndefined();
    expect(deps.spawnCallCount()).toBe(1);
  });
});