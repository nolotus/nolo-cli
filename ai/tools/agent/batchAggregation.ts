/**
 * 批次聚合判定（D1，跨端共享纯逻辑）
 *
 * 让编排者（父 agent / UI）不必轮询就能知道"我派的这批子任务到齐了没"。
 * 本模块只做**判定**，不做通知投递（那是 D2）。
 *
 * 硬性约束（review 重点检查）：
 * - 零 I/O：禁止任何 Node 专有 API（fs / path / child_process / 环境变量 /
 *   进程控制），禁止 CommonJS 动态加载；
 * - 禁止读取系统时钟：当前时间由入参 `now` 传入；
 * - 必须能在浏览器里直接 import 而不报错（判定规则全端只有这一份）。
 *
 * 数据来源各端自己提供（CLI 读 ~/.nolo/runs、server 读 DB、web 读 API），
 * 本模块只吃最小字段的 run 摘要，不碰完整日志。
 *
 * 唤醒策略：失败快报 + 成功批量报
 * - 出现**首个**失败 / orphaned → 立即唤醒（止损优先）；
 * - 全部进入终态 → 唤醒一次，带批次汇总；
 * - 超过批次超时阈值仍未收敛 → 唤醒一次，标记未完成者。
 *
 * 幂等：不藏可变状态。调用方传入"已通知过的原因集合" `notifiedReasons`，
 * 本函数返回"本次新增应通知的原因" `newWakeReasons`（同一原因只触发一次）。
 */
import {
  isAgentRunTerminalStatus,
  shortRunId,
} from "./agentRunDisplayHelpers";

/** 单个 run 的判定最小摘要（各端把查询结果映射成这个形状喂进来）。 */
export interface BatchRunSummary {
  runId: string;
  /** 复用 agentRunDisplayHelpers 的终态判定，status 保持 string 语义同源。 */
  status: string;
  /** ISO 时间字符串；缺省时该 run 不参与超时判定。 */
  startedAt?: string;
  /** 展示名（如 "GLM 5.2"）；缺省时摘要退化为 runId 短形式。 */
  agentName?: string;
  /** 失败原因的一句话摘要（由各端从错误里提取，不是完整日志）。 */
  errorSummary?: string;
}

/** 唤醒原因：同批次同一原因只触发一次。 */
export type BatchWakeReason = "failure" | "converged" | "timeout";

export interface BatchCounts {
  total: number;
  /** done 之外的终态都算失败类（failed/timeout/killed/cancelled/orphaned）。 */
  success: number;
  failed: number;
  /** 失败类中单独计数 orphaned，便于展示"进程凭空消失"的推断死因。 */
  orphaned: number;
  /** 仍在跑（非终态）。 */
  running: number;
}

export interface BatchAggregationResult {
  /** 回显输入批次 id。 */
  batchId: string;
  /** 全部进入终态。 */
  converged: boolean;
  /** 存在未终态 run 超过超时阈值。 */
  timedOut: boolean;
  counts: BatchCounts;
  /** 本次调用新增应唤醒的原因；空数组 = 不唤醒。 */
  newWakeReasons: BatchWakeReason[];
  /** 未终态 run 的 runId（超时唤醒时标记"未完成者"用）。 */
  unfinished: string[];
  /**
   * 本次唤醒附带的结论式摘要（无色纯文本，web 端可直接展示）；
   * 无新唤醒时为空字符串。
   */
  summary: string;
}

export interface BatchAggregationInput {
  batchId: string;
  runs: BatchRunSummary[];
  /** 当前时间（ISO 字符串，由调用方传入，禁止模块内取时钟）。 */
  now: string;
  /** 批次超时阈值（毫秒），默认 DEFAULT_BATCH_TIMEOUT_MS。 */
  timeoutMs?: number;
  /** 已通知过的原因集合（幂等的唯一依据）。 */
  notifiedReasons?: BatchWakeReason[];
}

/** 默认批次超时阈值：30 分钟。 */
export const DEFAULT_BATCH_TIMEOUT_MS = 30 * 60 * 1000;

/** 失败者错误摘要的字符上限（截断上限常量，防冲爆编排者上下文）。 */
export const MAX_ERROR_SUMMARY_CHARS = 120;

/** 摘要里最多逐行列出的失败者数量，超出部分只计数（防 N 个失败刷屏）。 */
export const MAX_FAILURE_LINES = 10;

/** done 之外的所有终态（含 orphaned）都视为失败类，触发止损快报。 */
function isFailureStatus(status: string): boolean {
  return isAgentRunTerminalStatus(status) && status !== "done";
}

function isOrphanedStatus(status: string): boolean {
  return status === "orphaned";
}

function toEpochMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function isOverTimeout(
  run: BatchRunSummary,
  nowMs: number,
  timeoutMs: number
): boolean {
  const startedMs = toEpochMs(run.startedAt);
  if (startedMs === undefined) return false; // 无开始时间，无法判定，不误报
  return nowMs - startedMs >= timeoutMs;
}

