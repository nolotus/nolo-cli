// packages/cli/client/cliAgentRunToolExecutors.ts
//
// CLI 本地实现 startAgentRun / controlAgentRun（agent-orchestration 能力包）。
// 复用 agentRunControl.ts 的 ~/.nolo/runs/ 注册表机制（spawnLocalBackgroundRun /
// findRunRecord / listRunRecords / checkStaleRun / finalizeRunRecord），把能力包
// 的两个编排工具接到 CLI 本地 --bg 路径上。
// controlAgentRun 支持 list / status / wait / stop / todo：wait 轮询本地 run 记录
// 直到终态（复用 checkStaleRun 惰性对账），超时返回 status="timeout"（非失败）。
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
} from "../../ai/tools/agent/agentRunDisplayHelpers";
import {
  type AgentRunControlDeps,
  type FsLike,
  type RunRecord,
  checkStaleRun,
  ackRunRecord,
  claimRunRecord,
  commitRunRecordClaim,
  releaseRunRecordAck,
  finalizeRunRecord,
  findRunRecord,
  gcRunRecords,
  queryRunRecords,
  spawnLocalBackgroundRun,
} from "../agentRunControl";
import { readTimestamp } from "./agentRunSnapshot";
import { agentRunCardLabels } from "../tui/i18n";
import {
  aggregateBatch,
  type BatchRunSummary,
} from "../../ai/tools/agent/batchAggregation";
import {
  deriveAgentRunTodoStatus,
  type AgentRunTodoRecord,
  type AgentRunTodoRunSummary,
  type AgentRunTodoStore,
} from "../../ai/tools/agent/agentRunTodo";
import { createFileSystemTodoStore } from "./fileSystemStores";

type EnvLike = Record<string, string | undefined>;
type OutputLike = { write(chunk: string): unknown };

/**
 * CLI executor 接线所需的依赖。所有新增字段可选，不破坏现有调用方
 * （入参只增不改）。
 *
 - todoStore：缺省时惰性创建文件实现（~/.nolo/todos.json）；测试可注入内存实现。
 - now：缺省 Date.now()。CLI 适配层允许取时钟。
 */
