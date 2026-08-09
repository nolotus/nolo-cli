import type { Agent, DialogConfig } from "../../app/types";
import { asOptionalTrimmedString } from "../../core/optionalString";
import {
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


/**
 * auto 模式对话没有 Agent 实体，执行真相来自代码内置的 execution profile。
 * 调用方（送信权限 / composer UI）统一从这里拿一份等价的 Agent 配置，
 * 不要各自再手搓一个假 Agent 对象。非 auto 对话返回 null。
 */
export const resolveDialogAutoAgentConfig = (
  dialog: Partial<DialogAgentPolicyShape> | null | undefined,
): Agent | null => {
  if (!isAutoDialog(dialog)) return null;
  const profile = resolveAutoExecutionProfile(resolveDialogAutoTier(dialog));
  return {
    ...profile.rawRecord,
    id: profile.id,
    name: profile.name,
  } as unknown as Agent;
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
