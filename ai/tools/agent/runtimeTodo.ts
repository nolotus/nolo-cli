/**
 * 运行时 Todo（跨端共享纯逻辑）
 *
 * 让"还有什么没做完"成为系统内的一等状态，而不是只存在于编排者对话上下文里。
 * 本轮实测的三个硬伤：编排者上下文被冲爆两次（207KB/209KB）队列随时丢失；
 * 换 dialog 状态归零；用户看不见只能问。
 *
 * 核心区分：todo ≠ run
 * - run 是一次进程执行（分钟级，退出即结束）；
 * - todo 是一件要完成的事（跨多次 run、跨 dialog，失败后仍未完成需重派）。
 * 真实例子：「修复 TUI modal 滚轮误取消」一项 todo 派了 3 次 run——
 * 自研偏航被中止、完成但 review BLOCK、修复。run 有 3 条记录，todo 只有 1 项。
 * 1288 条 run 记录回答不了"还有什么没做完"，它只知道进程不知道意图。
 *
 * 硬性约束（review 重点检查，与 batchAggregation.ts 完全一致）：
 * - 零 I/O：禁止任何 Node 专有 API（fs / path / child_process / 环境变量 /
 *   进程控制），禁止 CommonJS 动态加载；
 * - 禁止读取系统时钟：当前时间由入参 `now` 传入；
 * - 必须能在浏览器里直接 import 而不报错（状态推导全端只有这一份）。
 *
 * 复用约定（双实现漂移必须收敛，见 docs/workflow.md）：
 * - 终态判定复用 agentRunDisplayHelpers 的 `isAgentRunTerminalStatus`（已含 orphaned）；
 * - run 摘要形状复用 batchAggregation 的 `BatchRunSummary`，本模块只在其上追加
 *   review 推导所需字段，不平行定义第二套 run 形状。
 *
 * 分层：本模块只做判定/推导与视图模型，不实现任何存储 I/O。
 * `TodoStore` 是契约，CLI 落本地文件、server 落 DB、web 走 API 由各端适配层实现。
 */
import {
  isAgentRunTerminalStatus,
  shortRunId,
  TASK_PREVIEW_MAX,
} from "./agentRunDisplayHelpers";
import { MAX_ERROR_SUMMARY_CHARS } from "./batchAggregation";
import type { BatchRunSummary } from "./batchAggregation";

// ─────────────────────────── 数据模型 ───────────────────────────

export type TodoStatus =
  | "pending"
  | "running"
  | "blocked"
  | "done"
  | "abandoned";

/**
 * review 结论常量。与 nolo-review 的 Verdict 对齐：BLOCK 是唯一
 * 会把 todo 钉在 blocked 的结论，其余结论（PASS/APPROVE 等）不阻塞。
 */
export const TODO_REVIEW_BLOCK = "BLOCK";

/**
 * 一条 todo 的持久化形状（各端适配层负责读写，本模块只定义契约）。
 * `status` 是上次推导结果的缓存，可能过期——任何展示前用
 * `deriveTodoStatus` 刷新，不要直接信持久化值。
 */
export interface TodoRecord {
  id: string;
  title: string;
  status: TodoStatus;
  /** 关联的 task spec 路径（可选）。 */
  specPath?: string;
  /** 执行 worktree（可选）。 */
  worktree?: string;
  /** 执行分支（可选）。 */
  branch?: string;
  /** 关联的 run 列表（关联，不是等同；一次 todo 可对应多次 run）。 */
  runIds: string[];
  /** 被 review BLOCK 时的原因摘要（截断，不塞完整报告）。 */
  blockedReason?: string;
  /** 依赖的其它 todo id；deps 未满足时该 todo 不可执行。 */
  deps: string[];
  /** ISO 时间字符串，由写入方（各端适配层）提供，模块内禁止取时钟。 */
  createdAt: string;
  updatedAt: string;
}

/**
 * 关联 run 的判定摘要：复用 batchAggregation 的 `BatchRunSummary` 形状，
 * 仅追加 review 推导所需字段（不平行定义第二套 run 形状）。
 */
