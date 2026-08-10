// packages/cli/client/cliAgentRunToolExecutors.ts
//
// CLI 本地实现 startAgentRun / controlAgentRun（agent-orchestration 能力包）。
// 复用 agentRunControl.ts 的 ~/.nolo/runs/ 注册表机制（spawnLocalBackgroundRun /
// findRunRecord / listRunRecords / checkStaleRun / finalizeRunRecord），把能力包
// 的两个编排工具接到 CLI 本地 --bg 路径上。
//
// 返回格式与 web 端 executor 一致：{ content: JSON(rawData), metadata.displayData }，
// 由 localToolExecutors 分发（host adapter executeTool）。

import { existsSync, readFileSync } from "node:fs";
import {
  formatListRunsCard,
  formatNotFoundRunCard,
  formatStartRunCard,
  formatStatusRunCard,
  formatStopRunCard,
  isAgentRunTerminalStatus,
  resolveRunLabel,
  TASK_PREVIEW_MAX,
} from "../ai/tools/agent/agentRunDisplayHelpers";
import {
  type AgentRunControlDeps,
  type FsLike,
  type RunRecord,
  checkStaleRun,
  finalizeRunRecord,
  findRunRecord,
  gcRunRecords,
  queryRunRecords,
  spawnLocalBackgroundRun,
} from "../agentRunControl";
import { readTimestamp } from "./agentRunSnapshot";
import { agentRunCardLabels } from "../tui/i18n";
import {
  type CircuitBreakerEntry,
  type CircuitBreakerStore,
  buildBreakerEntry,
  classifyRunFailure,
  findActiveBreaker,
  shouldRejectDispatch,
} from "../ai/tools/agent/quotaCircuitBreaker";
import {
  aggregateBatch,
  type BatchRunSummary,
} from "../ai/tools/agent/batchAggregation";
import {
  deriveTodoStatus,
  type TodoRecord,
  type TodoRunSummary,
  type TodoStore,
} from "../ai/tools/agent/runtimeTodo";
import {
  createFileSystemCircuitBreakerStore,
  createFileSystemTodoStore,
} from "./fileSystemStores";

type EnvLike = Record<string, string | undefined>;
type OutputLike = { write(chunk: string): unknown };

/**
 * CLI executor 接线所需的依赖。所有新增字段可选，不破坏现有调用方
 * （入参只增不改）。
 *
 - breakerStore / todoStore：缺省时惰性创建文件实现（~/.nolo/breakers.json、
 *   ~/.nolo/todos.json）；测试可注入内存实现。
 - now：缺省 Date.now()。共享层禁止取时钟，但 CLI 适配层允许。
 - resolveProviderTarget：把 agentKey 映射成熔断 target。CLI 本地 run 不携带
 *   provider 字段（run 记录只有 agentKey），用一个 agentKey 对应一份 provider
 *   配置，故以 agentKey 作 target，粒度等价于 provider。
 */
export type CliAgentRunToolExecutorDeps = {
  env?: EnvLike;
  /** CLI entrypoint path（spawn 子进程重启动用）。 */
  cliEntrypoint?: string;
  /** run 的工作目录；缺省用 process.cwd()。 */
  cwd?: string;
  /** Q 熔断表适配；缺省惰性建文件实现。 */
  breakerStore?: CircuitBreakerStore;
  /** T todo 存储适配；缺省惰性建文件实现。 */
  todoStore?: TodoStore;
  /** 时钟（epoch ms）；缺省 Date.now()。共享层禁止取，适配层允许。 */
  nowMs?: () => number;
  /**
   * 把 agentKey 解析成熔断 target（Q）。CLI 本地 run 无 provider 字段，
   * 缺省直接返回 agentKey。测试可注入别的映射。
   */
  resolveProviderTarget?: (agentKey: string) => string;
} & AgentRunControlDeps;

const noopOutput: OutputLike = { write: () => {} };

