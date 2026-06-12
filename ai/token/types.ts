// ai/token/types.ts

export const DEFAULT_QUERY_LIMIT = 100;

export const TOKEN_PERIODS = {
  DAY: "day",
  WEEK: "week",
  MONTH: "month",
} as const;

export const TOKEN_SCOPES = {
  USER: "user",
  CYBOT: "cybot",
  SITE: "site",
} as const;

interface BillingUsageMetadata {
  cost?: number;
  billing_provider?: string;
  billing_model?: string;
  billing_service_tier?: string;
  billing_estimated?: boolean;
  image_generation_count?: number;
  provider_response_ids?: string[];
  provider_request_ids?: string[];
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

// Token使用数据
export interface TokenUsageData extends NormalizedUsage {
  userId?: string;
  cybotId: string;
  model: string;
  provider: string;
  dialogId: string;
  pay: any; // TODO: 明确支付数据类型
}

// Token记录
export interface TokenRecord {
  id: string;
  userId: string;
  username: string;
  cybotId: string;
  model: string;
  provider: string;
  dialogId: string;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  input_tokens: number;
  cost: number;
  image_generation_count?: number;
  provider_response_ids?: string[];
  provider_request_ids?: string[];
  pay: any;
  createdAt: number; // UTC timestamp
  type: string;
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