export interface TodoRunSummary extends BatchRunSummary {
  /** 该 run 结束时的 review 结论（如 BLOCK）；缺省视为未 review。 */
  reviewVerdict?: string;
  /** review 结论的原因摘要（BLOCK 时作为 blockedReason 的来源）。 */
  reviewReason?: string;
  /** ISO 结束时间；缺省时按 startedAt / 数组顺序判定先后。 */
  finishedAt?: string;
}

// ─────────────────────────── 常量上限 ───────────────────────────

/** 视图模型一行摘要的字符上限（沿用 batchAggregation 的上限常量做法，
 *  防冲爆编排者上下文——已被冲爆两次 207KB/209KB）。 */
export const MAX_TODO_SUMMARY_CHARS = 100;

// ─────────────────────────── 状态推导（纯函数） ───────────────────────────

export interface DeriveTodoStatusInput {
  /** 持久化记录（只取 id 与显式状态；abandoned 只能显式进入）。 */
  todo: Pick<TodoRecord, "id" | "status">;
  /** 关联 run 摘要（各端把查询结果映射成 TodoRunSummary 喂进来）。 */
  runs: TodoRunSummary[];
  /** 当前时间（ISO，由调用方传入，禁止模块内取时钟）。 */
  now: string;
}

export interface DerivedTodoStatus {
  status: TodoStatus;
  /** 推导依据的最近一次 run（无关联 run 时为 undefined）。 */
  latestRun?: TodoRunSummary;
  /** blocked 时的原因摘要（已折叠空白并截断到 MAX_ERROR_SUMMARY_CHARS）。 */
  blockedReason?: string;
}

/**
 * 由 run 状态集合推导 todo 的当前状态。规则表（评审依据）：
 *
 * | # | 条件 | 结果 |
 * |---|------|------|
 * | 1 | 显式状态为 abandoned（只有人工放弃才进入） | abandoned |
 * | 2 | 无关联 run（无证据可推导） | 保持显式状态 |
 * | 3 | 存在非终态 run（新 run 正在执行，旧 review 不阻塞） | running |
 * | 4 | 最近一次 run 的 reviewVerdict === BLOCK | blocked |
 * | 5 | 最近一次 run 成功（status === done） | done |
 * | 6 | 全部 run 终态但未成功（含 orphaned） | **pending**（等待重派，不是 done） |
 *
 * 关键：规则 6 是本模块存在的意义——run 失败只是进程记录，todo 仍未完成。
 * 失败后重派成功 → 规则 5 转 done；修复 run 在跑 → 规则 3 转 running（转出 blocked）。
 * review 绑定在最近一次 run 上：旧 BLOCK 不会在后续 run 成功后被误判为 blocked。
 */
export function deriveTodoStatus(
  input: DeriveTodoStatusInput
): DerivedTodoStatus {
  const { todo, runs } = input;
  // 规则 1：abandoned 只能由编排者显式标记，run 证据不覆盖。
  if (todo.status === "abandoned") {
    return { status: "abandoned" };
  }
  // 规则 2：无关联 run 时无证据可推导，尊重持久化状态
  //（新建 todo 为 pending，人工标记的 done 保留）。
  if (runs.length === 0) {
    return { status: todo.status };
  }
  // 规则 3：任一 run 在跑 → running。
  if (runs.some((r) => !isAgentRunTerminalStatus(r.status))) {
    return { status: "running", latestRun: latestRun(runs) };
  }
  // 全部终态：最近一次 run 决定结论。
  const latest = latestRun(runs);
  // 规则 4：review 是意图层结论，优先于 run 结果（"且无 BLOCK 才算 done"）。
  if (latest?.reviewVerdict === TODO_REVIEW_BLOCK) {
    return {
      status: "blocked",
      latestRun: latest,
      blockedReason: clipSummary(latest.reviewReason, MAX_ERROR_SUMMARY_CHARS),
    };
  }
  // 规则 5：最近一次 run 成功 → done。
  if (latest?.status === "done") {
    return { status: "done", latestRun: latest };
  }
  // 规则 6：全部终态但未成功 → 回到 pending，等待重派（不是 done）。
  return { status: "pending", latestRun: latest };
}