const parseCallArgs = (call: any): Record<string, any> => {
  try {
    return JSON.parse(call?.arguments || "{}");
  } catch {
    return {};
  }
};

const resolveFs = (deps: CliAgentRunToolExecutorDeps): FsLike =>
  (deps.fs ?? { existsSync, readFileSync }) as FsLike;

const tailFile = (
  logPath: string,
  tailLines: number,
  fs: FsLike,
): string | undefined => {
  if (!fs.existsSync(logPath)) return undefined;
  try {
    const content = fs.readFileSync(logPath, "utf8");
    const lines = String(content).split(/\r?\n/);
    // 去掉文件末尾换行产生的空元素，避免污染最后一行。
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(Math.max(0, lines.length - tailLines)).join("\n");
  } catch {
    return undefined;
  }
};

// ─────────────────────────── 接线适配 helpers ───────────────────────────
//
// 以下 helpers 把共享层（零 I/O）的纯函数接到 CLI 本地执行路径上。
// 共享层契约缺省时惰性创建文件实现，测试可注入内存实现。

const resolveBreakerStore = (
  deps: CliAgentRunToolExecutorDeps,
): CircuitBreakerStore =>
  deps.breakerStore ?? createFileSystemCircuitBreakerStore({ env: deps.env, homedir: deps.homedir, fs: deps.fs as any });

const resolveTodoStore = (deps: CliAgentRunToolExecutorDeps): TodoStore =>
  deps.todoStore ?? createFileSystemTodoStore({ env: deps.env, homedir: deps.homedir, fs: deps.fs as any });

const resolveNowMs = (deps: CliAgentRunToolExecutorDeps): number =>
  typeof deps.nowMs === "function" ? deps.nowMs() : Date.now();

const resolveTarget = (deps: CliAgentRunToolExecutorDeps, agentKey: string): string =>
  typeof deps.resolveProviderTarget === "function" ? deps.resolveProviderTarget(agentKey) : agentKey;

/**
 * 给 `status` 的返回值补一段紧凑的进度，让 tailLines:0 真的能回答「它卡住了
 * 吗」。
 *
 * 只有非终态 run 才有进度可言：跑完了就看 status 和 exitCode。字段刻意精简
 * ——这段每次轮询都要进模型上下文，一条 run 的诊断信息不该比它的结果还长。
 *
 * - `idleMs` 是距上次真实事件（不是距上次写盘）多久：这是判定卡死的那个数。
 * - `inFlight` 有值说明它此刻正卡在某个具体动作上，配合 `inFlightMs` 就能
 *   区分「跑得好好的」和「同一个工具吊了两分钟」。
 */
function buildProgressField(
  record: RunRecord,
  nowMs: number
): { progress?: Record<string, unknown> } {
  const activity = record.activity;
  if (!activity || isAgentRunTerminalStatus(record.status)) return {};
  const lastEventAt = Date.parse(activity.lastEventAt ?? "");
  const inFlight = activity.inFlight;
  const progress: Record<string, unknown> = {
    toolCalls: activity.counters?.toolCalls ?? 0,
    llmCalls: activity.counters?.llmCalls ?? 0,
    fileEdits: activity.counters?.fileEdits ?? 0,
    ...(Number.isFinite(lastEventAt)
      ? { idleMs: Math.max(0, nowMs - lastEventAt) }
      : {}),
  };
  if (inFlight) {
    progress.inFlight = inFlight.name ? `${inFlight.kind}:${inFlight.name}` : inFlight.kind;
    if (Number.isFinite(inFlight.sinceMs)) progress.inFlightMs = Math.max(0, inFlight.sinceMs);
  }
  return { progress };
}

