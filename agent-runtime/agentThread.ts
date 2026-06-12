export const AGENT_THREAD_RECORD_PREFIX = "agent-thread";
export const AGENT_THREAD_INDEX_PREFIX = "agent-threadidx";

export const AGENT_THREAD_STATUSES = [
  "pending",
  "running",
  "done",
  "failed",
  "cancelled",
] as const;

export const AGENT_THREAD_ACTIVE_STATUSES = ["pending", "running"] as const;
export const AGENT_THREAD_TERMINAL_STATUSES = ["done", "failed", "cancelled"] as const;

export const AGENT_THREAD_KINDS = [
  "chat",
  "background",
  "inline",
  "handoff",
  "parallel_branch",
  "scheduled",
] as const;

export const AGENT_THREAD_PRESENTATION_INTENTS = [
  "background_handoff",
  "inline_result",
  "handoff_speaker",
  "parallel_branch",
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
