import type {
  WorkflowStepState,
  WorkflowExecutionStats,
} from "./workflowTypes";

// Module store for workflow progress state — peeled out of Redux.
// Mirrors packages/app/appInspector/appInspectorStore.ts:
//   - listeners Set + version counter
//   - notify/bump with try/catch around each listener
// No React hooks today (no UI consumers); subscribe/getSnapshot kept for tests.

interface WorkflowStoreState {
  title: string | null;
  steps: WorkflowStepState[];
  stats: WorkflowExecutionStats;
}

const createInitialState = (): WorkflowStoreState => ({
  title: null,
  steps: [],
  stats: {
    startTime: null,
    totalStepsExecuted: 0,
    failedSteps: 0,
  },
});

const listeners = new Set<() => void>();
let version = 0;

let state: WorkflowStoreState = createInitialState();

const notify = (): void => {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* subscriber errors must not break mutators */
    }
  }
};

const bump = (): void => {
  version += 1;
  notify();
};

// --- Mutators (plain functions — NOT Redux actions) ---

export function setWorkflow(args: {
  title: string;
  steps: WorkflowStepState[];
}): void {
  state = {
    title: args.title,
    steps: args.steps,
    stats: {
      startTime: Date.now(),
      totalStepsExecuted: 0,
      failedSteps: 0,
    },
  };
  bump();
}

export function updateStep(args: {
  id: string;
  updates: Partial<WorkflowStepState>;
}): void {
  const step = state.steps.find((s) => s.id === args.id);
  if (step) {
    Object.assign(step, args.updates);
    bump();
  }
}

export function incrementStepsExecuted(): void {
  state.stats.totalStepsExecuted += 1;
  bump();
}

export function incrementFailedSteps(): void {
  state.stats.failedSteps += 1;
  bump();
}

export function clearWorkflow(): void {
  state = createInitialState();
  bump();
}

// --- Sync reads (return live arrays/refs — same as reading Redux state) ---

export function getWorkflowTitle(): string | null {
  return state.title;
}

export function getWorkflowSteps(): WorkflowStepState[] {
  return state.steps;
}

export function getWorkflowStats(): WorkflowExecutionStats {
  return state.stats;
}

export function getPendingSteps(): WorkflowStepState[] {
  return state.steps.filter((s) => s.status === "pending");
}

export function getCompletedSteps(): WorkflowStepState[] {
  return state.steps.filter((s) => s.status === "completed");
}

// --- useSyncExternalStore ---

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): number {
  return version;
}

export function resetWorkflowStoreForTests(): void {
  state = createInitialState();
  bump();
}