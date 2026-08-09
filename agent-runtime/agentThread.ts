export const AGENT_THREAD_RECORD_PREFIX = "agent-thread";
export const AGENT_THREAD_INDEX_PREFIX = "agent-threadidx";

export const AGENT_THREAD_STATUSES = [
  "pending",
  "running",
  "done",
  "failed",
  "cancelled",
  // orphaned: 进程消失但记录仍 running（OOM/crash/进程重启）。
  // 与 CLI 端 RunStatus 的 orphaned 同义——此前 server 终态集合缺这个值，
  // 导致 server 端 reconcile stale run 时只能写 cancelled，与 CLI 端
  // 写 orphaned 的语义漂移（reviewer 指出的 B 模块根因）。加入后 server
  // 端终态集合与共享层 isAgentRunTerminalStatus 含 orphaned 对齐。
  "orphaned",
] as const;

export const AGENT_THREAD_ACTIVE_STATUSES = ["pending", "running"] as const;
export const AGENT_THREAD_TERMINAL_STATUSES = ["done", "failed", "cancelled", "orphaned"] as const;

export const AGENT_THREAD_KINDS = [
  "chat",
  "background",
  "inline",
  "handoff",
  "scheduled",
] as const;

export const AGENT_THREAD_PRESENTATION_INTENTS = [
  "background_handoff",
  "inline_result",
  "handoff_speaker",
] as const;

export type AgentThreadStatus = (typeof AGENT_THREAD_STATUSES)[number];
export type AgentThreadActiveStatus =
  (typeof AGENT_THREAD_ACTIVE_STATUSES)[number];
export type AgentThreadTerminalStatus =
  (typeof AGENT_THREAD_TERMINAL_STATUSES)[number];
export type AgentThreadKind = (typeof AGENT_THREAD_KINDS)[number];
export type AgentThreadPresentationIntent =
  (typeof AGENT_THREAD_PRESENTATION_INTENTS)[number];

export type AgentThreadListSection = "running" | "future" | "recent";

export type AgentThreadSubjectRef = {
  kind: string;
  id: string;
  role?: string;
};

export type AgentThreadSchedule =
  | {
      kind: "once";
      timezone?: string;
      nextRunAt: number;
    }
  | {
      kind: "cron";
      timezone?: string;
      expression: string;
      nextRunAt: number;
    }
  | {
      kind: "interval";
      timezone?: string;
      everyMs: number;
      nextRunAt: number;
    };

export type AgentThreadEvidence = {
  kind: string;
  summary?: string;
  refs?: AgentThreadSubjectRef[];
  data?: Record<string, unknown>;
};

export type AgentThreadRuntimeCheckpoint = {
  status?: string;
  toolCallCount?: number;
  traceSummary?: unknown;
  lastToolNames?: string[];
  lastAssistantText?: string;
  evidence?: AgentThreadEvidence[];
  policyState?: unknown;
  runtimeBinding?: unknown;
  errorMessage?: string;
};

export type AgentThread = {
  threadId: string;
  title?: string;
  summary?: string;

  primaryAgentKey: string;
  agentKeys: string[];
  userId: string;

  status: AgentThreadStatus;
  threadKind: AgentThreadKind;
  presentationIntent?: AgentThreadPresentationIntent;

  parentThreadId?: string;
  rootThreadId?: string;

  dialogId?: string;
  dialogKey?: string;

  /**
   * Optional batch id grouping this run with siblings (CLI + server share the
   * same semantics). Persisted on the thread so handleList can filter by batch
   * and runOverlayMachine can aggregate cross-end. Absent on legacy records →
   * undefined (no extra storage layer, schema-compatible with old data).
   */
  batchId?: string;

  subjectRefs?: AgentThreadSubjectRef[];

  schedule?: AgentThreadSchedule;
  lastRunThreadId?: string;

  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;

  runtimeCheckpoint?: AgentThreadRuntimeCheckpoint;
};

export function buildAgentThreadKey(args: {
  userId: string;
  threadId: string;
}): string {
  return [AGENT_THREAD_RECORD_PREFIX, args.userId, args.threadId].join("-");
}

export function buildAgentThreadUserRange(userId: string): {
  gte: string;
  lte: string;
} {
  const start = `${AGENT_THREAD_RECORD_PREFIX}-${userId}-`;
  return { gte: start, lte: `${start}\uffff` };
}

export function buildAgentThreadByAgentStatusIndexKey(args: {
  userId: string;
  primaryAgentKey: string;
  status: AgentThreadStatus;
  threadId: string;
}): string {
  return [
    AGENT_THREAD_INDEX_PREFIX,
    args.userId,
    "agent",
    args.primaryAgentKey,
    "status",
    args.status,
    args.threadId,
  ].join("-");
}

export function buildAgentThreadByAgentStatusRange(args: {
  userId: string;
  primaryAgentKey: string;
  status: AgentThreadStatus;
}): {
  gte: string;
  lte: string;
} {
  const start = [
    AGENT_THREAD_INDEX_PREFIX,
    args.userId,
    "agent",
    args.primaryAgentKey,
    "status",
    args.status,
    "",
  ].join("-");
  return { gte: start, lte: `${start}\uffff` };
}

export function isAgentThreadActiveStatus(
  status: string | null | undefined,
): status is AgentThreadActiveStatus {
  return (AGENT_THREAD_ACTIVE_STATUSES as readonly string[]).includes(
    status ?? "",
  );
}

export function isAgentThreadTerminalStatus(
  status: string | null | undefined,
): status is AgentThreadTerminalStatus {
  return (AGENT_THREAD_TERMINAL_STATUSES as readonly string[]).includes(
    status ?? "",
  );
}

export function isFutureAgentThread(
  thread: Pick<AgentThread, "schedule" | "status">,
  nowMs: number,
): boolean {
  return (
    isAgentThreadActiveStatus(thread.status) &&
    typeof thread.schedule?.nextRunAt === "number" &&
    thread.schedule.nextRunAt > nowMs
  );
}

export function getAgentThreadListSection(
  thread: Pick<AgentThread, "schedule" | "status">,
  nowMs: number,
): AgentThreadListSection {
  if (isFutureAgentThread(thread, nowMs)) return "future";
  if (isAgentThreadActiveStatus(thread.status)) return "running";
  return "recent";
}

export function getAgentThreadRootId(
  thread: Pick<AgentThread, "threadId" | "parentThreadId" | "rootThreadId">,
): string {
  return thread.rootThreadId || thread.parentThreadId || thread.threadId;
}

export function buildChildAgentThreadRelations(
  parent: Pick<AgentThread, "threadId" | "rootThreadId">,
): {
  parentThreadId: string;
  rootThreadId: string;
} {
  return {
    parentThreadId: parent.threadId,
    rootThreadId: parent.rootThreadId || parent.threadId,
  };
}
