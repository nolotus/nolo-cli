// packages/core/chat/runOverlayPresentation.ts
//
// Pure presentation builder for the run-overlay snapshot. Takes the machine's
// current state and produces a single human-readable string (or null when there
// is nothing to show). No React, no DOM, no side effects — the adapter decides
// where to render it (TUI stdout, web toast, desktop overlay).
//
// Snapshot mode: we render every run currently in the map, grouped by status.
// There is no "new since last present" concept here.

import type { RunInfo, RunOverlayState, RunStatus } from "./runOverlayMachine";

/** Display order for the status groups. Omitted statuses are skipped. */
const STATUS_ORDER: RunStatus[] = [
  "running",
  "reviewing",
  "testing",
  "done",
  "failed",
  "cancelled",
  "orphaned",
];

/** Icon + Chinese label for each status, used both in the group header and the detail line. */
const STATUS_DISPLAY: Record<RunStatus, { icon: string; label: string }> = {
  running: { icon: "▶", label: "正在运行" },
  reviewing: { icon: "👁", label: "待 review" },
  testing: { icon: "🧪", label: "在测试" },
  done: { icon: "✅", label: "已完成" },
  failed: { icon: "❌", label: "失败" },
  cancelled: { icon: "⏹", label: "已取消" },
  orphaned: { icon: "👻", label: "孤儿" },
};

export type GroupedRuns = {
  status: RunStatus;
  runs: RunInfo[];
}[];

/**
 * Localize a status into its display label (e.g. "running" -> "正在运行").
 * Exported for tests and for adapters that build their own presentation.
 */
export function statusLabel(status: string): string {
  return STATUS_DISPLAY[status as RunStatus]?.label ?? status;
}

/**
 * Group runs by status, in canonical display order. Runs with the same status
 * keep their Map insertion order. Exported for tests.
 */
export function groupByStatus(runs: Map<string, RunInfo>): GroupedRuns {
  const buckets = new Map<RunStatus, RunInfo[]>();
  for (const run of runs.values()) {
    const arr = buckets.get(run.status);
    if (arr) arr.push(run);
    else buckets.set(run.status, [run]);
  }
  const grouped: GroupedRuns = [];
  for (const status of STATUS_ORDER) {
    const arr = buckets.get(status);
    if (arr && arr.length > 0) grouped.push({ status, runs: arr });
  }
  return grouped;
}

/**
 * Build the overlay presentation string for the current state.
 *
 * Returns null when there are no runs (nothing to render — the adapter should
 * hide the overlay rather than show an empty block).
 *
 * Format:
 *   ▶ 5 个正在运行
 *   👁 3 个待 review
 *   ...
 *
 *   --- 详情 ---
 *   • run-001 (评审文件A): 运行中
 *   • run-002 (评审文件B): 待 review — 需要确认 API 变更
 */
export function buildOverlayPresentation(state: RunOverlayState): string | null {
  if (state.runs.size === 0) return null;

  const grouped = groupByStatus(state.runs);
  const lines: string[] = [];

  for (const { status, runs } of grouped) {
    const { icon, label } = STATUS_DISPLAY[status];
    lines.push(`${icon} ${runs.length} 个${label}`);
  }

  lines.push("");
  lines.push("--- 详情 ---");

  for (const { runs } of grouped) {
    for (const run of runs) {
      lines.push(detailLine(run));
    }
  }

  return lines.join("\n");
}

/**
 * One detail line per run. Status suffix is the short label ("运行中" etc.),
 * followed by ` — <summary>` when a summary exists, and ` — <errorMessage>`
 * when the run failed and an error message is present.
 *
 * The short status text intentionally differs slightly from the group label
 * to read naturally in a list ("运行中" vs header "正在运行").
 */
function detailLine(run: RunInfo): string {
  const short = shortStatusLabel(run.status);
  let suffix = short;
  if (run.summary) suffix += ` — ${run.summary}`;
  else if (run.status === "failed" && run.errorMessage) suffix += ` — ${run.errorMessage}`;
  return `• ${run.runId} (${run.name}): ${suffix}`;
}

const SHORT_STATUS_LABEL: Record<RunStatus, string> = {
  running: "运行中",
  reviewing: "待 review",
  testing: "测试中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
  orphaned: "孤儿",
};

function shortStatusLabel(status: RunStatus): string {
  return SHORT_STATUS_LABEL[status];
}