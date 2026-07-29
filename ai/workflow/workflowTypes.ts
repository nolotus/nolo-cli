// Workflow: deterministic execution engine, zero LLM orchestration tokens.
// LLM calls createWorkflow once to define steps; engine executes without further LLM involvement.
// Only "llm" type steps invoke the model; all others run as pure tool calls.

export type WorkflowStepStatus = "pending" | "in-progress" | "completed" | "failed" | "skipped";

export type OnErrorPolicy = "stop" | "skip" | "retry";

// --- Step Types ---

export interface WorkflowToolStep {
  id: string;
  type: "tool";
  title?: string;
  /** Registered tool name */
  tool: string;
  /** Args supporting {{steps.<id>.result}} and {{steps.<id>.result[N]}} templates */
  args: Record<string, any>;
  onError?: OnErrorPolicy;
  retryCount?: number;
}

export interface WorkflowLlmStep {
  id: string;
  type: "llm";
  title?: string;
  /** Prompt supporting {{steps.<id>.result}} templates */
  prompt: string;
  model?: string;
  onError?: OnErrorPolicy;
}

/** All steps inside run concurrently via Promise.all */
export interface WorkflowParallelStep {
  id: string;
  type: "parallel";
  title?: string;
  steps: (WorkflowToolStep | WorkflowLlmStep)[];
}

/**
 * Pure JS condition check — no LLM.
 * `check` is a JS expression string evaluated with step results in scope.
 *
 * Supported syntax (allowlist):
 *   - Dotted property access: `steps.<stepId>.<property>[.<nested>...]`
 *   - Comparison operators: === !== > < >= <=
 *   - Logical operators: && || !
 *   - String / number / boolean / null literals
 *   - Parentheses for grouping
 *
 * Note: bracket notation (`steps['id']`) and `.result` wrappers are NOT supported.
 * The value stored for each step is the raw executor return value, accessed directly:
 * e.g. `"steps.validate.isValid === true"`
 *      `"steps.score.value >= 80 && steps.flag.ok !== false"`
 */
export interface WorkflowConditionStep {
  id: string;
  type: "condition";
  title?: string;
  check: string;
  /** Step IDs to execute when check is truthy (skip others) */
  ifTrue?: string[];
  /** Step IDs to execute when check is falsy (skip others) */
  ifFalse?: string[];
}

export type WorkflowStep =
  | WorkflowToolStep
  | WorkflowLlmStep
  | WorkflowParallelStep
  | WorkflowConditionStep;

// --- Workflow Definition ---

export interface WorkflowDefinition {
  title: string;
  steps: WorkflowStep[];
}

// --- Execution State (stored in Redux) ---

export interface WorkflowStepState {
  id: string;
  title?: string;
  type: WorkflowStep["type"];
  status: WorkflowStepStatus;
  result?: any;
  error?: string;
}

export interface WorkflowExecutionStats {
  startTime: number | null;
  totalStepsExecuted: number;
  failedSteps: number;
}

// --- Result ---

export interface WorkflowResult {
  success: boolean;
  /** Results keyed by step id */
  results: Record<string, any>;
  failedStep?: string;
  error?: string;
}
