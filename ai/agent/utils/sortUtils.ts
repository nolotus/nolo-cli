// packages/ai/agent/utils/sortUtils.ts
import type { Agent } from "../../../app/types";
import { asOptionalFiniteNumber } from "../../../core/optionalNumber";

export interface SortMeta {
  createdAtMs: number;
  publishedAtMs: number;
  outputPriceNum: number;
  useCount: number;
  rating: number;
  favoriteCount: number;
  completenessScore: number;
  recommendedScore: number;
}

export type MAgent = Agent & { __sort?: SortMeta };

export const RECOMMENDED_COMPLETENESS_WEIGHTS = {
  name: 0.1,
  introduction: 0.45,
  cover: 0.2,
  tags: 0.15,
  tools: 0.1,
  greeting: 0.1,
} as const;

export const RECOMMENDED_FRESHNESS_BUCKETS = [
  { maxAgeDays: 3, score: 1 },
  { maxAgeDays: 7, score: 0.7 },
  { maxAgeDays: 21, score: 0.35 },
  { maxAgeDays: 45, score: 0.15 },
] as const;

export const RECOMMENDED_COLD_START_BUCKETS = [
  { maxFavoriteCount: 0, maxAgeDays: 7, score: 0.75 },
  { maxFavoriteCount: 2, maxAgeDays: 14, score: 0.35 },
] as const;

export const RECOMMENDED_SCORE_WEIGHTS = {
  favoriteLogWeight: 4,
  freshnessWeight: 2,
  completenessWeight: 1.5,
} as const;

export function toNumber(n: unknown, fallback: number) {
  const v = typeof n === "number" ? n : parseFloat(String(n));
  return Number.isFinite(v) ? v : fallback;
}

export function toTimeMs(t: unknown) {
  if (typeof t === "number") return t;
  const n = Date.parse(String(t ?? 0));
  return Number.isFinite(n) ? n : 0;
}

