// packages/core/chat/runOverlayMachine.ts
//
// Pure run-overlay state machine — aggregates concurrent run status into a
// single snapshot the UI can render. The companion to chatQueueMachine: where
// chatQueueMachine owns *user input* ordering for one dialog, runOverlayMachine
// owns *child-run status aggregation* across many runs in one dialog.
//
// Design goals (mirrors chatQueueMachine):
//   1. Zero dependencies. No React, no Redux, no rxjs. Web/RN/TUI all share it.
//   2. Snapshot mode: every presentation shows the full current set of runs.
//      We do not track "new since last present"; the adapter renders whatever
//      is in `runs` now. Incremental mode is a later phase.
//   3. The machine never fetches run state itself. Upstream (server controlAgentRun
//      polling, CLI runs, child-dialog wake events) feeds it `run-state-chg`
//      events. The machine only reduces them to a consistent Map snapshot.
//
// Lifecycle (per run, independent):
//   absent ──run-state-chg──► present(status=X)
//   present(X) ──run-state-chg──► present(Y)   // status/summary/etc mutate
//   present ──run-removed──► absent
//   any ──clear-all──► empty Map
//
// `run-state-chg` is upsert: a runId not yet in the map is inserted; an
// existing one is merged field-by-field. The caller does not need to know
// whether the run already exists.

export type RunStatus =
  | "running"
  | "reviewing"
  | "testing"
  | "done"
  | "failed"
  | "cancelled"
  | "orphaned";

export type RunInfo = {
  runId: string;
  name: string;
  status: RunStatus;
  summary?: string;
  batchId?: string;
  parentDialogId?: string;
  errorMessage?: string;
  /** Epoch ms of the last update applied to this run. Set by the reducer. */
  updatedAt: number;
};

export type RunOverlayState = {
  /** runId -> current snapshot. Iteration order is insertion order. */
  runs: Map<string, RunInfo>;
};

export type RunOverlayInEvent =
  | { type: "run-state-chg"; runId: string; info: Partial<Omit<RunInfo, "runId" | "updatedAt">> }
  | { type: "run-removed"; runId: string }
  | { type: "clear-all" };

export type RunOverlayOutEvent =
  | { type: "overlay-changed"; runCount: number }
  | { type: "all-cleared" };

export const initialRunOverlayState: RunOverlayState = {
  runs: new Map(),
};

/**
 * Reduce one incoming event to the next state. Pure; returns the same state
 * reference when nothing changed.
 *
 * `updatedAt` is stamped by the reducer (Date.now()) on every mutating event so
 * callers never need to set it. Tests that need deterministic timestamps should
 * construct state directly rather than rely on the reducer's clock.
 */
export function reduceRunOverlay(
  state: RunOverlayState,
  event: RunOverlayInEvent
): RunOverlayState {
  switch (event.type) {
    case "run-state-chg": {
      const prev = state.runs.get(event.runId);
      const now = Date.now();
      // Upsert. For a new run we require at least a name+status; if the caller
      // omits them we fall back to "" and "running" so the snapshot is always
      // well-typed rather than Partial<RunInfo>.
      const merged: RunInfo = prev
        ? { ...prev, ...event.info, runId: event.runId, updatedAt: now }
        : {
            runId: event.runId,
            name: event.info.name ?? "",
            status: event.info.status ?? "running",
            summary: event.info.summary,
            batchId: event.info.batchId,
            parentDialogId: event.info.parentDialogId,
            errorMessage: event.info.errorMessage,
            updatedAt: now,
          };
      // No-op short-circuit: if the merge produced an identical run, keep the
      // old reference. We still bump updatedAt intentionally (the caller
      // signalled a change), so identity equality is only preserved when the
      // incoming info was empty.
      if (prev && shallowEqualRun(prev, merged)) {
        return state;
      }
      const runs = new Map(state.runs);
      runs.set(event.runId, merged);
      return { runs };
    }

    case "run-removed": {
      if (!state.runs.has(event.runId)) return state;
      const runs = new Map(state.runs);
      runs.delete(event.runId);
      return { runs };
    }

    case "clear-all": {
      if (state.runs.size === 0) return state;
      return { runs: new Map() };
    }

    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

type ApplyResult = {
  state: RunOverlayState;
  outgoing: RunOverlayOutEvent[];
};

/**
 * Apply an incoming event, returning the next state plus any outgoing events
 * the adapter must react to. This is what a runtime/adapter should call.
 *
 * - `overlay-changed` is emitted whenever the run set mutates (count or any
 *   field). The adapter uses it to trigger a re-present.
 * - `all-cleared` is emitted on a non-empty `clear-all`, in addition to
 *   `overlay-changed` (with runCount 0). Adapters that only care about the
 *   new shape can ignore `all-cleared`; it exists for telemetry/reset hooks.
 */
export function applyRunOverlayEvent(
  state: RunOverlayState,
  event: RunOverlayInEvent
): ApplyResult {
  const prevCount = state.runs.size;
  const next = reduceRunOverlay(state, event);
  const outgoing: RunOverlayOutEvent[] = [];

  if (next !== state) {
    outgoing.push({ type: "overlay-changed", runCount: next.runs.size });
  }
  if (event.type === "clear-all" && prevCount > 0) {
    outgoing.push({ type: "all-cleared" });
  }

  return { state: next, outgoing };
}

function shallowEqualRun(a: RunInfo, b: RunInfo): boolean {
  return (
    a.runId === b.runId &&
    a.name === b.name &&
    a.status === b.status &&
    a.summary === b.summary &&
    a.batchId === b.batchId &&
    a.parentDialogId === b.parentDialogId &&
    a.errorMessage === b.errorMessage
    // updatedAt intentionally excluded: the reducer stamps a fresh time on
    // every mutating event, so equal runs still differ in updatedAt. We use
    // this helper only to detect a genuinely empty `info` payload.
  );
}