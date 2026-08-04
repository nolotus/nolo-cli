// ai/llm/getModelContextWindow.ts

/**
 * 获取指定模型的 Context Window 大小。
 *
 * 数据真值源是 providers.ts 的全量 `MODEL_LOOKUP_MAP`（覆盖 anthropic / xai /
 * deepseek / google / openai / deepinfra / openrouter / fireworks / nolo /
 * cloudflare / gmi / zai / qwen / moonshot 全部 provider 的模型，含 DashScope
 * 按量表与 Qwen Token Plan 订阅表）。这里按 `name` 与 `displayName` 双键建索引，
 * 因此无论传入的是模型 id（如 "qwen3.8-max"）还是显示名
 * （如 "Qwen3.8 Max"）都能精确命中数据表里的 contextWindow。
 *
 * 早先本函数只查 `ALL_MODELS`，而 ALL_MODELS 不含 qwen / moonshot / anthropic，
 * 导致这些模型的显示名/id 全部落到兜底默认值（256k），状态栏 context 显示失真。
 * 改用全量表后，数据文件成为唯一权威源；下面的 fuzzy 仅用于数据表外的自定义
 * 模型名 / 命名变体兜底。
 *
 * 注意：`getModelInfo` 故意仍用 `ALL_MODELS`（见下文），以保持图像生成能力判定
 * （supportsImageGeneration）等下游行为不变——扩大 getModelInfo 的覆盖会改变
 * 那些「靠 getModelInfo 返回 null 走兜底分支」的模型的判定结果，属于越界副作用。
 */
import { MODEL_LOOKUP_MAP } from "./providers";
import { ALL_MODELS, type ModelWithProvider } from "./models";
import type { Model } from "./types";

// 默认 Context Window（用于数据表外的未知模型）
export const DEFAULT_CONTEXT_WINDOW = 256_000;

// 以下常量被 fuzzyContextWindow 使用（非死代码）。modelRegistry.test 以 readFileSync 读源码，
// 用 toContain 锁定「常量定义字面量」与「fuzzy 规则字符串」确在本文件出现，故常量名/数值/
// fuzzy 字符串勿删勿改名，否则该源码断言失败。注意：测试并未 import 这两个具名常量。
const QWEN_3_6_CONTEXT_WINDOW = 262_144;
const GLM_5_2_CONTEXT_WINDOW = 1_000_000;

// 全量模型映射表（context window 解析用）：name + displayName 双键，值带 provider。
let fullModelMap: Map<string, ModelWithProvider> | null = null;

const getFullModelMap = (): Map<string, ModelWithProvider> => {
  if (!fullModelMap) {
    fullModelMap = new Map();
    for (const [provider, models] of Object.entries(MODEL_LOOKUP_MAP)) {
      for (const model of models as readonly Model[]) {
        const entry: ModelWithProvider = { ...model, provider };
        fullModelMap.set(model.name, entry);
        // 也按 displayName 索引（如果有），统一小写以匹配 TUI 传入的显示名
        if (model.displayName) {
          fullModelMap.set(model.displayName.toLowerCase(), entry);
        }
      }
    }
  }
  return fullModelMap;
};

// 旧映射表（仅 ALL_MODELS）：getModelInfo 专用，保持下游能力判定行为不变。
let legacyModelMap: Map<string, ModelWithProvider> | null = null;

const getLegacyModelMap = (): Map<string, ModelWithProvider> => {
  if (!legacyModelMap) {
    legacyModelMap = new Map();
    for (const model of ALL_MODELS) {
      legacyModelMap.set(model.name, model);
      if (model.displayName) {
        legacyModelMap.set(model.displayName.toLowerCase(), model);
      }
    }
  }
  return legacyModelMap;
};

/**
 * 数据表外的命名变体兜底。顺序敏感：更具体的模式在前。
 * 多数标准名已被 getFullModelMap 精确命中，本函数只在 map miss 时触发。
 */