// ─────────────────────────── 视图模型（渲染无关） ───────────────────────────

export interface BuildTodoViewsInput {
  /** 全部 todo（含 deps 引用，用于跨 todo 依赖判定）。 */
  todos: TodoRecord[];
  /** todoId → 该 todo 关联的 run 摘要（按 runIds 顺序映射，缺省视为无 run）。 */
  runsByTodoId?: Record<string, TodoRunSummary[]>;
  /** 当前时间 ISO。 */
  now: string;
  /** 一行摘要的字符上限，默认 MAX_TODO_SUMMARY_CHARS。 */
  maxSummaryChars?: number;
}

/**
 * 渲染无关的视图模型：plain data，无 ANSI、无终端宽度假设、无完整日志。
 * 同一份形状同时服务四端，各端只做样式：
 * - CLI 面板：一行 `summary`（todo 是主视图，latestRunId 是 drill-down 锚点）；
 * - web 列表项：title / status / summary / blockedReason；
 * - desktop 通知：title + summary；
 * - RN 摘要卡：title / status / runCount / summary。
 */
export interface RuntimeTodoView {
  id: string;
  /** 截断到 TASK_PREVIEW_MAX，不塞完整标题。 */
  title: string;
  status: TodoStatus;
  /** 一行结论式摘要（无色纯文本，长度 ≤ maxSummaryChars）。 */
  summary: string;
  /** blocked 时的原因摘要（≤ MAX_ERROR_SUMMARY_CHARS）；非 blocked 缺省。 */
  blockedReason?: string;
  runCount: number;
  /** 最近一次 run 的 id（CLI 展开 run 细节的锚点）。 */
  latestRunId?: string;
  latestRunStatus?: string;
  deps: string[];
  /** 未满足（未 done/abandoned）的依赖 todo id；空 = 依赖就绪。 */
  blockedByDeps: string[];
  /**
   * 是否可执行：deps 全满足 且 status ∈ {pending, blocked}。
   * pending = 等待重派，blocked = 需处理后重派；running/done/abandoned 不可执行。
   */
  executable: boolean;
}

/**
 * 由 todo 列表 + 关联 run 快照生成视图模型（纯函数，无副作用）。
 * 先推导全部 todo 状态，再统一计算依赖就绪情况，避免依赖判定依赖输入顺序。
 */
export function buildTodoViews(input: BuildTodoViewsInput): RuntimeTodoView[] {
  const maxSummaryChars = input.maxSummaryChars ?? MAX_TODO_SUMMARY_CHARS;
  const runsByTodoId = input.runsByTodoId ?? {};
  const statusById = new Map<string, TodoStatus>();
  const derivedById = new Map<string, DerivedTodoStatus>();

  for (const todo of input.todos) {
    const derived = deriveTodoStatus({
      todo,
      runs: runsByTodoId[todo.id] ?? [],
      now: input.now,
    });
    derivedById.set(todo.id, derived);
    statusById.set(todo.id, derived.status);
  }

  return input.todos.map((todo) => {
    const derived = derivedById.get(todo.id)!;
    const runs = runsByTodoId[todo.id] ?? [];
    const blockedByDeps = todo.deps.filter((depId) => {
      const depStatus = statusById.get(depId);
      // deps 引用不存在的 todo id 视为未满足：依赖丢失 = 阻塞，防止盲目执行。
      return depStatus === undefined || !isDepMet(depStatus);
    });
    const summary = summarizeTodo(
      todo,
      derived,
      blockedByDeps,
      runs,
      maxSummaryChars
    );
    const latest = derived.latestRun;
    return {
      id: todo.id,
      title: clipSummary(todo.title, TASK_PREVIEW_MAX) ?? "",
      status: derived.status,
      summary,
      ...(derived.blockedReason !== undefined
        ? { blockedReason: derived.blockedReason }
        : {}),
      runCount: runs.length,
      ...(latest
        ? { latestRunId: latest.runId, latestRunStatus: latest.status }
        : {}),
      deps: [...todo.deps],
      blockedByDeps,
      executable:
        blockedByDeps.length === 0 &&
        (derived.status === "pending" || derived.status === "blocked"),
    };
  });
}

