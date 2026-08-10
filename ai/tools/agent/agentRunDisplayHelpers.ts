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
    case "orphaned":
      // Distinct from killed: the process vanished without writing a terminal
      // status (OOM/crash/network). A ghost icon signals "we inferred death".
      return "👻";
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
  runFinished?: string;
  logTail?: string;
  /** Header for list cards, e.g. `Runs (3)` / `运行 (3)`. */
  runs?: (count: number) => string;
};

const DEFAULT_LABELS = {
  runStatus: "Run status",
  runStarted: "Run started",
  runStopped: "Run stopped",
  runFinished: "Run finished",
  logTail: "Log tail:",
  runs: (count: number) => `Runs (${count})`,
} as const;

function resolveLabels(labels?: AgentRunDisplayLabels) {
  return {
    runStatus: labels?.runStatus ?? DEFAULT_LABELS.runStatus,
    runStarted: labels?.runStarted ?? DEFAULT_LABELS.runStarted,
    runStopped: labels?.runStopped ?? DEFAULT_LABELS.runStopped,
    runFinished: labels?.runFinished ?? DEFAULT_LABELS.runFinished,
    logTail: labels?.logTail ?? DEFAULT_LABELS.logTail,
    runs: labels?.runs ?? DEFAULT_LABELS.runs,
  };
}

/** Short form used to tell parallel runs apart in cards and panels. */
export function shortRunId(runId: string | undefined | null): string {
  const trimmed = typeof runId === "string" ? runId.trim() : "";
  if (!trimmed) return "";
  // Every id scheme here is time-prefixed — `run-<ISO>-<rand>` from the CLI's
  // local registry, ULID/UUIDv7 from the server — so the entropy sits at the
  // END. A leading slice collapses everything started in the same period onto
  // one string: real local runs all rendered as `run-2026`, which is precisely
  // no disambiguation at all. Prefer the trailing unique segment.
  const segments = trimmed.split("-").filter(Boolean);
  let pick = segments[segments.length - 1] ?? trimmed;
  // A very short trailing segment on its own reads as noise (`1`), and slicing
  // the raw id instead would cut mid-token (`n-fold-1`); widening to the last
  // two segments keeps it readable and still unique.
  if (pick.length < 4 && segments.length >= 2) pick = segments.slice(-2).join("-");
  if (!pick) pick = trimmed;
  return pick.length > 8 ? pick.slice(-8) : pick;
}

