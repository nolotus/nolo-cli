// Wave18 — pure post-write dispatch policy for messageStreamEnd (Redux-free).

export type StreamEndBillingMode = "reported" | "estimated" | "skip";

export interface StreamEndPostWritePolicy {
  billingMode: StreamEndBillingMode;
  updateTitle: boolean;
  updateSummary: boolean;
  addRefs: boolean;
  summaryForce: boolean;
  summaryReason: "task_completed" | "context_budget";
}

/**
 * Decide what side-effect dispatches messageStreamEnd should fire after the
 * terminal assistant write, without touching Redux/dispatch.
 *
 * Rules (extracted verbatim from the messageStreamEnd thunk ~980-1037):
 * - billingMode: hasReportedUsage -> "reported"; else if agentConfig.provider
 *   exists and !== "custom" -> "estimated"; else "skip".
 * - updateTitle: titleEligible (non-empty visible content).
 * - updateSummary / addRefs: textContent.trim() !== "".
 * - summaryForce / summaryReason: no tool calls (or empty) -> force=true +
 *   "task_completed"; otherwise force=false + "context_budget". The values
 *   are filled even when updateSummary is false (cheap, deterministic default).
 */
export function resolveStreamEndPostWritePolicy(input: {
  hasReportedUsage: boolean;
  agentProvider?: string | null;
  titleEligible: boolean;
  textContent: string;
  toolCalls?: unknown[] | null;
}): StreamEndPostWritePolicy {
  const { hasReportedUsage, agentProvider, titleEligible, textContent, toolCalls } =
    input;

  const billingMode: StreamEndBillingMode = hasReportedUsage
    ? "reported"
    : agentProvider && agentProvider !== "custom"
    ? "estimated"
    : "skip";

  const hasText = textContent.trim() !== "";
  const noTools = !toolCalls || toolCalls.length === 0;

  return {
    billingMode,
    updateTitle: titleEligible,
    updateSummary: hasText,
    addRefs: hasText,
    summaryForce: noTools,
    summaryReason: noTools ? "task_completed" : "context_budget",
  };
}