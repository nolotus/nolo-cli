export function getAgentRunStatusIcon(status: string): string {
  switch (status) {
    case "running":
    case "pending":
      return "⏳";
    case "done":
      return "✓";
    case "failed":
    case "timeout":
      return "✗";
    case "killed":
    case "cancelled":
    case "cancelling":
      return "🛑";
    case "not_found":
    default:
      return "?";
  }
}

/**
 * Optional localized labels for run cards.
 * `packages/ai` keeps English defaults; CLI injects zh/en copy so this
 * module never depends on `packages/cli`.
 */
export type AgentRunDisplayLabels = {
  runStatus?: string;
  runStarted?: string;
  runStopped?: string;
  logTail?: string;
  /** Header for list cards, e.g. `Runs (3)` / `运行 (3)`. */
  runs?: (count: number) => string;
};

const DEFAULT_LABELS = {
  runStatus: "Run status",
  runStarted: "Run started",
  runStopped: "Run stopped",
  logTail: "Log tail:",
  runs: (count: number) => `Runs (${count})`,
} as const;

function resolveLabels(labels?: AgentRunDisplayLabels) {
  return {
    runStatus: labels?.runStatus ?? DEFAULT_LABELS.runStatus,
    runStarted: labels?.runStarted ?? DEFAULT_LABELS.runStarted,
    runStopped: labels?.runStopped ?? DEFAULT_LABELS.runStopped,
    logTail: labels?.logTail ?? DEFAULT_LABELS.logTail,
    runs: labels?.runs ?? DEFAULT_LABELS.runs,
  };
}

/** True when the name is missing or the literal `"agent"` fallback. */
export function isAgentNameFallback(agentName: string | undefined | null): boolean {
  const trimmed = typeof agentName === "string" ? agentName.trim() : "";
  return !trimmed || trimmed === "agent";
}

/** The identity fields a run may carry, in descending display preference. */
export type RunLabelFields = {
  agentName?: unknown;
  name?: unknown;
  agentKey?: unknown;
  runId?: unknown;
};

/**
 * Pick the most identifying label available for a run.
 *
 * `agentName` is optional everywhere (startAgentRun only requires `agentKey`),
 * so anything rendered off `agentName` alone degrades to a screen of identical
 * `agent` rows. `agentKey` is present on every run record and `runId` is
 * unique, so both are strictly better fallbacks than the literal.
 *
 * Returns the literal `"agent"` only when a run carries no identity at all —
 * that keeps `isAgentNameFallback(resolveRunLabel(run))` true, which is how the
 * card formatters decide to drop the name row entirely.
 *
 * Fields are typed `unknown` because callers hand over raw parsed JSON.
 */
export function resolveRunLabel(run: RunLabelFields): string {
  for (const candidate of [run.agentName, run.name, run.agentKey, run.runId]) {
    if (typeof candidate === "string" && !isAgentNameFallback(candidate)) {
      return candidate.trim();
    }
  }
  return "agent";
}

export function formatStartRunCard(
  agentName: string,
  status: string = "running",
  labels?: AgentRunDisplayLabels
): string {
  const L = resolveLabels(labels);
  const icon = getAgentRunStatusIcon(status);
  const lines = [L.runStarted];
  if (!isAgentNameFallback(agentName)) {
    lines.push(`  agent   ${agentName}`);
  }
  lines.push(`  status  ${icon} ${status}`);
  return lines.join("\n");
}

export function formatStatusRunCard(
  agentName: string,
  status: string = "running",
  opts?: {
    lastToolNames?: string[];
    toolCallCount?: number;
    errorMessage?: string;
    logLines?: string[];
    /** Folded consecutive polls for the same runId. */
    pollCount?: number;
    /** Latest poll tool elapsedMs. */
    elapsedMs?: number;
    /** When false, omit the Log tail section (unchanged since last emit). */
    includeLogTail?: boolean;
    labels?: AgentRunDisplayLabels;
  }
): string {
  const L = resolveLabels(opts?.labels);
  const icon = getAgentRunStatusIcon(status);
  const lines = [L.runStatus, `  ${icon} ${status}`];
  // Never render `agent   agent` — skip the row when the name is the fallback.
  if (!isAgentNameFallback(agentName)) {
    lines.push(`  agent   ${agentName}`);
  }
  if (opts?.pollCount !== undefined && opts.pollCount > 0) {
    lines.push(`  polls   ${opts.pollCount}`);
  }
  if (typeof opts?.elapsedMs === "number" && Number.isFinite(opts.elapsedMs)) {
    lines.push(`  last    ${Math.round(opts.elapsedMs)}ms`);
  }
  if (opts?.lastToolNames && opts.lastToolNames.length > 0) {
    lines.push(`  lastTools ${opts.lastToolNames.join(", ")}`);
  }
  if (opts?.toolCallCount !== undefined) {
    lines.push(`  toolCalls ${opts.toolCallCount}`);
  }
  if (opts?.errorMessage?.trim()) {
    lines.push(`  error   ${opts.errorMessage.trim()}`);
  }
  const includeLog = opts?.includeLogTail !== false;
  if (includeLog && opts?.logLines && opts.logLines.length > 0) {
    lines.push("", L.logTail, ...opts.logLines.map((l) => `  ${l}`));
  }
  return lines.join("\n");
}

export function formatStopRunCard(
  status: string = "killed",
  labels?: AgentRunDisplayLabels
): string {
  const L = resolveLabels(labels);
  const icon = getAgentRunStatusIcon(status);
  return `${L.runStopped}\n  ${icon} ${status}`;
}

export function formatListRunsCard(
  runs: Array<RunLabelFields & { status?: string }>,
  labels?: AgentRunDisplayLabels
): string {
  const L = resolveLabels(labels);
  const lines = [L.runs(runs.length)];
  for (const run of runs) {
    const status = run.status ?? "—";
    const icon = getAgentRunStatusIcon(status);
    // runId stays out of the card by design (c88e918d0): it is noise next to a
    // readable name and callers act on `rawData.runs[].runId` anyway.
    lines.push(`  ${icon}  ${resolveRunLabel(run)}`);
  }
  return lines.join("\n");
}

export function formatNotFoundRunCard(labels?: AgentRunDisplayLabels): string {
  const L = resolveLabels(labels);
  return `${L.runStatus}\n  ? not_found`;
}

/** Not exported: `isAgentRunTerminalStatus` is the only intended entry point. */
const AGENT_RUN_TERMINAL_STATUSES = new Set([
  "done",
  "failed",
  "timeout",
  "killed",
  "cancelled",
]);

export function isAgentRunTerminalStatus(status: string | undefined): boolean {
  return typeof status === "string" && AGENT_RUN_TERMINAL_STATUSES.has(status);
}
