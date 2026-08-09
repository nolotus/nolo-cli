// packages/chat/dialog/childRunObserverState.ts
// Pure helpers for the parent-dialog child-run observer (evidence projection).

import type {
  ClientAgentThread,
  ClientAgentThreadStatus,
  ClientAgentThreadsResponse,
  AgentThreadRuntimeEvidence,
} from "../../ai/agent/web/agentDisplayUtils";
import { asOptionalTrimmedString } from "../../core/optionalString";

export type ChildRunObserverLoadState =
  | "idle"
  | "loading"
  | "ready"
  | "error"
  | "empty";

export type ChildRunObserverViewModel = {
  loadState: ChildRunObserverLoadState;
  threads: ClientAgentThread[];
  errorMessage: string | null;
};

export type ChildRunDetailMessage = {
  id: string;
  role?: string;
  content: string;
  createdAt?: number;
};

const ACTIVE_STATUSES = new Set<string>(["pending", "running"]);

/** Stable English defaults for pure helpers (no React/i18n dependency). */
export const DEFAULT_CHILD_RUN_STATUS_LABELS = {
  pending: "Pending",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  unknown: "Unknown",
} as const;

export type ChildRunStatusLabels = Partial<
  Record<keyof typeof DEFAULT_CHILD_RUN_STATUS_LABELS, string>
>;

export const DEFAULT_CHILD_RUN_UNTITLED_LABEL = "Child run";

export function normalizeServerOrigin(server: string | null | undefined): string {
  const trimmed = asOptionalTrimmedString(server);
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

export function buildChildThreadsQueryUrl(args: {
  serverOrigin: string;
  parentThreadId: string;
}): string {
  const origin = normalizeServerOrigin(args.serverOrigin);
  const parentThreadId = asOptionalTrimmedString(args.parentThreadId) ?? "";
  const params = new URLSearchParams({ parentThreadId });
  if (!origin) {
    return `/api/agent/threads?${params.toString()}`;
  }
  return `${origin}/api/agent/threads?${params.toString()}`;
}

export function buildDialogReadUrl(serverOrigin: string): string {
  const origin = normalizeServerOrigin(serverOrigin);
  if (!origin) return "/api/dialog-read";
  return `${origin}/api/dialog-read`;
}

/**
 * Keep only direct children of the open parent/root dialog.
 * Relationship fields are the only filter — never title/agent/space.
 */
export function filterDirectChildRuns(
  threads: readonly ClientAgentThread[] | null | undefined,
  parentThreadId: string | null | undefined,
): ClientAgentThread[] {
  const parentId = asOptionalTrimmedString(parentThreadId);
  if (!parentId || !Array.isArray(threads)) return [];

  return threads.filter((thread) => {
    const threadParent = asOptionalTrimmedString(thread.parentThreadId);
    return threadParent === parentId;
  });
}

export function sortChildRunsByUpdatedAtDesc(
  threads: readonly ClientAgentThread[],
): ClientAgentThread[] {
  return [...threads].sort((a, b) => {
    const aUpdated = typeof a.updatedAt === "number" ? a.updatedAt : 0;
    const bUpdated = typeof b.updatedAt === "number" ? b.updatedAt : 0;
    if (bUpdated !== aUpdated) return bUpdated - aUpdated;
    const aCreated = typeof a.createdAt === "number" ? a.createdAt : 0;
    const bCreated = typeof b.createdAt === "number" ? b.createdAt : 0;
    return bCreated - aCreated;
  });
}

export function parseChildThreadsResponse(
  payload: unknown,
  parentThreadId: string,
): { ok: true; threads: ClientAgentThread[] } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Invalid response" };
  }
  const record = payload as Partial<ClientAgentThreadsResponse> & {
    error?: { message?: string } | string;
  };
  if (record.ok !== true || !record.data || !Array.isArray(record.data.threads)) {
    const message =
      typeof record.error === "string"
        ? record.error
        : asOptionalTrimmedString(
            record.error && typeof record.error === "object"
              ? record.error.message
              : undefined,
          ) ?? "Failed to load child runs";
    return { ok: false, error: message };
  }

  const filtered = sortChildRunsByUpdatedAtDesc(
    filterDirectChildRuns(record.data.threads as ClientAgentThread[], parentThreadId),
  );
  return { ok: true, threads: filtered };
}

export function resolveChildRunLoadState(args: {
  isLoading: boolean;
  errorMessage: string | null;
  threads: readonly ClientAgentThread[];
  hasLoadedOnce: boolean;
}): ChildRunObserverLoadState {
  if (args.isLoading && !args.hasLoadedOnce) return "loading";
  if (args.errorMessage && args.threads.length === 0) return "error";
  if (args.hasLoadedOnce && args.threads.length === 0) return "empty";
  if (args.threads.length > 0) return "ready";
  return "idle";
}

export function hasActiveChildRuns(
  threads: readonly ClientAgentThread[],
): boolean {
  return threads.some((thread) => ACTIVE_STATUSES.has(thread.status));
}

/** Light refresh only while at least one child is active; no hidden long loop. */
export function shouldPollChildRuns(
  threads: readonly ClientAgentThread[],
): boolean {
  return hasActiveChildRuns(threads);
}

export function formatChildRunStatusLabel(
  status: ClientAgentThreadStatus | string | null | undefined,
  labels: ChildRunStatusLabels = {},
): string {
  const key = asOptionalTrimmedString(status) ?? "";
  const resolved = { ...DEFAULT_CHILD_RUN_STATUS_LABELS, ...labels };
  if (key && key in resolved) {
    return resolved[key as keyof typeof resolved] ?? key;
  }
  return key || resolved.unknown;
}

