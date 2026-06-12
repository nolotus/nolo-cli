import { prepareTokenUsageData } from "../../token/prepareTokenUsageData";
import type { RawUsage } from "../../token/types";

const roundCredits = (value: number) => Number(value.toFixed(6));
const toRoundedFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? roundCredits(value) : null;
const getUsageCost = (usage: unknown): number | null => {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const cost = (usage as { cost?: unknown }).cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0
    ? roundCredits(cost)
    : null;
};
const getUsageBillingServiceTier = (usage: unknown): string | null => {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const serviceTier = (usage as { billing_service_tier?: unknown }).billing_service_tier;
  return typeof serviceTier === "string" && serviceTier.trim()
    ? serviceTier.trim()
    : null;
};

const normalizePositiveNumber = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return roundCredits(value);
};

export const normalizeBudgetCredits = (value: unknown): number | undefined =>
  normalizePositiveNumber(value);

export interface ParallelBranchPricingInput {
  usage?: unknown;
  agentKey: string;
  dialogId?: string | null;
  agentConfig: {
    id?: string;
    model?: string | null;
    provider?: string | null;
    inputPrice?: number | null;
    outputPrice?: number | null;
  };
}

export interface ParallelBranchPricingResult {
  spentCredits: number | null;
  billedModel: string | null;
  billedProvider: string | null;
  billingServiceTier: string | null;
  pricingError: string | null;
}

export const calculateParallelBranchPricing = (
  input: ParallelBranchPricingInput
): ParallelBranchPricingResult => {
  if (!input.usage || typeof input.usage !== "object") {
    return {
      spentCredits: null,
      billedModel: null,
      billedProvider: null,
      billingServiceTier: null,
      pricingError: "missing usage",
    };
  }

  const model =
    typeof input.agentConfig.model === "string" && input.agentConfig.model.trim()
      ? input.agentConfig.model.trim()
      : null;
  const provider =
    typeof input.agentConfig.provider === "string" && input.agentConfig.provider.trim()
      ? input.agentConfig.provider.trim()
      : null;
  const fallbackUsageCost = getUsageCost(input.usage);
  const fallbackBillingServiceTier = getUsageBillingServiceTier(input.usage);
  if (!model) {
    return {
      spentCredits: null,
      billedModel: null,
      billedProvider: null,
      billingServiceTier: null,
      pricingError: "missing model",
    };
  }

  try {
    const prepared = prepareTokenUsageData({
      rawUsage: input.usage as RawUsage,
      agentConfig: {
        id: input.agentConfig.id ?? input.agentKey,
        model,
        ...(typeof input.agentConfig.provider === "string" &&
        input.agentConfig.provider.trim()
          ? { provider: input.agentConfig.provider.trim() }
          : {}),
        ...(typeof input.agentConfig.inputPrice === "number" &&
        Number.isFinite(input.agentConfig.inputPrice)
          ? { inputPrice: input.agentConfig.inputPrice }
          : {}),
        ...(typeof input.agentConfig.outputPrice === "number" &&
        Number.isFinite(input.agentConfig.outputPrice)
          ? { outputPrice: input.agentConfig.outputPrice }
          : {}),
      },
      cybotId: input.agentKey,
      dialogId: input.dialogId ?? `parallel-${input.agentKey}`,
    });
    const preparedCost = toRoundedFiniteNumber(prepared.tokenData.cost);
    if (preparedCost != null) {
      return {
        spentCredits: preparedCost,
        billedModel: prepared.billedModel,
        billedProvider: prepared.recordProvider,
        billingServiceTier: prepared.billedServiceTier ?? null,
        pricingError: null,
      };
    }

    if (fallbackUsageCost != null) {
      return {
        spentCredits: fallbackUsageCost,
        billedModel: prepared.billedModel ?? model,
        billedProvider: prepared.recordProvider ?? provider,
        billingServiceTier:
          prepared.billedServiceTier ?? fallbackBillingServiceTier ?? null,
        pricingError: null,
      };
    }

    return {
      spentCredits: null,
      billedModel: null,
      billedProvider: null,
      billingServiceTier: null,
      pricingError: "invalid cost",
    };
  } catch (error: any) {
    if (fallbackUsageCost != null) {
      return {
        spentCredits: fallbackUsageCost,
        billedModel: model,
        billedProvider: provider,
        billingServiceTier: fallbackBillingServiceTier,
        pricingError: null,
      };
    }
    return {
      spentCredits: null,
      billedModel: null,
      billedProvider: null,
      billingServiceTier: null,
      pricingError: error?.message || String(error),
    };
  }
};

export interface ParallelCostSummary {
  spentCredits: number;
  pricedBranches: number;
  unpricedBranches: number;
}

export interface ParallelBudgetSummary extends ParallelCostSummary {
  budgetCredits: number;
  remainingCredits: number;
  exhausted: boolean;
}

export const summarizeParallelCosts = (
  results: Array<{ spentCredits?: number | null; ok?: boolean }>
): ParallelCostSummary => {
  const spentCredits = roundCredits(
    results.reduce(
      (sum, item) =>
        sum +
        (typeof item.spentCredits === "number" && Number.isFinite(item.spentCredits)
          ? item.spentCredits
          : 0),
      0
    )
  );

  return {
    spentCredits,
    pricedBranches: results.filter(
      (item) => typeof item.spentCredits === "number" && Number.isFinite(item.spentCredits)
    ).length,
    unpricedBranches: results.filter(
      (item) =>
        item.ok &&
        (item.spentCredits == null ||
          (typeof item.spentCredits === "number" && !Number.isFinite(item.spentCredits)))
    ).length,
  };
};

export const summarizeParallelBudget = (input: {
  budgetCredits?: number;
  results: Array<{ spentCredits?: number | null; ok?: boolean }>;
}): ParallelBudgetSummary | null => {
  const budgetCredits = normalizePositiveNumber(input.budgetCredits);
  if (budgetCredits === undefined) {
    return null;
  }

  const costSummary = summarizeParallelCosts(input.results);
  const remainingCredits = roundCredits(
    Math.max(0, budgetCredits - costSummary.spentCredits)
  );

  return {
    ...costSummary,
    budgetCredits,
    remainingCredits,
    exhausted: remainingCredits <= 0,
  };
};