// ─────────────────────────── 存储契约（只定义，不实现） ───────────────────────────

/**
 * Todo 存储契约。共享层不实现任何 I/O——各端适配层实现：
 * - CLI：落本地文件（如 ~/.nolo/todos.json）；
 * - server：落 DB；
 * - web：走后端 API。
 * 各端实现时负责把 run 记录映射成 TodoRunSummary 喂给推导函数。
 */
export interface TodoStore {
  getTodo(id: string): Promise<TodoRecord | undefined>;
  listTodos(filter?: { statuses?: TodoStatus[] }): Promise<TodoRecord[]>;
  putTodo(todo: TodoRecord): Promise<void>;
  deleteTodo(id: string): Promise<void>;
}

// ─────────────────────────── 内部工具（纯函数） ───────────────────────────

/** 依赖满足 = 依赖的 todo 已完成或已放弃（放弃视为不再阻塞）。 */
export function isDepMet(depStatus: TodoStatus): boolean {
  return depStatus === "done" || depStatus === "abandoned";
}

function toEpochMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/** run 先后判定：优先 finishedAt，其次 startedAt，都缺省按数组顺序（越靠后越新）。 */
function latestRun(runs: TodoRunSummary[]): TodoRunSummary | undefined {
  let latest: TodoRunSummary | undefined;
  let latestScore = -1;
  for (const run of runs) {
    const score =
      toEpochMs(run.finishedAt) ?? toEpochMs(run.startedAt) ?? -1;
    // 同分时后出现的（数组更靠后 = runIds 更靠后 = 更晚派发）胜出。
    if (latest === undefined || score >= latestScore) {
      latest = run;
      latestScore = score;
    }
  }
  return latest;
}

/** 折叠空白 + 截断到上限；空串返回 undefined。纯函数，不读任何外部状态。 */
function clipSummary(
  text: string | undefined,
  max: number
): string | undefined {
  if (!text) return undefined;
  const folded = text.replace(/\s+/g, " ").trim();
  if (folded.length === 0) return undefined;
  return folded.length > max ? `${folded.slice(0, max - 1)}…` : folded;
}

/** 按状态生成一行结论式摘要（结论优先，长度受限，无色纯文本）。 */
function summarizeTodo(
  todo: TodoRecord,
  derived: DerivedTodoStatus,
  blockedByDeps: string[],
  runs: TodoRunSummary[],
  max: number
): string {
  let text: string;
  switch (derived.status) {
    case "abandoned":
      text = "已放弃";
      break;
    case "done":
      text = `完成 · 共 ${runs.length} 次 run`;
      break;
    case "running": {
      const latest = derived.latestRun;
      const who =
        latest?.agentName ?? (latest ? shortRunId(latest.runId) : "");
      text = `运行中 · 第 ${runs.length} 次 run${who ? ` · ${who}` : ""}`;
      break;
    }
    case "blocked":
      text = derived.blockedReason
        ? `被 BLOCK · ${derived.blockedReason}`
        : "被 BLOCK";
      break;
    case "pending":
    default:
      if (blockedByDeps.length > 0) {
        text = `待执行 · 等待依赖: ${blockedByDeps.join(", ")}`;
      } else if (runs.length === 0) {
        text = "待执行 · 尚未派发 run";
      } else {
        const latest = derived.latestRun;
        text = `待重派 · ${runs.length} 次 run 未成功（最近: ${
          latest?.status ?? "?"
        }）`;
      }
      break;
  }
  return clipSummary(text, max) ?? "";
}
