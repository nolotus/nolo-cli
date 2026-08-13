import type { Agent, DialogConfig } from "../../app/types";
import { asOptionalTrimmedString } from "../../core/optionalString";
import {
  DEFAULT_AUTO_EXECUTION_PROFILE,
  resolveAutoExecutionProfile,
  type AutoExecutionTier,
} from "../../agent-runtime/autoExecutionProfiles";
import { resolveBuiltinPlatformAgentRecord } from "../../agent-runtime/builtinPlatformAgentConfigs";
import { getActiveDialogAgentId } from "./dialogAgents";

export type DialogAgentMode = "auto" | "fixed";

export type DialogAgentPolicyShape = Pick<
  DialogConfig,
  "agentMode" | "autoRoute" | "primaryAgentKey" | "activeAgentKey" | "cybots"
> & {
  llmId?: string;
};

export const resolveDialogAgentMode = (
  dialog: Partial<DialogAgentPolicyShape> | null | undefined,
): DialogAgentMode => {
  if (dialog?.agentMode === "auto") return "auto";
  if (dialog?.agentMode === "fixed") return "fixed";
  // activeAgentKey（对话内切换）与 primaryAgentKey 都算 fixed：
  // 只切了 active 而未设 primary 的 dialog 不能被误判为 auto。
  return getActiveDialogAgentId(dialog as any) ? "fixed" : "auto";
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
    const fixed = getActiveDialogAgentId(dialog as any);
    if (fixed) return fixed;
  }
  return resolveAutoExecutionProfile(
    resolveDialogAutoTier(dialog) ?? DEFAULT_AUTO_EXECUTION_PROFILE.tier,
  ).legacyAgentKey;
};

/**
 * Execution config for this turn when it can be answered from code alone.
 *
 * auto 对话按设计不绑定 Agent 实体，`resolveDialogRuntimeAgentKey` 返回的
 * legacyAgentKey 只是兼容标识，对应的 `agent-pub-*` 记录可以不存在。发送路径
 * 拿到这份配置就不必去读那条记录——读不到会让整轮直接失败（线上就从没 seed
 * 过 flash/pro/glm/image 四条记录）。
 *
 * 返回 null 表示「这轮需要真实 Agent 记录」，调用方照常去库里读。
 */
export const resolveDialogRuntimeAgentConfig = (
  dialog: Partial<DialogAgentPolicyShape> | null | undefined,
  explicitAgentKey?: string | null,
): Agent | null => {
  // fixed 对话指向真实 Agent 实体，必须读记录，不能被内置配置遮蔽。
  if (!isAutoDialog(dialog)) return null;
  const key = resolveDialogRuntimeAgentKey(dialog, explicitAgentKey);
  // 只认内置平台档位 key；auto 对话若显式指向其它 Agent，仍走正常读取。
  return (resolveBuiltinPlatformAgentRecord(key) as Agent | null) ?? null;
};
