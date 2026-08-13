import { extractUserId } from "../../core/prefix";
import { calculatePrice } from "./calculatePrice";
import { normalizeUsage } from "./normalizeUsage";
import { resolveBillingTarget } from "./resolveBillingTarget";
import type { EntryPath, RawUsage, TokenUsageData } from "./types";
import { isOAuthApiKeyRef } from "../../agent-runtime/serverProxyPolicy";

type SharingLevel = "default" | "split" | "full";

interface BillingAgentConfig {
  model: string;
  provider?: string;
  apiSource?: string;
  apiKeyRef?: string | null;
  inputPrice?: number;
  outputPrice?: number;
  sharingLevel?: SharingLevel;
  id?: string;
  userId?: string;
}

interface PrepareTokenUsageDataParams {
  rawUsage: RawUsage;
  agentConfig: BillingAgentConfig;
  userId?: string;
  username?: string;
  /** Canonical agent identity (preferred). */
  agentId?: string;
  /** Deprecated legacy identity; used only when agentId is absent/blank. */
  cybotId?: string;
  dialogId: string;
  timestamp?: number;
  /** 本次请求所发送的稳定前缀指纹，来自 CompiledContext.cacheProfile.stablePrefixHash。 */
  stable_prefix_hash?: string;
  /** 稳定前缀的估算 token 数，来自 cacheProfile.stablePrefixEstimatedTokens。 */
  stable_prefix_estimated_tokens?: number;
  /** 请求入口路径，用于按调用面切片命中率。 */
  entry_path?: EntryPath;
}

export interface PreparedTokenUsageData {
  usage: ReturnType<typeof normalizeUsage>;
  billedProvider?: string;
  billedModel: string;
  billedServiceTier?: string;
  recordProvider: string;
  tokenData: TokenUsageData;
}

/**
 * 唯一计费决策点。按显式真值表算出 billable：
 *
 * billing_estimated === true 时的处理：
 *   - CLI 子进程 / OAuth 订阅 → false（用户自带订阅，估算值不计费）
 *   - 平台 agent / 平台代扣 → true（估算值仍可计费，避免漏收）
 * userId 为空或 "local" (未登录)        → false
 * apiSource === "cli"                   → false  (CLI 子进程是用户自带订阅)
 * apiKeyRef 是 OAuth 订阅 (chatgpt/claude/cursor/xai/antigravity) → false
 * apiSource === "platform" 且 cost > 0  → true   (平台 agent)
 * apiSource === "custom" 且有 price 且 cost > 0 → true (平台分润/代扣)
 * apiSource 缺失/null/"" 且 cost > 0    → true   (兜底：无 apiSource 按平台处理)
 * 其它 cost === 0                       → false
 *
 * 所有扣费入口只读返回的 billable，禁止再看 cost > 0。
 */
export function resolveBillable(input: {
  usage: { billing_estimated?: boolean };
  userId?: string;
  apiSource?: string;
  apiKeyRef?: string | null;
  cost: number;
  hasExternalPrice: boolean;
}): boolean {
  const uid = input.userId?.trim();
  if (!uid || uid === "local") return false;
  const apiSource = input.apiSource;
  if (apiSource === "cli") return false;
  // OAuth 订阅 agent（chatgpt/claude/cursor/xai/antigravity）——用户自带订阅
  if (isOAuthApiKeyRef(input.apiKeyRef)) return false;
  if (input.cost <= 0) return false;

  // billing_estimated：CLI 和 OAuth 订阅已在上方 early return，
  // 此处只剩平台 agent / 平台代扣的估算值——仍计费（避免漏收）。

  // platform → 计费；custom 有 externalPrice → 平台代扣/分润 → 计费；
  // custom 无 externalPrice → 用户自带 key → 不计费
  // apiSource 缺失/null/"" → 兜底按平台处理（cost > 0）
  if (apiSource === "platform") return true;
  if (apiSource === "custom") return input.hasExternalPrice;
  if (apiSource == null || apiSource === "") return true;
  return false;
}

export const prepareTokenUsageData = ({
  rawUsage,
  agentConfig,
  userId,
  username,
  agentId,
  cybotId,
  dialogId,
  timestamp = Date.now(),
  stable_prefix_hash,
  stable_prefix_estimated_tokens,
  entry_path,
}: PrepareTokenUsageDataParams): PreparedTokenUsageData => {
  const resolvedAgentId =
    (typeof agentId === "string" && agentId.trim()) ||
    (typeof cybotId === "string" && cybotId.trim()) ||
    "";
  if (!resolvedAgentId) {
    throw new Error(
      "prepareTokenUsageData requires a non-empty agentId or cybotId"
    );
  }
  const usage = normalizeUsage(rawUsage);
  const billingTarget = resolveBillingTarget({
    usage,
    fallbackProvider: agentConfig.provider,
    fallbackModel: agentConfig.model,
  });
  const billedProvider = billingTarget.provider;
  const billedModel = billingTarget.model;
  const billedServiceTier = billingTarget.serviceTier;
  const recordProvider = billedProvider ?? agentConfig.provider ?? "unknown";

  const hasExternalPrice =
    (agentConfig.inputPrice !== undefined && agentConfig.inputPrice > 0) ||
    (agentConfig.outputPrice !== undefined && agentConfig.outputPrice > 0);

  const { cost, pay } = calculatePrice({
    provider: billedProvider,
    modelName: billedModel,
    billingServiceTier: billedServiceTier,
    usage,
    externalPrice: hasExternalPrice
      ? {
          input: agentConfig.inputPrice ?? 0,
          output: agentConfig.outputPrice ?? 0,
          creatorId: agentConfig.userId ?? (agentConfig.id ? extractUserId(agentConfig.id) : ""),
        }
      : undefined,
    sharingLevel: agentConfig.sharingLevel,
    nowMs: timestamp,
  });

  const billable = resolveBillable({
    usage,
    userId,
    apiSource: agentConfig.apiSource,
    apiKeyRef: agentConfig.apiKeyRef,
    cost,
    hasExternalPrice,
  });

  return {
    usage,
    billedProvider,
    billedModel,
    billedServiceTier,
    recordProvider,
    tokenData: {
      ...usage,
      userId,
      username,
      agentId: resolvedAgentId,
      cybotId: resolvedAgentId,
      model: billedModel,
      provider: recordProvider,
      billing_service_tier: billedServiceTier,
      dialogId,
      cost,
      pay,
      timestamp,
      billable,
      ...(stable_prefix_hash !== undefined ? { stable_prefix_hash } : {}),
      ...(stable_prefix_estimated_tokens !== undefined
        ? { stable_prefix_estimated_tokens }
        : {}),
      ...(entry_path !== undefined ? { entry_path } : {}),
    },
  };
};
