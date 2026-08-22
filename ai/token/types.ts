// ai/token/types.ts

export const DEFAULT_QUERY_LIMIT = 100;

export const TOKEN_PERIODS = {
  DAY: "day",
  WEEK: "week",
  MONTH: "month",
} as const;

// DayStats / ModelStats / TokenCount 统一定义，供 stats.ts、query.ts、
// serverTokenWriter、updateTokensAction、externalToolCost 共用。
// 唯一实现在 applyTokenUsageToDayStats.ts。
export type { DayStats, ModelStats, TokenCount } from "./applyTokenUsageToDayStats";

export const TOKEN_SCOPES = {
  USER: "user",
  SITE: "site",
} as const;

interface BillingUsageMetadata {
  cost?: number;
  /**
   * xAI returns per-request cost in integer ticks (1 USD = 1e10 ticks).
   * normalizeUsage converts this to `cost` (USD); the raw field is preserved
   * for callers that want integer precision.
   */
  cost_in_usd_ticks?: number;
  billing_provider?: string;
  billing_model?: string;
  billing_service_tier?: string;
  billing_estimated?: boolean;
  image_generation_count?: number;
  provider_response_ids?: string[];
  provider_request_ids?: string[];
  /**
   * Set by the chat proxy server (chatHandler usage payload) when this provider
   * call's usage was already billed server-side by recordChatProxyTokenUsage.
   * The client treats this as a stats-only hint: when true, prepareTokenUsageData
   * forces billable=false so updateTokensAction does not deductBalance locally
   * (the server already charged). This is a hint only — the authoritative
   * double-charge guard is server-side in handleToken (provider-call marker +
   * ledger idempotency key), which does NOT trust this flag.
   */
  server_billed?: boolean;
  /**
   * First provider-call id for this chat proxy request (server truth anchor).
   * Echoed back to the server in the token record so handleToken can locate the
   * provider-call marker written by recordChatProxyTokenUsage for independent
   * server-side verification that this provider call was already billed.
   */
  provider_call_id?: string;
}

// 原始用量类型
export interface RawUsageType1 extends BillingUsageMetadata {
  output_tokens?: number;
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
}

export interface RawUsageType2 extends BillingUsageMetadata {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens: number;
  prompt_cache_miss_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

export type RawUsage = RawUsageType1 | RawUsageType2;

// 标准化后的用量数据
export interface NormalizedUsage extends BillingUsageMetadata {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost: number;
}

/** 请求入口路径，用于按调用面切片缓存命中率。 */
export type EntryPath =
  | "web-chat"
  | "quick-chat"
  | "agent-run"
  | "cli-local"
  | "desktop-local";

// Token使用数据
export interface TokenUsageData extends NormalizedUsage {
  userId?: string;
  username?: string;
  /** Canonical agent identity (new records). Kept in sync with cybotId. */
  agentId?: string;
  /** Legacy agent identity; retained for old rows. New records write both. */
  cybotId: string;
  model: string;
  provider: string;
  dialogId: string;
  /** Optional event time used when building record keys. */
  timestamp?: number;
  pay: any; // TODO: 明确支付数据类型
  /**
   * 唯一计费标志：true 才扣费，false 只统计。
   * 由 prepareTokenUsageData 按 apiSource / billing_estimated / owner 一次性算出，
   * 所有扣费入口只读此字段，禁止再看 cost > 0。
   */
  billable: boolean;
  /** 本次请求所发送的稳定前缀指纹，来自 CompiledContext.cacheProfile.stablePrefixHash。 */
  stable_prefix_hash?: string;
  /** 稳定前缀的估算 token 数，来自 cacheProfile.stablePrefixEstimatedTokens。 */
  stable_prefix_estimated_tokens?: number;
  /** 请求入口路径，用于按调用面切片命中率。 */
  entry_path?: EntryPath;
}

// Token记录
export interface TokenRecord {
  id: string;
  userId: string;
  username: string;
  /** Canonical agent identity (new records). Kept in sync with cybotId. */
  agentId?: string;
  /** Legacy agent identity; optional on new records that carry agentId. */
  cybotId?: string;
  model: string;
  provider: string;
  /** Optional: explicit served-upstream audit (may match provider after resolve). */
  billing_provider?: string;
  billing_model?: string;
  billing_service_tier?: string;
  dialogId: string;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  input_tokens: number;
  cost: number;
  inputPrice?: number;
  outputPrice?: number;
  /** 缓存命中读取单价（credits/百万），billing catalog 写时快照（US-3.2）；旧记录缺省 */
  inputCacheHitPrice?: number;
  /** 缓存写入单价（credits/百万），billing catalog 写时快照（US-3.2）；旧记录缺省 */
  cacheWritePrice?: number;
  /** 调用终态（US-3.3）：缺省视为 success；failed = 调用失败（可能仍有部分 usage 被计费） */
  status?: "success" | "failed";
  /** 失败原因摘要（provider 错误等，截断存储）；仅 status=failed 时有意义 */
  errorMessage?: string;
  image_generation_count?: number;
  provider_response_ids?: string[];
  provider_request_ids?: string[];
  pay: any;
  createdAt: number; // UTC timestamp
  type: string;
  /** 唯一计费标志：true 才扣费，false 只统计。 */
  billable: boolean;
  /** 本次请求所发送的稳定前缀指纹，来自 CompiledContext.cacheProfile.stablePrefixHash。 */
  stable_prefix_hash?: string;
  /** 稳定前缀的估算 token 数，来自 cacheProfile.stablePrefixEstimatedTokens。 */
  stable_prefix_estimated_tokens?: number;
  /** 请求入口路径，用于按调用面切片命中率。 */
  entry_path?: EntryPath;
}

// Token统计数据
export interface TokenStats {
  total: number;
  date: string; // YYYY-MM-DD in UTC
  inputTokens: number;
  outputTokens: number;
  cost: number;
  userId: string;
  createdAt: number; // UTC timestamp
  type: string;
}