export type CliAgentRunToolExecutorDeps = {
  env?: EnvLike;
  /** CLI entrypoint path（spawn 子进程重启动用）。 */
  cliEntrypoint?: string;
  /** run 的工作目录；缺省用 process.cwd()。 */
  cwd?: string;
  /** T todo 存储适配；缺省惰性建文件实现。 */
  todoStore?: AgentRunTodoStore;
  /** 时钟（epoch ms）；缺省 Date.now()。共享层禁止取，适配层允许。 */
  nowMs?: () => number;
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

const resolveTodoStore = (deps: CliAgentRunToolExecutorDeps): AgentRunTodoStore =>
  deps.todoStore ?? createFileSystemTodoStore({ env: deps.env, homedir: deps.homedir, fs: deps.fs as any });

const resolveNowMs = (deps: CliAgentRunToolExecutorDeps): number =>
  typeof deps.nowMs === "function" ? deps.nowMs() : Date.now();

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

/** action="wait" 的轮询间隔（ms）。 */
const WAIT_POLL_INTERVAL_MS = 500;
/** action="wait" 的默认等待上限（ms），与 web 端 controlAgentRun 的 timeoutMs 默认一致。 */
const DEFAULT_WAIT_TIMEOUT_MS = 100000;

/**
 * 租约 ttl 相对本次 wait 超时的宽限：租约必须活得比这次等待久一点（否则
 * 自己的 claim 会在还在等的时候过期），又不能久太多（进程被硬杀后要尽快
 * 自愈）。
 */
const ACK_LEASE_GRACE_MS = 60_000;

/** status/wait 共用的 run 结果载荷（含 dialogId/exitCode/progress；日志可选）。 */
function buildRunStatusPayload(
  reconciled: RunRecord,
  deps: CliAgentRunToolExecutorDeps,
  opts: { logTail?: string } = {},
): { content: string; metadata?: Record<string, unknown> } {
  const logLines = opts.logTail ? opts.logTail.split("\n") : undefined;
  const name = resolveRunLabel(reconciled);
  const labels = agentRunCardLabels();
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
      ...(opts.logTail !== undefined ? { logTail: opts.logTail } : {}),
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

/** startAgentRun：本地 --bg 启动一个后台 run，返回 runId。 */
export function createCliStartAgentRunExecutor(deps: CliAgentRunToolExecutorDeps = {}) {
  return async (call: any): Promise<{ content: string; metadata?: Record<string, unknown> }> => {
    const args = parseCallArgs(call);
    const agentKey = typeof args.agentKey === "string" ? args.agentKey.trim() : "";
    const task = typeof args.task === "string" ? args.task.trim() : "";
    if (!agentKey) throw new Error("startAgentRun: 缺少 agentKey 参数。");
    if (!task) throw new Error("startAgentRun: 缺少有效的 task 文本描述。");
    const nowMs = resolveNowMs(deps);

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
        const todo: any = {
          id: todoId,
          title: taskPreview || task.slice(0, 100),
          status: existing?.status ?? "pending",
          runIds,
          createdAt: existing?.createdAt ?? nowIso,
          updatedAt: nowIso,
        };
        if (typeof todoStore.saveTodo === "function") {
          await todoStore.saveTodo(todo);
        } else {
          await (todoStore as any).putTodo(todo);
        }
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

/** controlAgentRun：list / status / wait / stop / todo，映射到本地 ~/.nolo/runs/ 注册表。wait 轮询记录直到终态。 */
export function createCliControlAgentRunExecutor(deps: CliAgentRunToolExecutorDeps = {}) {
  return async (
    call: any,
    // localToolPolicy 把 per-turn abortSignal 注入给「能长时间阻塞」的工具，
    // wait 是其中之一：turn 被强停时轮询必须自己收手并释放租约，否则上层
    // raceWithAbort 只是不再等它，它仍在后台空转。
    opts?: { abortSignal?: AbortSignal },
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> => {
    const args = parseCallArgs(call);
    const abortSignal = opts?.abortSignal;
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

    // ── T 接线：action="todo" / "agentRunTodo" 查询 AgentRunTodo 列表 ──────
    if (action === "todo" || action === "agentRunTodo" || action === "agent_run_todo") {
      const todoStore = resolveTodoStore(deps);
      const todos = await todoStore.listTodos();
      const statusFilter = typeof args.status === "string" ? args.status.trim().toLowerCase() : undefined;
      // 为每个 todo 喂关联 run 摘要（从 runs 注册表读，复用 queryRunRecords）。
      let enriched = await Promise.all(
        todos.map(async (todo) => {
          const runSummaries: AgentRunTodoRunSummary[] = [];
          for (const rid of todo.runIds) {
            const rec = findRunRecord(rid, deps);
            if (!rec) continue;
            runSummaries.push({
              runId: rec.runId,
              status: rec.status,
              startedAt: readTimestamp(rec.startedAt)?.toString(),
              finishedAt: readTimestamp(rec.endedAt)?.toString(),
              ...(rec.agentName ? { agentName: rec.agentName } : {}),
            });
          }
          const derived = deriveAgentRunTodoStatus({
            todo: { id: todo.id, status: todo.status },
            runs: runSummaries,
          });
          return {
            id: todo.id,
            title: todo.title,
            status: derived.status,
            runIds: todo.runIds,
            ...(derived.latestRun ? { latestRunId: derived.latestRun.runId, latestRunStatus: derived.latestRun.status } : {}),
            updatedAt: todo.updatedAt,
          };
        }),
      );

      // 支持 status 过滤（兼容 status="running" / status="done,failed" 等）
      if (statusFilter && statusFilter !== "all") {
        const wanted = new Set(statusFilter.split(",").map((s) => s.trim()).filter(Boolean));
        enriched = enriched.filter((t) => wanted.has(t.status.toLowerCase()));
      }

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

    if (action !== "status" && action !== "stop" && action !== "wait") {
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
      // Q 接线：读到失败终态时回填熔断表（幂等；status/wait 共用同一实现）。
      return buildRunStatusPayload(reconciled, deps, { logTail });
    }

    // ── W 接线：action="wait" 轮询本地 run 记录直到终态 ───────────────
    // 本地 --bg 的 run 是本地子进程，wait 语义 = 轮询 ~/.nolo/runs/ 记录直到
    // 终态（done/failed/timeout/killed/cancelled/orphaned）。每次轮询复用 status
    // 的 checkStaleRun 惰性对账：子进程写了终态直接读到；子进程静默退出（没来得
    // 及写终态）会被对账成 orphaned——两条收敛路径都覆盖。超时返回 status="timeout"
    // （不是失败，run 记录不被改写），可稍后再 wait 或改用 status/stop。
    if (action === "wait") {
      const timeoutMs =
        typeof args.timeoutMs === "number" && args.timeoutMs > 0
          ? args.timeoutMs
          : DEFAULT_WAIT_TIMEOUT_MS;
      // claim-on-start：先取一份带 token 和 ttl 的租约，再开始轮询。
      //
      // 拿不到租约说明已有别的同步消费者（或终局 ack）盯着这条 run，本次
      // 不再重复 claim，也就无从释放——退化成纯读，结果照常返回。
      //
      // ttl 绑定本次 wait 实际使用的 timeoutMs + 宽限（缺省时为 100s + 60s ≈ 160s），
      // 避免缺省 timeoutMs 时租约落回 15min 兜底导致崩溃自愈延迟过长。
      const claimToken = claimRunRecord(record.runId, {
        ...deps,
        ttlMs: timeoutMs + ACK_LEASE_GRACE_MS,
      });
      // 租约必须在「本次 wait 没能把结果交出去」的每一条退出路径上释放，不
      // 只是超时：turn 被强停时 raceWithAbort 直接孤儿化这个 promise，finally
      // 可能很久之后才跑（甚至进程已被硬杀根本不跑）。token 保证迟到的释放
      // 不会误删后来者的租约，ttl 保证进程被杀时租约自己过期——两者一起，
      // 泄漏的 claim 不会再让这条 run 的完成永久静默。
      let claimConsumed = false;
      try {
        const startMs = resolveNowMs(deps);
        const deadline = startMs + timeoutMs;
        const baseSleep =
          deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
        // abort 要能立刻打断休眠，否则强停后仍要空转一个轮询间隔才收手。
        // baseSleep 异常要透传，防止挂死或 unhandled rejection。
        const sleep = abortSignal
          ? (ms: number) =>
              new Promise<void>((resolve, reject) => {
                const done = () => {
                  abortSignal.removeEventListener("abort", done);
                  resolve();
                };
                abortSignal.addEventListener("abort", done, { once: true });
                Promise.resolve(baseSleep(ms))
                  .then(done)
                  .catch((err) => {
                    abortSignal.removeEventListener("abort", done);
                    reject(err);
                  });
              })
          : baseSleep;
        let reconciled = record;
        for (;;) {
          reconciled = checkStaleRun(record.runId, deps) ?? record;
          if (isAgentRunTerminalStatus(reconciled.status)) break;
          if (abortSignal?.aborted) {
            // turn 被强停：立刻收手，让 finally 释放租约。抛错而不是返回结
            // 果，因为这次 wait 没有拿到任何结论——run 仍在跑，它的完成必须
            // 重新走唤醒通道。
            throw new Error("controlAgentRun(wait) 已被中止。");
          }
          const nowMs = resolveNowMs(deps);
          const waitedMs = nowMs - startMs;
          if (nowMs >= deadline) {
            // 超时：run 仍未终态。返回 status="timeout" 标记（非失败），附带真实
            // runStatus + progress 让调用方判断它是否还在干活。claim 由 finally
            // 释放，run 之后真到终态时重新走终态唤醒通道。
            return {
              content: JSON.stringify({
                runId: reconciled.runId,
                found: true,
                status: "timeout",
                runStatus: reconciled.status,
                pid: reconciled.pid ?? null,
                agentKey: reconciled.agentKey,
                ...(reconciled.agentName ? { agentName: reconciled.agentName } : {}),
                startedAt: reconciled.startedAt,
                waitedMs,
                timeoutMs,
                ...buildProgressField(reconciled, nowMs),
              }),
              metadata: {
                displayData: `⏳ wait 超时（${Math.round(waitedMs / 1000)}s），run 仍在运行：可稍后再 wait，或改用 status/stop`,
              },
            };
          }
          await sleep(WAIT_POLL_INTERVAL_MS);
        }
        // 到达终态：失败终态同样回填熔断表（Q 接线，与 status 一致）；返回与
        // status 相同形状的结果（含 dialogId/exitCode/progress，不带日志）。
        // 结果确实由本次调用交出，claim 保留——这才是「已有人收走」。
        const payload = buildRunStatusPayload(reconciled, deps);
        if (claimToken) commitRunRecordClaim(record.runId, claimToken, deps);
        else ackRunRecord(reconciled.runId, deps);
        claimConsumed = true;
        return payload;
      } finally {
        if (!claimConsumed && claimToken) {
          releaseRunRecordAck(record.runId, claimToken, deps);
        }
      }
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
