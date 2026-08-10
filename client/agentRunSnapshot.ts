/**
 * The single parser for agent-run tool results.
 *
 * Two consumers read the same `startAgentRun` / `controlAgentRun` payloads: the
 * transcript card formatter (toolOutput.ts) and the docked run panel
 * (activityIndicator.ts). They used to each JSON.parse the content into their
 * own shape, and the shapes drifted — the panel only ever subscribed to
 * `startAgentRun`, so it pinned itself to the run's *first* status and reported
 * `running` for the rest of the turn no matter what the polls said.
 *
 * One parser, one shape, both consumers. The kind tells a consumer what it is
 * looking at without re-sniffing fields.
 */

import type { LocalAgentToolEvent } from "../agent-runtime/localLoop";
import { resolveRunLabel, isAgentNameFallback } from "../ai/tools/agent/agentRunDisplayHelpers";

/**
 * 执行者此刻正在做的那一件事。
 *
 * 只有本地 run registry 提供得了——`~/.nolo/runs/<id>.json` 的 `activity`
 * 里写着它，而服务端的 status payload 和 `controlAgentRun` 的返回值都不带。
 * 所以这个字段只由 runRegistryPoller 填，解析器永远不产出它。
 *
 * `startedAt` 是绝对时刻而不是「已进行 N 毫秒」：面板每秒重绘一次，存了绝对
 * 时刻才能自己把秒数走下去，不然每一帧都在重复显示采样瞬间的那个旧数字。
 */
export type AgentRunInFlight = {
  kind: "llm" | "tool";
  name: string;
  startedAt: number;
};

export type AgentRunSnapshot = {
  runId: string;
  status: string;
  /** Display label, or undefined when the run carries no usable identity. */
  agentName?: string;
  /** Task the run was delegated, clipped by the producer. */
  taskPreview?: string;
  toolCallCount?: number;
  lastToolNames?: string[];
  lastAssistantText?: string;
  errorMessage?: string;
  logLines?: string[];
  /** Wall-clock bounds of the run, when the producer reports them. */
  startedAt?: number;
  finishedAt?: number;
  /**
   * 进行中的动作。`null` 是有意义的值——「我刚看过，它此刻空着」，用来把上一次
   * 采样留下的动作清掉；`undefined` 则是「这个来源不知道」，不该覆盖已有的值。
   */
  inFlight?: AgentRunInFlight | null;
  /** Dedupe key for the log tail — identical tails are not redrawn. */
  logKey: string;
};

/**
 * - `start`  — a run was forked (`startAgentRun`).
 * - `status` — a status poll for one run; the only foldable kind.
 * - `stop`   — the run was cancelled/killed.
 * - `gone`   — the run id is unknown to the server.
 *
 * `list` results and non-JSON content parse to `null`: they describe a set of
 * runs, not one run, so neither the fold nor the panel can act on them.
 */
export type AgentRunEventKind = "start" | "status" | "stop" | "gone";

export type ParsedAgentRunEvent = {
  kind: AgentRunEventKind;
  snapshot: AgentRunSnapshot;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readLogLines(parsed: Record<string, unknown>): string[] | undefined {
  if (Array.isArray(parsed.logLines)) return parsed.logLines as string[];
  const tail = readString(parsed.logTail);
  return tail ? tail.split("\n") : undefined;
}

/**
 * Timestamps arrive as epoch millis. Non-positive values are treated as absent:
 * a run whose clock says it started at 0 would render an age of ~56 years.
 */
export function readTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  // The CLI's local run registry stores ISO strings for some fields.
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function readToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((n): n is string => typeof n === "string" && Boolean(n.trim()));
  return names.length > 0 ? names : undefined;
}

function buildSnapshot(
  parsed: Record<string, unknown>,
  event: LocalAgentToolEvent
): AgentRunSnapshot {
  const runId =
    readString(parsed.runId) ??
    readString(event.metadata?.runId) ??
    "";
  // runId is deliberately left out of the label chain: it is carried as its own
  // field and rendered as a `#abc12345` suffix, so resolving the label to it
  // would print the same id twice.
  const label = resolveRunLabel({
    agentName: parsed.agentName,
    name: parsed.name,
    agentKey: parsed.agentKey,
  });
  const logLines = readLogLines(parsed);
  const taskPreview = readString(parsed.taskPreview);
  const lastToolNames = readToolNames(parsed.lastToolNames);
  const lastAssistantText = readString(parsed.lastAssistantText);
  const errorMessage = readString(parsed.errorMessage);
  const startedAt = readTimestamp(parsed.startedAt);
  // The CLI's local run registry calls the end `endedAt`; the server calls it
  // `finishedAt`. Same fact, two producers.
  const finishedAt = readTimestamp(parsed.finishedAt) ?? readTimestamp(parsed.endedAt);
  return {
    runId,
    status: readString(parsed.status) ?? "running",
    // The literal `agent` fallback is dropped here rather than at each render
    // site: an unnamed run should render no name row, not the word "agent".
    ...(isAgentNameFallback(label) ? {} : { agentName: label }),
    ...(taskPreview ? { taskPreview } : {}),
    ...(typeof parsed.toolCallCount === "number" && Number.isFinite(parsed.toolCallCount)
      ? { toolCallCount: parsed.toolCallCount }
      : {}),
    ...(lastToolNames ? { lastToolNames } : {}),
    ...(lastAssistantText ? { lastAssistantText } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(logLines ? { logLines } : {}),
    logKey: logLines && logLines.length > 0 ? logLines.join("\n") : "",
  };
}

const STOP_STATUSES = new Set(["killed", "cancelled", "cancelling"]);

/**
 * Parse a `startAgentRun` / `controlAgentRun` tool-result into a run snapshot.
 * Returns null for anything that is not a single-run report.
 */
export function parseAgentRunEvent(event: LocalAgentToolEvent): ParsedAgentRunEvent | null {
  if (event.type !== "tool-result") return null;
  if (event.toolName !== "startAgentRun" && event.toolName !== "controlAgentRun") {
    return null;
  }
  const raw = typeof event.content === "string" ? event.content.trim() : "";
  if (!raw.startsWith("{")) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  // `list` reports a set of runs; there is no single run to fold or pin.
  if (Array.isArray(parsed.runs)) return null;

  const snapshot = buildSnapshot(parsed, event);
  const status = readString(parsed.status);

  if (event.toolName === "startAgentRun") {
    if (!snapshot.runId) return null;
    return { kind: "start", snapshot };
  }

  if (parsed.found === false || status === "not_found") {
    return { kind: "gone", snapshot: { ...snapshot, status: "not_found" } };
  }
  if (status && STOP_STATUSES.has(status)) {
    return { kind: "stop", snapshot };
  }
  // A status poll with no status field tells us nothing worth rendering.
  if (!status) return null;
  if (!snapshot.runId) return null;
  return { kind: "status", snapshot };
}
