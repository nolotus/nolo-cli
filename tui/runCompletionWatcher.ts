/**
 * run 终态唤醒观察器——「run 干完后对话自动继续」的检测半边。
 *
 * 它解决的问题：编排 agent 派发后台 run 后，run 到达终态的那一刻模型通常
 * 不在 turn 里，没有任何机制把「它干完了」送进对话——用户只能干等，或者
 * 模型在派发后反复查状态等结果（每次查状态在 transcript 印一张状态卡片，刷屏）。
 *
 * runRegistryPoller 每秒都在读 `~/.nolo/runs/<runId>.json` 喂 dock 面板，
 * 记录里就有终态。这个模块挂在 poller 的 `onRecordsPolled` 出口上，对每
 * tick 读到的记录做「活跃→终态」转变检测，把同一次 tick 里的所有转变合并
 * 成一条结构化 child completion 内部事件（批量派 10 个 review 同时结束不该刷 10 条），
 * 交给调用方/调度器投递。
 *
 * 取舍与规则：
 * - 每个 runId 至多唤醒一次（once-per-run）。
 * - 已经被 wait:true 消费或 marked ack 的 runId 绝不重复唤醒。
 * - 首次见到即终态的 run，只有 startedAt >= watcher 创建时刻才唤醒。
 * - dialog 切换时跳过并不污染状态，恢复当前 dialog 后可正确 drain 唤醒。
 * - ephemeral 或结果缺失的 run 提供 fallback 说明，防止 readDialog 坍塌。
 */

import type { RunRecord } from "../agentRunControl";
import { readTimestamp } from "../client/agentRunSnapshot";
import {
  clipText,
  formatRunAge,
  isAgentRunTerminalStatus,
  resolveRunLabel,
} from "../ai/tools/agent/agentRunDisplayHelpers";
import {
  normalizeRunCompletionShape,
  type AgentRunCompletionShape,
  type ChildRunCompletedTurnEvent,
  type InternalTurnEvent,
} from "../core/chat/internalTurnEvent";

/** 每条 run 的 note 摘要在唤醒消息里的截断长度。 */
const WAKE_NOTE_MAX_CHARS = 300;

export type RunCompletionWatcherDeps = {
  /** 当前打开的 dialogId；只有属于当前对话的 run 才唤醒（用户切走了就跳过）。 */
  getCurrentDialogId: () => string | null;
  /** 投递唤醒事件。支持结构化 InternalTurnEvent 或文本 fallback。 */
  onWake: (event: InternalTurnEvent | string) => void;
  now?: () => number;
};

export type RunCompletionWatcher = {
  /** 喂入本 tick 读到的全部记录；对任何单条坏记录免疫。 */
  observe(records: (RunRecord | AgentRunCompletionShape | Record<string, any>)[]): void;
  /** 标记 runId 已被消费（如 wait:true），防重复唤醒。 */
  markAcknowledged(runId: string): void;
  /** 查询 runId 是否已 ack。 */
  isAcknowledged(runId: string): boolean;
  /** 清空观测与已通知状态。 */
  dispose(): void;
};

export function createRunCompletionWatcher(
  deps: RunCompletionWatcherDeps
): RunCompletionWatcher {
  const now = deps.now ?? (() => Date.now());
  const createdAt = now();
  const lastStatusByRunId = new Map<string, string>();
  const notifiedRunIds = new Set<string>();

  const describeRun = (record: RunRecord | AgentRunCompletionShape): string[] => {
    const lines = [
      `runId: ${record.runId}`,
      `agent: ${resolveRunLabel(record as any)}`,
      `status: ${record.status}`,
    ];
    if (typeof record.exitCode === "number") {
      lines.push(`exitCode: ${record.exitCode}`);
    }
    if (record.dialogId) {
      lines.push(`childDialogId: ${record.dialogId}`);
    } else if ((record as any).ephemeral) {
      lines.push(`ephemeral: true (no persisted child dialog)`);
    } else {
      lines.push(`childDialogId: missing (result unpersisted or ephemeral)`);
    }
    const duration = formatRunAge(
      {
        startedAt: readTimestamp(record.startedAt as any),
        finishedAt: readTimestamp((record as any).endedAt ?? (record as any).finishedAt),
      },
      now()
    );
    if (duration) lines.push(`duration: ${duration}`);
    const recordError =
      "error" in record && typeof record.error === "string" ? record.error : undefined;
    const note =
      typeof record.note === "string"
        ? clipText(record.note, WAKE_NOTE_MAX_CHARS)
        : typeof recordError === "string"
        ? clipText(recordError, WAKE_NOTE_MAX_CHARS)
        : "";
    if (note) lines.push(`note: ${note}`);
    const counters = record.activity?.counters;
    if (
      counters &&
      typeof counters.toolCalls === "number" &&
      typeof counters.llmCalls === "number" &&
      typeof counters.fileEdits === "number"
    ) {
      lines.push(
        `activity: ${counters.toolCalls} tool calls · ${counters.llmCalls} llm calls · ${counters.fileEdits} edits`
      );
    }
    return lines;
  };

  const buildWakeMessage = (finished: (RunRecord | AgentRunCompletionShape)[]): string => {
    const lines = [
      `【后台 run 终态通知】你派出的 ${finished.length} 条后台 run 已到达终态：`,
    ];
    for (const record of finished) {
      lines.push("", ...describeRun(record));
    }
    lines.push(
      "",
      "以上是你通过 startAgentRun 派出的后台 run 的终态通知（系统内部事件，不是用户消息）。请阅读上面的摘要并自己决定下一步：汇总结果、继续后续工作、或向用户汇报结论。需要完整输出时用 controlAgentRun(action:\"status\", runId, tailLines:30) 拉取对应 run 的日志。"
    );
    return lines.join("\n");
  };

  return {
    observe(records: (RunRecord | AgentRunCompletionShape | Record<string, any>)[]): void {
      const finished: (RunRecord | AgentRunCompletionShape)[] = [];
      const currentDialogId = deps.getCurrentDialogId();
      for (const rawRecord of records) {
        try {
          if (!rawRecord || typeof rawRecord.runId !== "string" || !rawRecord.runId) continue;
          const record = rawRecord as RunRecord;
          if (notifiedRunIds.has(record.runId)) continue;
          if (record.ack === true) {
            notifiedRunIds.add(record.runId);
            continue;
          }
          const status = record.status;
          if (typeof status !== "string") continue;
          if (record.parentDialogId !== currentDialogId) continue;
          const previous = lastStatusByRunId.get(record.runId);
          lastStatusByRunId.set(record.runId, status);
          if (!isAgentRunTerminalStatus(status)) continue;
          if (previous === undefined) {
            const startedMs = readTimestamp(record.startedAt as any);
            if (startedMs === undefined || startedMs < createdAt) continue;
          } else if (isAgentRunTerminalStatus(previous)) {
            continue;
          }
          notifiedRunIds.add(record.runId);
          finished.push(record);
        } catch {
          continue;
        }
      }
      if (finished.length === 0) return;

      const shapes = finished.map((r) => normalizeRunCompletionShape(r));
      const summaryText = buildWakeMessage(finished);
      const event: ChildRunCompletedTurnEvent = {
        kind: "child-run-completed",
        runs: shapes,
        text: summaryText,
      };

      deps.onWake(event);
    },
    markAcknowledged(runId: string): void {
      if (runId) notifiedRunIds.add(runId);
    },
    isAcknowledged(runId: string): boolean {
      return Boolean(runId && notifiedRunIds.has(runId));
    },
    dispose(): void {
      lastStatusByRunId.clear();
      notifiedRunIds.clear();
    },
  };
}
