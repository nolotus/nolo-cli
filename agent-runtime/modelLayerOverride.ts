// 「模型层覆盖」纯逻辑（web / CLI / server 三方共享的单一真相源）。
//
// 语义：用户选定一个 agent 作为覆盖源后，路由/档位机制照跑；落到通用档时，
// 用覆盖源 agent 的 model 层配置（provider/model/apiSource/凭证/采样参数）
// 替换档位 agent 的 model 层，并把覆盖源的 references（技能/能力包）合并进去。
// 档位 agent 的 prompt / 工具策略保持不变。
//
// 本文件不依赖 app/ 层或 redux；record 一律按 Record<string, unknown> 处理。

export interface ReferenceItemLike {
  dbKey: string;
  title?: string;
  type?: string;
  [key: string]: unknown;
}

/** 覆盖包：从覆盖源 agent 提取的 model 层字段 + 技能引用（plain data，可序列化）。 */
export interface ModelLayerOverride {
  provider: string;
  model: string;
  apiSource?: string;
  cliProvider?: string;
  useServerProxy?: boolean;
  apiKey?: string;
  apiKeyRef?: string;
  apiKeyHeader?: string;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  max_tokens?: number;
  reasoning_effort?: string;
  enableThinking?: boolean;
  thinkingBudget?: number;
  /** 覆盖源挂载的技能/知识引用，执行时与档位 agent 的 references 合并。 */
  references?: ReferenceItemLike[];
}

/**
 * 会被覆盖包整体替换的 model 层字段。
 * apply 时先从 base 上删掉这些 key，再写入覆盖值，
 * 避免 base（内置档位 agent）残留自己的凭证/采样配置。
 */
export const MODEL_LAYER_KEYS = [
  "provider",
  "model",
  "apiSource",
  "cliProvider",
  "useServerProxy",
  "apiKey",
  "apiKeyRef",
  "apiKeyHeader",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "max_tokens",
  "reasoning_effort",
  "enableThinking",
  "thinkingBudget",
] as const;

/** 按 dbKey 去重合并 references，base 优先。 */
export function mergeReferences(
  base?: readonly ReferenceItemLike[] | null,
  extra?: readonly ReferenceItemLike[] | null,
): ReferenceItemLike[] {
  const safeBase = Array.isArray(base) ? base : [];
  const safeExtra = Array.isArray(extra) ? extra : [];

  const seen = new Set<string>();
  const merged: ReferenceItemLike[] = [];

  for (const item of [...safeBase, ...safeExtra]) {
    const key = item?.dbKey;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    if (item) merged.push(item);
  }
  return merged;
}

const asNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * 从覆盖源 agent record 提取覆盖包。
 * 缺少有效 provider/model 时返回 null（调用方按「无覆盖」处理）。
 */
export function buildModelLayerOverride(
  agent: Record<string, unknown> | null | undefined,
): ModelLayerOverride | null {
  if (!agent || !asNonEmptyString(agent.provider) || !asNonEmptyString(agent.model)) {
    return null;
  }

  const override: ModelLayerOverride = {
    provider: agent.provider,
    model: agent.model,
  };
  for (const key of MODEL_LAYER_KEYS) {
    if (key === "provider" || key === "model") continue;
    const value = agent[key];
    if (value !== undefined) {
      (override as unknown as Record<string, unknown>)[key] = value;
    }
  }
  if (Array.isArray(agent.references) && agent.references.length > 0) {
    override.references = agent.references as ReferenceItemLike[];
  }
  return override;
}

/**
 * 把覆盖包应用到档位 agent record 上：替换 model 层字段，
 * 并把覆盖包的 references 合并进 base.references（dbKey 去重，base 优先）。
 * 不修改 base，返回新对象。
 */
export function applyModelLayerOverride<T extends Record<string, unknown>>(
  base: T,
  override: ModelLayerOverride,
): T {
  const next: Record<string, unknown> = { ...base };
  for (const key of MODEL_LAYER_KEYS) {
    delete next[key];
  }
  for (const key of MODEL_LAYER_KEYS) {
    const value = override[key as keyof ModelLayerOverride];
    if (value !== undefined) {
      next[key] = value;
    }
  }
  const merged = mergeReferences(
    base.references as ReferenceItemLike[] | undefined,
    override.references,
  );
  if (merged.length > 0) {
    next.references = merged;
  } else {
    delete next.references;
  }
  return next as T;
}
