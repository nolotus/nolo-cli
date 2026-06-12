import type { DialogConfig, DialogGoalState } from "../../app/types";
import type { TokenStats } from "./dialogSlice";

export interface CreateDialogGoalInput {
  objective: string;
  tokenBudget?: number;
  now?: number;
}

export interface DialogGoalReport {
  goal: DialogGoalState | null;
  usedTokens: number;
  remainingTokens: number | null;
  completionBudgetReport: string | null;
}

const normalizeObjective = (objective: string): string => {
  const normalized = objective.trim();
  if (!normalized) {
    throw new Error("Dialog goal objective is required.");
  }
  return normalized;
};

const normalizeTokenBudget = (tokenBudget: unknown): number | undefined => {
  if (typeof tokenBudget !== "number") return undefined;
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) return undefined;
  return Math.floor(tokenBudget);
};

const getPersistedTokenUsage = (dialog?: DialogConfig | null): number =>
  Math.max(0, dialog?.inputTokens ?? 0) + Math.max(0, dialog?.outputTokens ?? 0);

const getRuntimeTokenUsage = (runtimeTokens?: TokenStats | null): number =>
  Math.max(0, runtimeTokens?.inputTokens ?? 0) +
  Math.max(0, runtimeTokens?.outputTokens ?? 0);

export const buildDialogGoal = (
  input: CreateDialogGoalInput
): DialogGoalState => {
  const tokenBudget = normalizeTokenBudget(input.tokenBudget);
  return {
    objective: normalizeObjective(input.objective),
    status: "active",
    ...(tokenBudget ? { tokenBudget } : {}),
    createdAt: input.now ?? Date.now(),
  };
};

export const createDialogGoal = (
  dialog: DialogConfig,
  input: CreateDialogGoalInput
): DialogConfig => {
  return {
    ...dialog,
    goal: buildDialogGoal(input),
  };
};

export const completeDialogGoal = (
  dialog: DialogConfig,
  now = Date.now()
): DialogConfig => {
  if (!dialog.goal) return dialog;
  return {
    ...dialog,
    goal: {
      ...dialog.goal,
      status: "complete",
      completedAt: now,
    },
  };
};

export const getDialogGoalReport = (
  dialog?: DialogConfig | null,
  runtimeTokens?: TokenStats | null,
  runtimeGoal?: DialogGoalState | null
): DialogGoalReport => {
  const goal = runtimeGoal ?? dialog?.goal ?? null;
  const usedTokens = getPersistedTokenUsage(dialog) + getRuntimeTokenUsage(runtimeTokens);

  if (!goal) {
    return {
      goal: null,
      usedTokens,
      remainingTokens: null,
      completionBudgetReport: null,
    };
  }

  if (typeof goal.tokenBudget !== "number") {
    return {
      goal,
      usedTokens,
      remainingTokens: null,
      completionBudgetReport: `Goal is ${goal.status}. Used ${usedTokens} tokens. No token budget set.`,
    };
  }

  const remainingTokens = Math.max(0, goal.tokenBudget - usedTokens);
  return {
    goal,
    usedTokens,
    remainingTokens,
    completionBudgetReport: `Goal is ${goal.status}. Used ${usedTokens} / ${goal.tokenBudget} tokens, ${remainingTokens} remaining.`,
  };
};
