import type { DialogConfig } from "../../app/types";
import { asOptionalTrimmedString } from "../../core/optionalString";
import {
  AUTO_ASSISTANT_MEMORY_SUBJECT_ID,
  DEFAULT_AUTO_EXECUTION_PROFILE,
  resolveAutoExecutionProfile,
  type AutoExecutionTier,
} from "../../agent-runtime/autoExecutionProfiles";
import { getPrimaryDialogAgentId } from "./dialogAgents";

export type DialogAgentMode = "auto" | "fixed";

export type DialogAgentPolicyShape = Pick<
  DialogConfig,
  "agentMode" | "autoRoute" | "primaryAgentKey" | "cybots"
> & {
  llmId?: string;
};

export const resolveDialogAgentMode = (
  dialog: Partial<DialogAgentPolicyShape> | null | undefined,
): DialogAgentMode => {
  if (dialog?.agentMode === "auto") return "auto";
  if (dialog?.agentMode === "fixed") return "fixed";
  return getPrimaryDialogAgentId(dialog as any) ? "fixed" : "auto";
};

export const isAutoDialog = (
  dialog: Partial<DialogAgentPolicyShape> | null | undefined,
): boolean => resolveDialogAgentMode(dialog) === "auto";

export const resolveDialogAutoTier = (
  dialog: Partial<DialogAgentPolicyShape> | null | undefined,
): AutoExecutionTier | undefined => {
  const tier = asOptionalTrimmedString(dialog?.autoRoute?.stickyTier);
  return tier === "flash" ||
    tier === "balanced" ||
    tier === "quality" ||
    tier === "image"
    ? tier
    : undefined;
};

export const resolveDialogMemorySubjectId = (
  dialog: Partial<DialogAgentPolicyShape> | null | undefined,
  explicitAgentKey?: string | null,
): string => {
  const explicit = asOptionalTrimmedString(explicitAgentKey);
  if (explicit) return explicit;
  if (resolveDialogAgentMode(dialog) === "fixed") {
    const fixed = getPrimaryDialogAgentId(dialog as any);
    if (fixed) return fixed;
  }
  return AUTO_ASSISTANT_MEMORY_SUBJECT_ID;
};

/**
 * Compatibility runtime key for callers that have not yet accepted an
 * execution profile. It is never proof that an Agent record exists.
 */
export const resolveDialogRuntimeAgentKey = (
  dialog: Partial<DialogAgentPolicyShape> | null | undefined,
  explicitAgentKey?: string | null,
): string => {
  const explicit = asOptionalTrimmedString(explicitAgentKey);
  if (explicit) return explicit;
  if (resolveDialogAgentMode(dialog) === "fixed") {
    const fixed = getPrimaryDialogAgentId(dialog as any);
    if (fixed) return fixed;
  }
  return resolveAutoExecutionProfile(
    resolveDialogAutoTier(dialog) ?? DEFAULT_AUTO_EXECUTION_PROFILE.tier,
  ).legacyAgentKey;
};
