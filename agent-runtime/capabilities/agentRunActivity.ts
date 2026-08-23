export type AgentRunActivityStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentRunActivity {
  activityId: string;
  parentActivityId?: string;
  kind: "agent-run";
  runId?: string;
  agentId?: string;
  agentName?: string;
  task?: string;
  status: AgentRunActivityStatus;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
  result?: unknown;
}

export type AgentActivityEvent =
  | { type: "activity-started"; activity: AgentRunActivity }
  | { type: "activity-updated"; activity: AgentRunActivity }
  | { type: "activity-finished"; activity: AgentRunActivity };

export type AgentActivitySink = (
  event: AgentActivityEvent,
) => void | Promise<void>;