/** 折叠空白并截断到 max（含省略号）。卡片和面板共用同一把尺子。 */
export function clipText(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** How long a run has been going, or how long it took once it ended. */
export type RunTiming = {
  startedAt?: number;
  finishedAt?: number;
};

/**
 * `12s` / `2m14s` / `1h04m` — a duration a reader can compare against their own
 * sense of how long they have been waiting.
 *
 * Seconds are dropped past the hour mark: at that scale the precision is noise,
 * and the row has to stay one terminal line.
 */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m${String(totalSec % 60).padStart(2, "0")}s`;
  return `${Math.floor(totalMin / 60)}h${String(totalMin % 60).padStart(2, "0")}m`;
}

/**
 * Age of a run: wall time since it started, frozen at `finishedAt` once it ends.
 *
 * Returns "" when the run reports no start time — an absent duration is better
 * than a wrong one, and older servers do not send the field.
 */
export function formatRunAge(timing: RunTiming | undefined, now: number = Date.now()): string {
  const startedAt = timing?.startedAt;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt <= 0) {
    return "";
  }
  const end =
    typeof timing?.finishedAt === "number" && Number.isFinite(timing.finishedAt) && timing.finishedAt > 0
      ? timing.finishedAt
      : now;
  return formatDuration(end - startedAt);
}

/**
 * `agent   <name>  #<runId>` — the row that lets a reader tell two concurrent
 * runs apart. Either half may be missing; an empty result means the run
 * carries no identity at all and the row is dropped by the callers.
 */
function formatIdentityRow(agentName: string, runId?: string): string {
  const parts: string[] = [];
  if (!isAgentNameFallback(agentName)) parts.push(agentName);
  const short = shortRunId(runId);
  if (short) parts.push(`#${short}`);
  return parts.join("  ");
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
  opts?: {
    /** Delegated task text — the only thing that tells two runs apart on sight. */
    task?: string;
    runId?: string;
    labels?: AgentRunDisplayLabels;
  }
): string {
  const L = resolveLabels(opts?.labels);
  const icon = getAgentRunStatusIcon(status);
  const lines = [L.runStarted];
  const identity = formatIdentityRow(agentName, opts?.runId);
  if (identity) {
    lines.push(`  agent   ${identity}`);
  }
  lines.push(`  status  ${icon} ${status}`);
  const task = opts?.task?.trim();
  if (task) {
    lines.push(`  task    ${clipText(task, TASK_PREVIEW_MAX)}`);
  }
  return lines.join("\n");
}

/** Card rows stay one terminal line; long text is clipped, never wrapped. */
export const TASK_PREVIEW_MAX = 72;
const NOTE_PREVIEW_MAX = 72;

/**
 * Progress row: `12 tools · read, grep`. Both halves are optional — the run may
 * report a count with no names yet, or names with no count.
 *
 * Deliberately absent: poll count and poll round-trip time. Both describe the
 * *observer* (how often the model checked, how fast the status endpoint
 * answered), not the run, and the round-trip reads as the run's own duration —
 * a 2ms figure next to a two-minute run. Per-poll timing still exists in
 * verbose tool-trace mode, which is where observer detail belongs.
 */
function formatProgressRow(
  toolCallCount?: number,
  lastToolNames?: string[]
): string {
  const parts: string[] = [];
  if (typeof toolCallCount === "number" && Number.isFinite(toolCallCount)) {
    parts.push(`${toolCallCount} tools`);
  }
  if (lastToolNames && lastToolNames.length > 0) {
    parts.push(lastToolNames.join(", "));
  }
  return parts.join(" · ");
}

export function formatStatusRunCard(
  agentName: string,
  status: string = "running",
  opts?: {
    lastToolNames?: string[];
    toolCallCount?: number;
    /** Latest assistant sentence from the run — the cheapest "what is it doing". */
    lastAssistantText?: string;
    errorMessage?: string;
    logLines?: string[];
    runId?: string;
    timing?: RunTiming;
    /** When false, omit the Log tail section (unchanged since last emit). */
    includeLogTail?: boolean;
    now?: number;
    labels?: AgentRunDisplayLabels;
  }
): string {
  const L = resolveLabels(opts?.labels);
  const icon = getAgentRunStatusIcon(status);
  const age = formatRunAge(opts?.timing, opts?.now);
  // Age sits on the status line rather than in its own row: "how long has this
  // been going" is read together with "is it still going", not separately.
  const lines = [L.runStatus, `  ${icon} ${status}${age ? `   ${age}` : ""}`];
  // Never render `agent   agent` — skip the row when there is no identity.
  const identity = formatIdentityRow(agentName, opts?.runId);
  if (identity) {
    lines.push(`  agent   ${identity}`);
  }
  const progress = formatProgressRow(opts?.toolCallCount, opts?.lastToolNames);
  if (progress) {
    lines.push(`  tools   ${progress}`);
  }
  const note = opts?.lastAssistantText?.trim();
  if (note) {
    lines.push(`  note    ${clipText(note, NOTE_PREVIEW_MAX)}`);
  }
  if (opts?.errorMessage?.trim()) {
    lines.push(`  error   ${opts.errorMessage.trim()}`);
  }
  if (shouldShowLogTail(status, opts?.includeLogTail, opts?.logLines)) {
    lines.push("", L.logTail, ...opts!.logLines!.map((l) => `  ${l}`));
  }
  return lines.join("\n");
}

/**
 * Raw stdout is shown only when the run went wrong.
 *
 * On a healthy run the tail is the sub-agent's process output — half-written
 * JSON, provider chatter, whatever byte sequence happened to land last — and it
 * pushed the rows a reader actually needs off the card. `tools` and `note` say
 * what a running agent is doing; the log says it only by accident. When a run
 * fails the same bytes become the most useful thing on screen, so they come
 * back, unfiltered: a truncated `DATA_CLONE_ERR: 25,` is noise beside a running
 * run and evidence beside a failed one, and no heuristic can tell those apart
 * without also discarding real diagnostics.
 */
export function runShowsLogTail(status: string): boolean {
  return status === "failed" || status === "timeout";
}

function shouldShowLogTail(
  status: string,
  includeLogTail: boolean | undefined,
  logLines: string[] | undefined
): boolean {
  if (includeLogTail === false) return false;
  if (!logLines || logLines.length === 0) return false;
  return runShowsLogTail(status);
}

/**
 * The card a run gets when it ends: outcome, how long it took, what it did, and
 * what it said last. A run reaching `done` used to produce no distinct output at
 * all — the last status poll simply stopped saying `running`, so the moment a
 * background run finished was the one moment it was invisible.
 */
export function formatFinishedRunCard(
  agentName: string,
  status: string,
  opts?: {
    runId?: string;
    toolCallCount?: number;
    lastToolNames?: string[];
    lastAssistantText?: string;
    errorMessage?: string;
    logLines?: string[];
    timing?: RunTiming;
    /** When false, omit the Log tail section (unchanged since last emit). */
    includeLogTail?: boolean;
    now?: number;
    labels?: AgentRunDisplayLabels;
  }
): string {
  const L = resolveLabels(opts?.labels);
  const icon = getAgentRunStatusIcon(status);
  const age = formatRunAge(opts?.timing, opts?.now);
  const summary = [status, age, formatProgressRow(opts?.toolCallCount, opts?.lastToolNames)]
    .filter(Boolean)
    .join(" · ");
  const lines = [L.runFinished, `  ${icon} ${summary}`];
  const identity = formatIdentityRow(agentName, opts?.runId);
  if (identity) {
    lines.push(`  agent   ${identity}`);
  }
  const note = opts?.lastAssistantText?.trim();
  if (note) {
    lines.push(`  note    ${clipText(note, NOTE_PREVIEW_MAX)}`);
  }
  if (opts?.errorMessage?.trim()) {
    lines.push(`  error   ${opts.errorMessage.trim()}`);
  }
  if (shouldShowLogTail(status, opts?.includeLogTail, opts?.logLines)) {
    lines.push("", L.logTail, ...opts!.logLines!.map((l) => `  ${l}`));
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
  // orphaned: pid gone but the run record was still "running" — the process
  // died (killed/OOM/crashed) before writing its own terminal status. Treated
  // as terminal by all display/filter/GC consumers.
  "orphaned",
]);

export function isAgentRunTerminalStatus(status: string | undefined): boolean {
  return typeof status === "string" && AGENT_RUN_TERMINAL_STATUSES.has(status);
}