/** startAgentRun：本地 --bg 启动一个后台 run，返回 runId。 */
export function createCliStartAgentRunExecutor(deps: CliAgentRunToolExecutorDeps = {}) {
  return async (call: any): Promise<{ content: string; metadata?: Record<string, unknown> }> => {
    const args = parseCallArgs(call);
    const agentKey = typeof args.agentKey === "string" ? args.agentKey.trim() : "";
    const task = typeof args.task === "string" ? args.task.trim() : "";
    if (!agentKey) throw new Error("startAgentRun: 缺少 agentKey 参数。");
    if (!task) throw new Error("startAgentRun: 缺少有效的 task 文本描述。");

    // ── Q 接线：派发前熔断检查 ──────────────────────────────────────
    // 熔断期内直接返回结构化错误，不发起远程调用（不 spawn 子进程）。
    // 调用方（编排者）收到 reason="quota" 后可立即决策换人。
    const breakerStore = resolveBreakerStore(deps);
    const target = resolveTarget(deps, agentKey);
    const nowMs = resolveNowMs(deps);
    const activeBreaker = findActiveBreaker(
      nowMs,
      [breakerStore.get(target)].filter(Boolean) as CircuitBreakerEntry[],
      target,
    );
    if (activeBreaker) {
      const resetsAt = activeBreaker.resetsAt;
      return {
        content: JSON.stringify({
          rejected: true,
          reason: "quota",
          provider: target,
          ...(resetsAt !== undefined ? { resetsAt } : {}),
          message: `provider ${target} 处于熔断期（配额耗尽），建议改派其它 provider。`,
        }),
        metadata: {
          displayData: `Run rejected · quota breaker active on ${target}`,
        },
      };
    }

    const message =
      typeof args.input === "undefined"
        ? task
        : `${task}\n\n--- 附加输入 ---\n${JSON.stringify(args.input)}`;

    // --msg-file 占位会被 spawnLocalBackgroundRun 的 rewriteMsgFileArg 改写为
    // runs 目录里的内容快照（~/.nolo/runs/<runId>.msg.md）；--bg 会被子进程剥离。
    const rawArgs = [
      "--agent",
      agentKey,
      "--msg-file",
      "PLACEHOLDER",
      "--bg",
      // 非持久化派发（review 等一次性任务）：透传 --ephemeral，run 完成后不留
      // dialog 记录。与 web 端 runAgentBackground 的 ephemeral: true 对齐。
      ...(args.ephemeral === true ? ["--ephemeral"] : []),
    ];

    const agentName =
      typeof args.agentName === "string" && args.agentName.trim()
        ? args.agentName.trim()
        : typeof args.name === "string" && args.name.trim()
        ? args.name.trim()
        : undefined;

    const batchId =
      typeof args.batchId === "string" && args.batchId.trim()
        ? args.batchId.trim()
        : undefined;

    const { runId, batchId: resolvedBatchId } = await spawnLocalBackgroundRun(
      {
        rawArgs,
        commandPath: ["agent", "run"],
        cliEntrypointPath: deps.cliEntrypoint,
        agentKey,
        ...(agentName ? { agentName } : {}),
        ...(batchId ? { batchId } : {}),
        ...(typeof args.parentDialogId === "string" && args.parentDialogId.trim()
          ? { parentDialogId: args.parentDialogId.trim() }
          : {}),
        cwd: deps.cwd ?? process.cwd(),
        message,
        output: noopOutput,
      },
      deps,
    );

    const displayName = resolveRunLabel({ agentName, agentKey, runId });
    const labels = agentRunCardLabels();
    // Same reason as the server-side executor: without the task text two
    // concurrent runs render as identical cards.
    const taskPreview =
      typeof args.task === "string"
        ? args.task.replace(/\s+/g, " ").trim().slice(0, TASK_PREVIEW_MAX)
        : "";

    // ── T 接线：成功派发后记录/更新 todo ───────────────────────────
    // 传了 batchId 或显式 trackTodo:true 时写 todo。todo 状态由关联 run 状态
    // + review 结论推导（调用 deriveTodoStatus），这里先建 pending 记录，
    // 后续 controlAgentRun(todo) 读时再刷新。title 用 taskPreview。
    const trackTodo =
      typeof args.trackTodo === "boolean"
        ? args.trackTodo
        : Boolean(resolvedBatchId);
    if (trackTodo) {
      try {
        const todoStore = resolveTodoStore(deps);
        const todoId = `todo-${resolvedBatchId}`;
        const existing = await todoStore.getTodo(todoId);
        const nowIso = new Date(nowMs).toISOString();
        const runIds = existing?.runIds ?? [];
        if (!runIds.includes(runId)) runIds.push(runId);
        const todo: TodoRecord = {
          id: todoId,
          title: taskPreview || task.slice(0, 100),
          status: existing?.status ?? "pending",
          ...(existing?.specPath ? { specPath: existing.specPath } : {}),
          ...(existing?.worktree ? { worktree: existing.worktree } : {}),
          ...(existing?.branch ? { branch: existing.branch } : {}),
          ...(deps.cwd ? { worktree: deps.cwd } : {}),
          runIds,
          deps: existing?.deps ?? [],
          createdAt: existing?.createdAt ?? nowIso,
          updatedAt: nowIso,
        };
        await todoStore.putTodo(todo);
      } catch {
        // todo 写入失败不应阻塞派发（run 已 spawn）。编排者可后续重建。
      }
    }

    return {
      content: JSON.stringify({
        runId,
        status: "running",
        // batchId is always returned so the caller can later filter by it —
        // even when the caller didn't supply one, a fresh id was generated.
        batchId: resolvedBatchId,
        ...(agentName ? { agentName } : {}),
        ...(taskPreview ? { taskPreview } : {}),
      }),
      metadata: {
        displayData: formatStartRunCard(displayName, "running", {
          task: taskPreview,
          runId,
          labels,
        }),
      },
    };
  };
}