export function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : parseFloat(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function hasNonEmptyText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function getCompletenessScore(agent?: Agent) {
  if (!agent) return 0;

  let score = 0;
  if (hasNonEmptyText(agent.name)) score += RECOMMENDED_COMPLETENESS_WEIGHTS.name;
  if (hasNonEmptyText(agent.introduction)) {
    score += RECOMMENDED_COMPLETENESS_WEIGHTS.introduction;
  }
  if (hasNonEmptyText(agent.cover)) score += RECOMMENDED_COMPLETENESS_WEIGHTS.cover;
  if (Array.isArray(agent.tags) && agent.tags.length > 0) {
    score += RECOMMENDED_COMPLETENESS_WEIGHTS.tags;
  }
  if (Array.isArray(agent.tools) && agent.tools.length > 0) {
    score += RECOMMENDED_COMPLETENESS_WEIGHTS.tools;
  }
  if (
    hasNonEmptyText(agent.greeting) ||
    (agent.greeting &&
      typeof agent.greeting === "object" &&
      hasNonEmptyText((agent.greeting as { text?: string }).text))
  ) {
    score += RECOMMENDED_COMPLETENESS_WEIGHTS.greeting;
  }
  return score;
}

function getFreshnessScore(ageDays: number) {
  for (const bucket of RECOMMENDED_FRESHNESS_BUCKETS) {
    if (ageDays <= bucket.maxAgeDays) return bucket.score;
  }
  return 0;
}

function getColdStartBoost(ageDays: number, favoriteCount: number) {
  for (const bucket of RECOMMENDED_COLD_START_BUCKETS) {
    if (favoriteCount <= bucket.maxFavoriteCount && ageDays <= bucket.maxAgeDays) {
      return bucket.score;
    }
  }
  return 0;
}

export function getRecommendedScore({
  favoriteCount,
  publishedAtMs,
  completenessScore,
}: {
  favoriteCount: number;
  publishedAtMs: number;
  completenessScore: number;
}) {
  const ageMs = Math.max(0, Date.now() - publishedAtMs);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const freshnessScore = getFreshnessScore(ageDays);
  const coldStartBoost = getColdStartBoost(ageDays, favoriteCount);

  // Intentionally exclude useCount/dialogCount here until those signals are
  // written consistently across the public-agent pipeline.
  return Math.log1p(Math.max(0, favoriteCount)) *
    RECOMMENDED_SCORE_WEIGHTS.favoriteLogWeight +
    freshnessScore * RECOMMENDED_SCORE_WEIGHTS.freshnessWeight +
    completenessScore * RECOMMENDED_SCORE_WEIGHTS.completenessWeight +
    coldStartBoost;
}

/**
 * 根据本地与远程条目构建排序元信息
 */
export function buildSortMeta(local?: Agent, remote?: Agent): SortMeta {
  const createdAtMs = Math.max(
    toTimeMs(remote?.updatedAt ?? remote?.createdAt),
    toTimeMs(local?.updatedAt ?? local?.createdAt)
  );
  const publishedAtMs = Math.max(
    toTimeMs(remote?.createdAt),
    toTimeMs(local?.createdAt)
  );

  const outputPriceNum = firstFiniteNumber(
    (remote as any)?.outputPrice,
    (local as any)?.outputPrice
  );

  const useCount = firstFiniteNumber(
    (remote as any)?.metrics?.useCount,
    (local as any)?.metrics?.useCount,
    (remote as any)?.dialogCount,
    (local as any)?.dialogCount
  );

  const rating = firstFiniteNumber(
    (remote as any)?.metrics?.rating,
    (local as any)?.metrics?.rating,
    (remote as any)?.messageCount,
    (local as any)?.messageCount
  );

  const favoriteCount = firstFiniteNumber(
    (remote as any)?.metrics?.favoriteCount,
    (local as any)?.metrics?.favoriteCount
  );

  const completenessScore = Math.max(
    getCompletenessScore(local),
    getCompletenessScore(remote)
  );
  const normalizedFavoriteCount = asOptionalFiniteNumber(favoriteCount) ?? 0;
  const normalizedPublishedAtMs = publishedAtMs || createdAtMs;
  const recommendedScore = getRecommendedScore({
    favoriteCount: normalizedFavoriteCount,
    publishedAtMs: normalizedPublishedAtMs,
    completenessScore,
  });

  return {
    createdAtMs,
    publishedAtMs: normalizedPublishedAtMs,
    outputPriceNum:
      asOptionalFiniteNumber(outputPriceNum) ?? Number.POSITIVE_INFINITY,
    useCount: asOptionalFiniteNumber(useCount) ?? 0,
    rating: asOptionalFiniteNumber(rating) ?? 0,
    favoriteCount: normalizedFavoriteCount,
    completenessScore,
    recommendedScore,
  };
}

/**
 * 统一的智能体排序逻辑
 */
export const sortAgents = (
  agents: Agent[],
  sortBy:
    | "recommended"
    | "newest"
    | "popular"
    | "rating"
    | "outputPriceAsc"
    | "outputPriceDesc"
    | "favorite"
    | string
): Agent[] => {
  const arr = agents.map((agent) => {
    const typed = agent as MAgent;
    return typed.__sort ? typed : { ...typed, __sort: buildSortMeta(agent) };
  });

  arr.sort((a, b) => {
    const sa = a.__sort!;
    const sb = b.__sort!;
    let diff = 0;

    switch (sortBy) {
      case "recommended":
        diff = sb.recommendedScore - sa.recommendedScore;
        break;
      case "popular":
        diff = sb.useCount - sa.useCount;
        break;
      case "rating":
        diff = sb.rating - sa.rating;
        break;
      case "favorite":
        diff = sb.favoriteCount - sa.favoriteCount;
        break;
      case "outputPriceAsc":
        diff = sa.outputPriceNum - sb.outputPriceNum;
        break;
      case "outputPriceDesc":
        diff = sb.outputPriceNum - sa.outputPriceNum;
        break;
      case "newest":
      default:
        diff = sb.createdAtMs - sa.createdAtMs;
        break;
    }

    if (diff !== 0) return diff;
    return String(a.id).localeCompare(String(b.id));
  });

  return arr;
};

export interface SortableAgentItem {
  key: string;
  favoritedAt?: number;
  isOwned?: boolean;
  isPublic?: boolean;
  updatedAt?: number;
  /** insertion-order 兜底：同组同 timestamp 时用此值稳定排序（如推荐目录顺序）。 */
  order?: number;
  [extra: string]: unknown;
}

export function sortAgentsFavoriteOwnedPublic<T extends SortableAgentItem>(
  items: readonly T[]
): T[] {
  // 1. 按 key 去重：Map<key, T>，后出现的同 key 合并到先出现的
  // - favoritedAt: 取有值的那个（都有值取较大）
  // - isOwned/isPublic: OR
  // - updatedAt: 取较大值
  const map = new Map<string, T>();
  for (const item of items) {
    const existing = map.get(item.key);
    if (!existing) {
      map.set(item.key, { ...item });
      continue;
    }
    map.set(item.key, {
      ...existing,
      ...item,
      key: existing.key,
      favoritedAt: Math.max(existing.favoritedAt ?? 0, item.favoritedAt ?? 0) || undefined,
      isOwned: Boolean(existing.isOwned || item.isOwned),
      isPublic: Boolean(existing.isPublic || item.isPublic),
      updatedAt: Math.max(existing.updatedAt ?? 0, item.updatedAt ?? 0),
      order: existing.order ?? item.order,
    });
  }

  const arr = Array.from(map.values());

  // 2. 排序：收藏组(favoritedAt有值) → 自建(isOwned) → 公开(isPublic)
  //    各组内按对应 timestamp 倒序 → key 兜底
  arr.sort((a, b) => {
    const aFav = a.favoritedAt != null && a.favoritedAt > 0;
    const bFav = b.favoritedAt != null && b.favoritedAt > 0;
    if (aFav !== bFav) return aFav ? -1 : 1;
    if (aFav && bFav) {
      const diff = (b.favoritedAt ?? 0) - (a.favoritedAt ?? 0);
      if (diff !== 0) return diff;
    }
    // 非收藏组内：自建(owned) 排在 公开(public) 前；都不是的排最后
    const aOwned = Boolean(a.isOwned);
    const bOwned = Boolean(b.isOwned);
    if (aOwned !== bOwned) return aOwned ? -1 : 1;
    const aPublic = Boolean(a.isPublic);
    const bPublic = Boolean(b.isPublic);
    if (aPublic !== bPublic) return aPublic ? -1 : 1;
    const tsDiff = (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    if (tsDiff !== 0) return tsDiff;
    // order 兜底（如推荐目录顺序），无 order 时退回 key
    const aOrder = a.order ?? Number.POSITIVE_INFINITY;
    const bOrder = b.order ?? Number.POSITIVE_INFINITY;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.key.localeCompare(b.key);
  });

  return arr;
}
