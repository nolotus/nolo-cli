/**
 * Workflow Executor
 *
 * Deterministic execution engine — zero LLM orchestration tokens.
 * Each step runs directly without asking LLM "what to do next".
 * Only "llm" type steps call the model (single call, no tool loop).
 */

import { createAsyncThunk } from "@reduxjs/toolkit";
import type { RootState } from "../../app/store";
import { runLlm } from "../agent/agentSlice";
import { toolExecutors } from "../tools";
import {
  setWorkflow,
  updateStep,
  incrementStepsExecuted,
  incrementFailedSteps,
} from "./workflowSlice";
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowToolStep,
  WorkflowLlmStep,
  WorkflowParallelStep,
  WorkflowStepState,
  WorkflowResult,
} from "./workflowTypes";

// --- Template Resolution ---

/**
 * Resolves {{steps.<id>.result}} and {{steps.<id>.result[N]}} templates.
 * Walks nested objects/arrays recursively.
 */
function resolveTemplates(
  value: any,
  results: Record<string, any>
): any {
  if (typeof value === "string") {
    return value.replace(
      /\{\{steps\.([^.}\s]+)\.result(\[\d+\])?\}\}/g,
      (match, stepId, indexPart) => {
        const stepResult = results[stepId];
        if (stepResult === undefined) {
          console.warn(`Workflow: cannot resolve {{steps.${stepId}.result}} — step not completed yet`);
          return match;
        }
        let resolved = stepResult;
        if (indexPart) {
          const idx = parseInt(indexPart.slice(1, -1), 10);
          if (Array.isArray(resolved) && idx < resolved.length) {
            resolved = resolved[idx];
          } else {
            console.warn(`Workflow: index ${idx} out of range for steps.${stepId}.result`);
            return match;
          }
        }
        return typeof resolved === "object" ? JSON.stringify(resolved) : String(resolved);
      }
    );
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveTemplates(v, results));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveTemplates(v, results)])
    );
  }
  return value;
}

// --- Condition Evaluation (safe allowlist interpreter) ---

/**
 * Validates that an expression contains ONLY:
 *   - steps.<identifier> property paths
 *   - comparison operators: === !== > < >= <=
 *   - logical operators: && || !
 *   - string literals, number literals, boolean/null keywords
 *   - parentheses and whitespace
 *
 * Strategy: substitute every safe token with a placeholder, then assert
 * nothing else remains. This allowlist approach is far more robust than a
 * blocklist, which can be bypassed with Unicode escapes or bracket notation.
 */
