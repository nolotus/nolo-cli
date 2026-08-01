// ai/token/applyTokenUsageToDayStats.ts
// 统计聚合的唯一纯函数实现。prev + delta → newStats，无 I/O。
// 四条写入路径（serverTokenWriter / updateTokensAction / db.ts / externalToolCost）
// 原先各自维护一份 inc/updateStats 逻辑，收敛到这里。
import type { TokenUsageData } from "./types";

export interface TokenCount {
  input: number;
  output: number;
}

export interface ModelStats {
  count: number;
  tokens: TokenCount;
  cost: number;
}

export interface DayStats {
  userId: string;
  period: "day";
  timeKey: string;
  total: ModelStats;
  models: Record<string, ModelStats>;
  providers: Record<string, ModelStats>;
}

const ZERO_STATS: ModelStats = { count: 0, tokens: { input: 0, output: 0 }, cost: 0 };

/**
 * 累加一条 token 用量到每日统计。纯函数：不读不写 store。
 * - 当 prev 为 null 时按 userId/timeKey 初始化
 * - 始终返回新对象，不 mutate prev
 */
export function applyTokenUsageToDayStats(
  prev: DayStats | null,
  delta: {
    userId: string;
    timeKey: string;
    model?: string;
    provider?: string;
    input_tokens: number;
    output_tokens: number;
    cost: number;
  }
): DayStats {
  const base: DayStats = prev ?? {
    userId: delta.userId,
    period: "day",
    timeKey: delta.timeKey,
    total: { ...ZERO_STATS },
    models: {},
    providers: {},
  };

  const modelName = delta.model || "unknown";
  const providerName = delta.provider || "unknown";

  const inc = (s: ModelStats | undefined): ModelStats => ({
    count: (s?.count ?? 0) + 1,
    tokens: {
      input: (s?.tokens.input ?? 0) + delta.input_tokens,
      output: (s?.tokens.output ?? 0) + delta.output_tokens,
    },
    cost: Number(((s?.cost ?? 0) + delta.cost).toFixed(6)),
  });

  return {
    ...base,
    total: inc(base.total),
    models: {
      ...base.models,
      [modelName]: inc(base.models[modelName]),
    },
    providers: {
      ...base.providers,
      [providerName]: inc(base.providers[providerName]),
    },
  };
}