export function isTerminalChildRunStatus(
  status: ClientAgentThreadStatus | string | null | undefined,
): boolean {
  const key = asOptionalTrimmedString(status) ?? "";
  return key === "done" || key === "failed" || key === "cancelled";
}

export function isFailedChildRunStatus(
  status: ClientAgentThreadStatus | string | null | undefined,
): boolean {
  return asOptionalTrimmedString(status) === "failed";
}

export function resolveChildRunTitle(
  thread: { title?: string | null; primaryAgentKey?: string | null; threadId: string },
  untitledLabel: string = DEFAULT_CHILD_RUN_UNTITLED_LABEL,
): string {
  return (
    asOptionalTrimmedString(thread.title) ??
    asOptionalTrimmedString(thread.primaryAgentKey) ??
    untitledLabel
  );
}

export function resolveChildDialogId(
  thread: Pick<ClientAgentThread, "dialogId" | "threadId">,
): string {
  return (
    asOptionalTrimmedString(thread.dialogId) ??
    asOptionalTrimmedString(thread.threadId) ??
    ""
  );
}

export function resolveChildDialogKey(
  thread: Pick<ClientAgentThread, "dialogKey" | "dialogId" | "threadId">,
): string | undefined {
  return (
    asOptionalTrimmedString(thread.dialogKey) ??
    undefined
  );
}

export function formatChildRunEvidenceLine(
  evidence: AgentThreadRuntimeEvidence | undefined,
  status?: string | null,
  labels: ChildRunStatusLabels = {},
): string {
  if (!evidence) {
    return formatChildRunStatusLabel(status, labels);
  }

  const parts: string[] = [];
  const checkpointStatus =
    asOptionalTrimmedString(evidence.status) ?? asOptionalTrimmedString(status);
  if (checkpointStatus) {
    parts.push(formatChildRunStatusLabel(checkpointStatus, labels));
  }

  const lastTools = Array.isArray(evidence.lastToolNames)
    ? evidence.lastToolNames.filter(Boolean).slice(0, 2)
    : [];
  if (lastTools.length > 0) {
    parts.push(lastTools.join(", "));
  }

  const assistant = asOptionalTrimmedString(evidence.lastAssistantText);
  if (assistant) {
    const clipped =
      assistant.length > 72 ? `${assistant.slice(0, 72).trimEnd()}…` : assistant;
    parts.push(clipped);
  }

  const errorMessage = asOptionalTrimmedString(evidence.errorMessage);
  if (errorMessage) {
    const clipped =
      errorMessage.length > 72
        ? `${errorMessage.slice(0, 72).trimEnd()}…`
        : errorMessage;
    parts.push(clipped);
  }

  if (parts.length === 0) {
    return formatChildRunStatusLabel(status, labels);
  }
  // Prefer short main + secondary without repeating status twice.
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} · ${parts.slice(1).join(" · ")}`;
}

export function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const record = part as { text?: unknown; content?: unknown };
          if (typeof record.text === "string") return record.text;
          if (typeof record.content === "string") return record.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object") {
    const record = content as { text?: unknown; content?: unknown };
    if (typeof record.text === "string") return record.text.trim();
    if (typeof record.content === "string") return record.content.trim();
  }
  return "";
}

export function mapDialogReadMessages(
  msgs: unknown,
): ChildRunDetailMessage[] {
  if (!Array.isArray(msgs)) return [];
  const mapped: ChildRunDetailMessage[] = [];
  for (const raw of msgs) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as {
      id?: unknown;
      role?: unknown;
      content?: unknown;
      createdAt?: unknown;
    };
    const id = asOptionalTrimmedString(message.id);
    if (!id) continue;
    const content = extractMessageText(message.content);
    mapped.push({
      id,
      ...(asOptionalTrimmedString(message.role)
        ? { role: asOptionalTrimmedString(message.role) }
        : {}),
      content,
      ...(typeof message.createdAt === "number"
        ? { createdAt: message.createdAt }
        : {}),
    });
  }
  // dialog-read returns newest first; show chronological for reading.
  return mapped.reverse();
}

export function parseDialogReadResponse(
  payload: unknown,
):
  | {
      ok: true;
      title: string | null;
      status: string | null;
      messages: ChildRunDetailMessage[];
      meta: Record<string, unknown> | null;
    }
  | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Invalid dialog response" };
  }
  const record = payload as {
    ok?: unknown;
    error?: unknown;
    meta?: unknown;
    msgs?: unknown;
  };
  if (record.ok !== true) {
    return {
      ok: false,
      error:
        asOptionalTrimmedString(
          typeof record.error === "string" ? record.error : undefined,
        ) ?? "Failed to load child dialog",
    };
  }

  const meta =
    record.meta && typeof record.meta === "object"
      ? (record.meta as Record<string, unknown>)
      : null;
  const title =
    asOptionalTrimmedString(meta?.title) ??
    asOptionalTrimmedString(meta?.name) ??
    null;
  const status =
    asOptionalTrimmedString(meta?.status) ??
    asOptionalTrimmedString(meta?.threadStatus) ??
    null;

  return {
    ok: true,
    title,
    status,
    messages: mapDialogReadMessages(record.msgs),
    meta,
  };
}

export const CHILD_RUN_ACTIVE_POLL_MS = 8_000;
