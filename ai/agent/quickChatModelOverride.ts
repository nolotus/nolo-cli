// quick-chat 自动模式「模型层覆盖」：
// 用户在模式选择器里选定一个收藏 agent 后，LLM 分类路由仍然照跑
// （判断 needsWorkspace、路由专职 agent），只是当路由落到通用档
// （flash/balanced/quality 内置档位 agent）时，用该收藏 agent 的
// model 层配置替换档位 agent 的 model 层，并把它的 references
// （技能/能力包）合并进本轮执行。档位 agent 的 prompt / 工具策略不变。

import type { Agent, ReferenceItem } from "../../app/types";
import { mergeReferences } from "./referenceUtils";

/**
 * 覆盖包：从收藏 agent 提取的 model 层字段 + 技能引用。
 * 全部为 plain data，可随 runtimeOptions 跨 thunk 传递。
 */
export interface QuickChatModelOverride {
  provider: string;
  model: string;
  apiSource?: Agent["apiSource"];
  cliProvider?: Agent["cliProvider"];
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
  /** 收藏 agent 挂载的技能/知识引用，执行时与档位 agent 的 references 合并。 */
  references?: ReferenceItem[];
}

/**
 * 会被覆盖包整体替换的 model 层字段。
 * apply 时先从 base 上删掉这些 key，再写入覆盖值，
 * 避免 base（内置档位 agent）残留自己的凭证/采样配置。
 */
const MODEL_LAYER_KEYS = [
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

const pickIfDefined = <T>(value: T | undefined): value is T =>
  value !== undefined;

/**
 * 从收藏 agent 提取覆盖包。agent 缺少有效 provider/model 时返回 null
 * （调用方按「无覆盖」处理，走内置档位原样执行）。
 */
export function buildQuickChatModelOverride(
  agent: Pick<Agent, "provider" | "model"> & Partial<Agent>,
): QuickChatModelOverride | null {
  if (!agent || typeof agent.provider !== "string" || !agent.provider.trim()) {
    return null;
  }
  if (typeof agent.model !== "string" || !agent.model.trim()) {
    return null;
  }

  const override: QuickChatModelOverride = {
    provider: agent.provider,
    model: agent.model,
  };
  for (const key of MODEL_LAYER_KEYS) {
    if (key === "provider" || key === "model") continue;
    const value = agent[key as keyof typeof agent];
    if (pickIfDefined(value)) {
      (override as Record<string, unknown>)[key] = value;
    }
  }
  if (Array.isArray(agent.references) && agent.references.length > 0) {
    override.references = agent.references;
  }
  return override;
}

/**
 * 把覆盖包应用到档位 agent 配置上：替换 model 层字段，
 * 并把覆盖包的 references 合并进 base.references（dbKey 去重，base 优先）。
 * 不修改 base，返回新对象。
 */
export function applyQuickChatModelOverride(
  base: Agent,
  override: QuickChatModelOverride,
): Agent {
  const next: Record<string, unknown> = { ...base };
  for (const key of MODEL_LAYER_KEYS) {
    delete next[key];
  }
  for (const key of MODEL_LAYER_KEYS) {
    const value = override[key as keyof QuickChatModelOverride];
    if (pickIfDefined(value)) {
      next[key] = value;
    }
  }
  const merged = mergeReferences(base.references, override.references);
  if (merged.length > 0) {
    next.references = merged;
  } else {
    delete next.references;
  }
  return next as Agent;
}