/** controlAgentRun：list / status / stop，映射到本地 ~/.nolo/runs/ 注册表。 */
export function createCliControlAgentRunExecutor(deps: CliAgentRunToolExecutorDeps = {}) {
  return async (call: any): Promise<{ content: string; metadata?: Record<string, unknown> }> => {
    const args = parseCallArgs(call);
    const action = typeof args.action === "string" ? args.action : "";
    const tailLines = typeof args.tailLines === "number" ? args.tailLines : 0;

    if (action === "list") {
      // Lazy reconcile + filter + paginate happen in queryRunRecords. The old
      // code called listRunRecords() directly and returned every record (1000+),
      // ignoring statusFilter/limit entirely — that was the bug. GC runs
      // opportunistically on the same call; it never touches non-terminal
      // records, so it's safe to run alongside active runs.
      gcRunRecords(deps);
      const { runs: records, total, hasMore } = queryRunRecords(
        {
          ...(typeof args.batchId === "string" && args.batchId.trim()
            ? { batchId: args.batchId.trim() }
            : {}),
          ...(typeof args.status === "string" && args.status.trim()
            ? { status: args.status.trim() }
            : typeof args.statusFilter === "string" && args.statusFilter.trim()
            ? { status: args.statusFilter.trim() }
            : {}),
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
          ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
        },
        deps,
      );
      const runs = records.map((record) => {
        return {
          runId: record.runId,
          status: record.status,
          agentKey: record.agentKey,
          ...(record.agentName ? { agentName: record.agentName } : {}),
          ...(record.batchId ? { batchId: record.batchId } : {}),
          pid: record.pid ?? null,
          startedAt: record.startedAt,
        };
      });
      const labels = agentRunCardLabels();

      // ── D1 接线：list + batchId 时附加批次收敛摘要 ─────────────────
      // 编排者传 batchId 查询时，在返回前调用 aggregateBatch：批次收敛时
      // 附加 batchSummary（"3/3 完成"结论式摘要），调用方不必再轮询。
      // 非 batch 查询不附加，保持原返回形状。
      const batchIdArg =
        typeof args.batchId === "string" && args.batchId.trim()
          ? args.batchId.trim()
          : undefined;
      let batchSummary: ReturnType<typeof aggregateBatch> | undefined;
      if (batchIdArg && records.length > 0) {
        const batchRuns: BatchRunSummary[] = records.map((r) => ({
          runId: r.runId,
          status: r.status,
          startedAt: r.startedAt,
          ...(r.agentName ? { agentName: r.agentName } : {}),
        }));
        batchSummary = aggregateBatch({
          batchId: batchIdArg,
          runs: batchRuns,
          now: new Date(resolveNowMs(deps)).toISOString(),
        });
      }

      return {
        content: JSON.stringify({
          runs,
          count: runs.length,
          total,
          hasMore,
          ...(batchSummary?.summary ? { batchSummary: batchSummary.summary } : {}),
        }),
        metadata: {
          displayData: formatListRunsCard(runs, labels),
        },
      };
    }

    // ── T 接线：action="todo" 查询 todo 列表 ──────────────────────────
    // 把持久化 todo + 关联 run 映射成 TodoRunSummary，调 deriveTodoStatus
    // 刷新状态后返回。statusFilter 可选。
    if (action === "todo") {
      const todoStore = resolveTodoStore(deps);
      const statusesRaw = typeof args.status === "string" ? args.status.trim() : undefined;
      const filter = statusesRaw && statusesRaw !== "all"
        ? { statuses: statusesRaw.split(",").map((s) => s.trim()).filter(Boolean) as any }
        : undefined;
      const todos = await todoStore.listTodos(filter);
      // 为每个 todo 喂关联 run 摘要（从 runs 注册表读，复用 queryRunRecords）。
      const enriched = await Promise.all(
        todos.map(async (todo) => {
          const runSummaries: TodoRunSummary[] = [];
          for (const rid of todo.runIds) {
            const rec = findRunRecord(rid, deps);
            if (!rec) continue;
            runSummaries.push({
              runId: rec.runId,
              status: rec.status,
              startedAt: rec.startedAt,
              ...(rec.agentName ? { agentName: rec.agentName } : {}),
            });
          }
          const derived = deriveTodoStatus({
            todo: { id: todo.id, status: todo.status },
            runs: runSummaries,
            now: new Date(resolveNowMs(deps)).toISOString(),
          });
          return {
            id: todo.id,
            title: todo.title,
            status: derived.status,
            runIds: todo.runIds,
            ...(derived.blockedReason ? { blockedReason: derived.blockedReason } : {}),
            ...(derived.latestRun ? { latestRunId: derived.latestRun.runId, latestRunStatus: derived.latestRun.status } : {}),
            updatedAt: todo.updatedAt,
          };
        }),
      );
      return {
        content: JSON.stringify({ todos: enriched, count: enriched.length }),
        metadata: {
          displayData: formatListRunsCard(
            enriched.map((t) => ({
              agentName: t.title,
              status: t.status,
            })),
            agentRunCardLabels(),
          ),
        },
      };
    }

    if (action !== "status" && action !== "stop") {
      throw new Error(`controlAgentRun: 未知 action "${action}"。`);
    }
    if (!args.runId) throw new Error(`controlAgentRun(action:"${action}"): 缺少 runId。`);

    const record = findRunRecord(String(args.runId), deps);
    if (!record) {
      const labels = agentRunCardLabels();
      return {
        content: JSON.stringify({ runId: args.runId, found: false }),
        metadata: { displayData: formatNotFoundRunCard(labels) },
      };
    }

    if (action === "status") {
      const reconciled = checkStaleRun(record.runId, deps) ?? record;
      const logTail =
        tailLines > 0
          ? tailFile(record.logPath, tailLines, resolveFs(deps))
          : undefined;
      const name = resolveRunLabel(reconciled);
      const logLines = logTail ? logTail.split("\n") : undefined;
      const labels = agentRunCardLabels();

      // ── Q 接线：读到失败终态时回填熔断表 ───────────────────────────
      // run 进入 failed/orphaned 等终态时，从日志/错误信息分类失败原因；
      // 若是 quota，把 provider target 写进熔断表，下次 startAgentRun 会被
      // 前置检查拦截。非 quota 失败不写熔断（classifyRunFailure 返回 other）。
      // 只在首次见到该终态时写一次（幂等：重复 status 查询会重复写，但
      // buildBreakerEntry 用 now+TTL 覆盖，不会无限延长——这是可接受的）。
      if (reconciled.status === "failed" || reconciled.status === "orphaned") {
        try {
          const failureSource = logTail ?? reconciled.note ?? "";
          const failureInfo = classifyRunFailure(
            failureSource || reconciled.status,
          );
          if (failureInfo.reason === "quota") {
            const t = resolveTarget(deps, reconciled.agentKey);
            const entry = buildBreakerEntry(
              resolveNowMs(deps),
              t,
              "quota",
              failureInfo.retryAfterMs,
            );
            resolveBreakerStore(deps).set(entry);
          }
        } catch {
          // 熔断回填失败不影响 status 返回。
        }
      }

      return {
        content: JSON.stringify({
          runId: reconciled.runId,
          found: true,
          status: reconciled.status,
          pid: reconciled.pid ?? null,
          agentKey: reconciled.agentKey,
          ...(reconciled.agentName ? { agentName: reconciled.agentName } : {}),
          startedAt: reconciled.startedAt,
          endedAt: reconciled.endedAt ?? null,
          exitCode: reconciled.exitCode ?? null,
          // Expose dialogId so the caller can read the agent's actual output
          // via `nolo dialog read <dialogId>`. The dialog is the authoritative
          // result store; the run log is the child process stdout/stderr,
          // whose contents vary by provider (some stream tokens to stdout,
          // some only emit startup + stderr). Because status does not carry
          // logTail by default, a "done" run with an empty logTail is
          // indistinguishable from a hung run without this field. Surfacing
          // dialogId gives the caller a reliable way to fetch the result.
          ...(reconciled.dialogId ? { dialogId: reconciled.dialogId } : {}),
          // Progress is what makes tailLines:0 an actual answer to "is it
          // stuck?". Without it a poll returns `running` and a pid, so the only
          // way to tell a working run from a wedged one was to pull 30 lines of
          // log — the exact thing the orchestration prompt tells the model not
          // to do. The registry has been recording this all along and `nolo
          // agent status` has been printing it; only the tool was blind.
          ...buildProgressField(reconciled, resolveNowMs(deps)),
          ...(logTail !== undefined ? { logTail } : {}),
          ...(logLines ? { logLines } : {}),
        }),
        metadata: {
          displayData: formatStatusRunCard(name, reconciled.status, {
            runId: reconciled.runId,
            timing: {
              startedAt: readTimestamp(reconciled.startedAt),
              finishedAt: readTimestamp(reconciled.endedAt),
            },
            logLines,
            labels,
          }),
        },
      };
    }

    // action === "stop"
    if (typeof record.pid === "number") {
      try {
        (deps.kill ?? ((pid: number, signal: string) => process.kill(pid, signal as NodeJS.Signals)))(
          record.pid,
          "SIGTERM",
        );
      } catch {
        // pid 已不存在或无权：继续 finalize 为 killed（与 CLI stop 命令行为一致）。
      }
    }
    finalizeRunRecord(record.runId, { status: "killed" }, deps);
    const labels = agentRunCardLabels();
    return {
      content: JSON.stringify({ runId: record.runId, found: true, status: "killed" }),
      metadata: { displayData: formatStopRunCard("killed", labels) },
    };
  };
}