/** 单条错误摘要：折叠空白 + 截断到上限，禁止把完整日志拼进来。 */
function truncateErrorSummary(
  text: string | undefined,
  max: number = MAX_ERROR_SUMMARY_CHARS
): string {
  if (!text) return "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

/** 失败者的单行：`失败: shortId (agentName) — error`。 */
function formatFailureLine(run: BatchRunSummary): string {
  const label = shortRunId(run.runId);
  const agent = run.agentName ? ` (${run.agentName})` : "";
  const error = truncateErrorSummary(run.errorSummary);
  return error ? `失败: ${label}${agent} — ${error}` : `失败: ${label}${agent}`;
}

/**
 * 结论式摘要生成器（纯函数，无色纯文本）。
 * 按唤醒原因输出对应形态：
 * - failure：止损快报，逐行列失败者（截断错误摘要）；
 * - converged：批次汇总 + 失败者明细；
 * - timeout：标记未完成者。
 * 成功者只出现在汇总行的计数里，不逐行展开。
 */
export function formatBatchSummary(
  batchId: string,
  counts: BatchCounts,
  runs: BatchRunSummary[],
  reason: BatchWakeReason
): string {
  const failures = runs.filter((r) => isFailureStatus(r.status));
  const unfinished = runs.filter((r) => !isAgentRunTerminalStatus(r.status));

  if (reason === "timeout") {
    const lines = [
      `批次 ${batchId}: 超时未收敛 — ${counts.running} 个未完成`,
    ];
    for (const run of unfinished.slice(0, MAX_FAILURE_LINES)) {
      const agent = run.agentName ? ` (${run.agentName})` : "";
      lines.push(`未完成: ${shortRunId(run.runId)}${agent}`);
    }
    const rest = unfinished.length - MAX_FAILURE_LINES;
    if (rest > 0) lines.push(`… 及另外 ${rest} 个未完成`);
    return lines.join("\n");
  }

  // failure 与 converged 共享汇总行 + 失败明细；区别只在失败类是否已在跑。
  const tail = counts.running > 0 ? `, ${counts.running} 仍在跑` : "";
  const lines = [
    `批次 ${batchId}: ${counts.success + counts.failed}/${counts.total} 完成 — ${counts.success} 成功, ${counts.failed} 失败${tail}`,
  ];
  for (const run of failures.slice(0, MAX_FAILURE_LINES)) {
    lines.push(formatFailureLine(run));
  }
  const rest = failures.length - MAX_FAILURE_LINES;
  if (rest > 0) lines.push(`… 及另外 ${rest} 个失败`);
  return lines.join("\n");
}

/**
 * 批次聚合判定（纯函数，无副作用，浏览器可用）。
 *
 * 每次调用独立计算：输入 run 摘要 + 当前时间 + 已通知原因集合，
 * 输出"本次新增应唤醒的原因"。调用方把返回的 newWakeReasons 并入
 * notifiedReasons 后再反复调用，即可保证同一原因只触发一次——
 * 幂等完全由入参驱动，模块内部不藏任何可变状态。
 */
export function aggregateBatch(
  input: BatchAggregationInput
): BatchAggregationResult {
  const { batchId, runs, now } = input;
  const timeoutMs = input.timeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS;
  const notified = new Set(input.notifiedReasons ?? []);

  const nowMs = toEpochMs(now) ?? 0;

  let success = 0;
  let failed = 0;
  let orphaned = 0;
  let running = 0;
  const unfinished: string[] = [];
  let timedOut = false;

  for (const run of runs) {
    if (isAgentRunTerminalStatus(run.status)) {
      if (run.status === "done") success += 1;
      else {
        failed += 1;
        if (isOrphanedStatus(run.status)) orphaned += 1;
      }
    } else {
      running += 1;
      unfinished.push(run.runId);
      if (isOverTimeout(run, nowMs, timeoutMs)) timedOut = true;
    }
  }

  const converged = running === 0;

  // 唤醒优先级：止损 > 收敛汇总 > 超时标记。每次调用至多返回一个原因，
  // 未满足条件的原因留待下一次调用（notified 更新后）自然触发。
  let newWakeReasons: BatchWakeReason[] = [];
  if (failed > 0 && !notified.has("failure")) {
    newWakeReasons = ["failure"];
  } else if (converged && !notified.has("converged")) {
    newWakeReasons = ["converged"];
  } else if (timedOut && !notified.has("timeout")) {
    newWakeReasons = ["timeout"];
  }

  const counts: BatchCounts = {
    total: runs.length,
    success,
    failed,
    orphaned,
    running,
  };

  const summary =
    newWakeReasons.length > 0
      ? formatBatchSummary(batchId, counts, runs, newWakeReasons[0])
      : "";

  return {
    batchId,
    converged,
    timedOut,
    counts,
    newWakeReasons,
    unfinished,
    summary,
  };
}
