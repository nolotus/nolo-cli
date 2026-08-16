// packages/core/chat/internalTurnEvent.ts
//
// Structured turn events and turn request models for chat queue and sub-agent
// completion wake events.

export type AgentRunCompletionShape = {
  runId: string;
  agentKey: string;
  agentName?: string;
  status: string; // "done" | "failed" | "timeout" | "killed" | "orphaned" | etc.
  exitCode?: number;
  parentDialogId?: string;
  dialogId?: string;
  ephemeral?: boolean;
  startedAt?: string | number;
  endedAt?: string | number;
  note?: string;
  error?: string;
  ack?: boolean;
  ackLease?: { token: string; claimedAt: number; ttlMs: number };
  activity?: {
    counters?: {
      toolCalls?: number;
      llmCalls?: number;
      fileEdits?: number;
    };
  };
};

export type ChildRunCompletedTurnEvent = {
  kind: "child-run-completed";
  runs: AgentRunCompletionShape[];
  /** 送进模型上下文的完整摘要。 */
  text: string;
  /**
   * 屏幕上要显示的紧凑单行（transcript / 队列预览）。
   *
   * 终态唤醒是 out-of-band 的系统事件，不是用户消息：完整摘要只该进模型
   * 上下文，屏幕上一行就够（详情本来就在 dock 面板和子 dialog 里）。缺省
   * 时调用方回落到 text。
   */
  displayText?: string;
};

export type UserTurnEvent = {
  kind: "user";
  text: string;
};

export type InternalTurnEvent = UserTurnEvent | ChildRunCompletedTurnEvent;

export type TurnRequest = {
  event: InternalTurnEvent;
  text: string;
};

/**
 * Normalizes a local RunRecord or generic run completion object into a minimal
 * completion shape for watcher and scheduler consumption.
 */
export function normalizeRunCompletionShape(
  record: Record<string, any>
): AgentRunCompletionShape {
  const runId = String(record.runId ?? record.id ?? "");
  const agentKey = String(record.agentKey ?? record.agent ?? "");
  const status = String(record.status ?? "done");
  const counters = record.activity?.counters;
  return {
    runId,
    agentKey,
    ...(typeof record.agentName === "string" ? { agentName: record.agentName } : {}),
    status,
    ...(typeof record.exitCode === "number" ? { exitCode: record.exitCode } : {}),
    ...(typeof record.parentDialogId === "string" ? { parentDialogId: record.parentDialogId } : {}),
    ...(typeof record.dialogId === "string" ? { dialogId: record.dialogId } : {}),
    ...(typeof record.ephemeral === "boolean" ? { ephemeral: record.ephemeral } : {}),
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(typeof record.note === "string" ? { note: record.note } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(typeof record.ack === "boolean" ? { ack: record.ack } : {}),
    ...(counters
      ? {
          activity: {
            counters: {
              toolCalls: typeof counters.toolCalls === "number" ? counters.toolCalls : 0,
              llmCalls: typeof counters.llmCalls === "number" ? counters.llmCalls : 0,
              fileEdits: typeof counters.fileEdits === "number" ? counters.fileEdits : 0,
            },
          },
        }
      : {}),
  };
}

export function createTurnRequest(input: InternalTurnEvent | TurnRequest | string): TurnRequest {
  if (typeof input === "string") {
    return {
      event: { kind: "user", text: input },
      text: input,
    };
  }
  if ("event" in input && typeof input.event === "object" && typeof input.text === "string") {
    return input as TurnRequest;
  }
  const event = input as InternalTurnEvent;
  return {
    event,
    text: event.text,
  };
}