function fuzzyContextWindow(normalizedName: string): number | undefined {
  // 超长上下文 / 编程系列（具体模式优先，避免被下面的版本号规则吞掉）
  if (normalizedName.includes("qwen-long") || normalizedName.includes("qwen3-long")) return 10_485_760;
  if (normalizedName.includes("qwen-coder") || normalizedName.includes("qwen3-coder")) return 1_048_576;
  // 1M 档
  if (normalizedName.includes("qwen3.8") || normalizedName.includes("qwen3p8")) return 1_000_000;
  if (normalizedName.includes("minimax-m3") || normalizedName.includes("minimax_m3")) return 1_000_000;
  if (normalizedName.includes("glm-5.2") || normalizedName.includes("glm5.2")) return GLM_5_2_CONTEXT_WINDOW;
  if (normalizedName.includes("deepseek")) return 1_000_000;
  if (normalizedName.includes("gpt-5") || normalizedName.includes("gpt-4.1")) return 1_047_576;
  // Cursor OAuth 模型（providerRegistry cursor-oauth preset，id 以 Cursor GetUsableModels 为准）。
  // Grok 4.5 / Claude 4.6 / Gemini 3.1 Pro 在 Cursor 内均为 1M 级上下文；claude-4.6-* 必须先于
  // 下方通用 "claude" → 200k 规则，否则会落 200k。Composer 2.5 未公布固定窗口，不在此显式返回
  // （保持默认 256k）。gpt-5.3-codex / gpt-5.4-medium 已命中上方 gpt-5 规则，无需重复。
  if (normalizedName.startsWith("cursor-grok-4.5")) return 1_000_000;
  if (normalizedName.includes("claude-4.6")) return 1_000_000;
  if (normalizedName.includes("gemini-3.1")) return 1_000_000;
  // 256k 档
  if (normalizedName.includes("qwen3.6") || normalizedName.includes("qwen3p6")) return QWEN_3_6_CONTEXT_WINDOW;
  if (normalizedName.includes("qwen3.7") || normalizedName.includes("qwen3p7")) return 262_144;
  if (normalizedName.includes("minimax-m2") || normalizedName.includes("minimax_m2")) return 262_144;
  // 200k 档
  if (normalizedName.includes("claude")) return 200_000;
  return undefined;
}

/**
 * 根据模型名称获取 Context Window 大小
 * @param modelName 模型名称或显示名（如 "qwen3.8-max" / "Qwen3.8 Max"）
 * @returns Context Window 大小（tokens）
 */
export const getModelContextWindow = (modelName: string): number => {
  if (!modelName) return DEFAULT_CONTEXT_WINDOW;

  const normalizedName = modelName.toLowerCase();
  const map = getFullModelMap();
  const model = map.get(modelName) || map.get(normalizedName);

  if (model?.contextWindow) {
    return typeof model.contextWindow === "number"
      ? model.contextWindow
      : DEFAULT_CONTEXT_WINDOW;
  }

  return fuzzyContextWindow(normalizedName) ?? DEFAULT_CONTEXT_WINDOW;
};

/**
 * 获取模型的完整信息。
 *
 * 仍基于 `ALL_MODELS`（不含 qwen / moonshot / anthropic），与历史行为一致：
 * 扩大覆盖会改变 supportsImageGeneration 等「依赖 getModelInfo 返回 null 走兜底」
 * 的下游判定，故此处刻意不切全量表。
 */
export const getModelInfo = (modelName: string): ModelWithProvider | null => {
  if (!modelName) return null;
  const map = getLegacyModelMap();
  return map.get(modelName) || map.get(modelName.toLowerCase()) || null;
};

// getModelMaxOutputTokens 已删除（零引用死函数）。
//
// 它按 ALL_MODELS 的 maxOutputTokens 返回"模型输出上限"、缺失时兜底 4096，看起来可以
// 用来给请求填 max_tokens——不要这么做。那份数据从未被任何真实请求验证过，实测已知至少
// 两处失真：deepseek-v4-pro 标 384000（是 contextWindow 抄进了 output 字段，实际约 4K 就
// 被截断），deepinfra 的 Claude 系标 4092（远低于这些模型的真实输出能力）。
//
// 输出上限的真值在 provider 手里。agent 没显式配 max_tokens 时就不要发这个参数，让 provider
// 用自己的默认；需要控制的场景走 agent 高级设置里的显式 max_tokens。
// 截断本身由 finish_reason === "length" 上报（见 packages/agent-runtime/types.ts）。

/**
 * 获取模型是否支持视觉
 */
export const getModelHasVision = (modelName: string): boolean => {
  const model = getModelInfo(modelName);
  return model?.hasVision ?? false;
};