function isSafeConditionExpression(expr: string): boolean {
  let s = expr.trim();
  if (!s) return false;

  // 1. Replace double/single-quoted string literals (no newlines inside)
  s = s.replace(/"[^"\n\\]*(?:\\.[^"\n\\]*)*"/g, "0");
  s = s.replace(/'[^'\n\\]*(?:\\.[^'\n\\]*)*/g, "0");

  // 2. Replace number literals (int / float)
  s = s.replace(/\b\d+(?:\.\d+)?\b/g, "0");

  // 3. Replace allowed keywords
  s = s.replace(/\b(true|false|null|undefined)\b/g, "0");

  // 4. Replace steps.<dotted-path> (e.g. steps.fetchData.output)
  s = s.replace(/\bsteps\.[a-zA-Z_][a-zA-Z0-9_.]*\b/g, "0");

  // 5. What's left should only be operators, parens, whitespace
  //    Allowed characters: 0 (placeholder) space ( ) ! & | = < >
  return /^[0\s()!&|=<>]+$/.test(s);
}

/**
 * Safely resolves a dotted property path like "steps.fetchData.output"
 * against the given results object. Returns undefined for any unknown path.
 */
function resolvePath(path: string, results: Record<string, any>): unknown {
  // path must be "steps.<segment>[.<segment>...]"
  const parts = path.split(".");
  if (parts[0] !== "steps" || parts.length < 2) return undefined;
  let cur: any = results;
  for (let i = 1; i < parts.length; i++) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

/**
 * Evaluates a condition expression against step results.
 *
 * Uses an allowlist validator to guarantee the expression contains nothing
 * but property lookups, comparison/logical operators, and literals before
 * delegating to the JS engine. This eliminates the code-execution surface
 * that a keyword blocklist cannot reliably close.
 */
function evaluateCondition(
  expression: string,
  results: Record<string, any>
): boolean {
  if (!isSafeConditionExpression(expression)) {
    console.warn(
      `Workflow: condition expression rejected by allowlist: "${expression}"`
    );
    return false;
  }
  try {
    // At this point the expression has been validated to contain only safe
    // tokens. We substitute all steps.* paths with their runtime values so
    // the final eval string never needs to reference external globals.
    const resolved = expression.replace(
      /\bsteps\.[a-zA-Z_][a-zA-Z0-9_.]*\b/g,
      (match) => JSON.stringify(resolvePath(match, results))
    );
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return !!(${resolved})`);
    return fn();
  } catch (e) {
    console.warn(`Workflow: condition eval failed: "${expression}"`, e);
    return false;
  }
}



/**
 * Executes `fn` up to `maxRetries + 1` times total.
 * Throws the last error if all attempts fail.
 */
async function executeWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// --- Single Step Executors ---

async function executeToolStep(
  step: WorkflowToolStep,
  results: Record<string, any>,
  thunkApi: any
): Promise<any> {
  const executor = toolExecutors[step.tool];
  if (!executor) throw new Error(`Workflow: unknown tool "${step.tool}"`);
  const resolvedArgs = resolveTemplates(step.args, results);
  const result = await executor(resolvedArgs, thunkApi);
  return result?.rawData ?? result;
}

async function executeLlmStep(
  step: WorkflowLlmStep,
  results: Record<string, any>,
  thunkApi: any
): Promise<any> {
  const { dispatch } = thunkApi;
  const resolvedPrompt = resolveTemplates(step.prompt, results);
  const result = await dispatch(
    runLlm({
      content: resolvedPrompt,
      isStreaming: false,
      ...(step.model && { modelOverride: step.model }),
    })
  ).unwrap();
  return result;
}

async function executeParallelStep(
  step: WorkflowParallelStep,
  results: Record<string, any>,
  thunkApi: any
): Promise<Record<string, any>> {
  const subResults = await Promise.all(
    step.steps.map(async (sub) => {
      const subResult =
        sub.type === "tool"
          ? await executeToolStep(sub as WorkflowToolStep, results, thunkApi)
          : await executeLlmStep(sub as WorkflowLlmStep, results, thunkApi);
      return [sub.id, subResult] as [string, any];
    })
  );
  return Object.fromEntries(subResults);
}

// --- Main Executor Thunk ---

export const runWorkflow = createAsyncThunk<
  WorkflowResult,
  { definition: WorkflowDefinition; dialogKey?: string },
  { state: RootState }
>("workflow/run", async ({ definition }, thunkApi) => {
  const { dispatch } = thunkApi;

  // Initialize Redux state for UI visibility
  const initialStepStates: WorkflowStepState[] = definition.steps.map((s) => ({
    id: s.id,
    title: s.title,
    type: s.type,
    status: "pending",
  }));
  dispatch(setWorkflow({ title: definition.title, steps: initialStepStates }));

  const results: Record<string, any> = {};
  // Set of step IDs to skip (controlled by condition steps)
  const skippedIds = new Set<string>();

  for (const step of definition.steps) {
    if (skippedIds.has(step.id)) {
      dispatch(updateStep({ id: step.id, updates: { status: "skipped" } }));
      continue;
    }

    dispatch(updateStep({ id: step.id, updates: { status: "in-progress" } }));

    try {
      let result: any;

      if (step.type === "tool" || step.type === "llm") {
        const retryable = step as WorkflowToolStep | WorkflowLlmStep;
        const policy = retryable.onError ?? "stop";
        const maxRetries =
          policy === "retry" ? ((retryable as WorkflowToolStep).retryCount ?? 1) : 0;

        result = await executeWithRetry(
          () =>
            step.type === "tool"
              ? executeToolStep(step as WorkflowToolStep, results, thunkApi)
              : executeLlmStep(step as WorkflowLlmStep, results, thunkApi),
          maxRetries
        );

      } else if (step.type === "parallel") {
        result = await executeParallelStep(step, results, thunkApi);
        // Flatten sub-step results into the top-level map so subsequent steps
        // can reference them directly via {{steps.<subId>.result}}.
        for (const [subId, subResult] of Object.entries(
          result as Record<string, any>
        )) {
          results[subId] = subResult;
        }

      } else if (step.type === "condition") {
        const passed = evaluateCondition(step.check, results);
        result = { passed, check: step.check };
        const active = passed ? step.ifTrue : step.ifFalse;
        const inactive = passed ? step.ifFalse : step.ifTrue;
        // Mark steps not on the active branch as skipped
        if (inactive) inactive.forEach((id) => skippedIds.add(id));
        // Steps on the active branch are explicitly NOT skipped
        if (active) active.forEach((id) => skippedIds.delete(id));
      }

      results[step.id] = result;
      dispatch(updateStep({ id: step.id, updates: { status: "completed", result } }));
      dispatch(incrementStepsExecuted());

    } catch (err: any) {
      dispatch(incrementFailedSteps());
      dispatch(
        updateStep({ id: step.id, updates: { status: "failed", error: err?.message ?? String(err) } })
      );

      const policy = (step as WorkflowToolStep | WorkflowLlmStep).onError ?? "stop";

      if (policy === "stop") {
        return {
          success: false,
          results,
          failedStep: step.id,
          error: err?.message ?? String(err),
        };
      }
      // skip / retry-exhausted: record null and continue
      results[step.id] = null;
    }
  }

  return { success: true, results };
});
