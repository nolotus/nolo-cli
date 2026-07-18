// ai/llm/getModelContextWindow.ts

/**
 * 获取指定模型的 Context Window 大小。
 * 
 * 复用 ALL_MODELS 数据源，保持与模型选择器的一致性。
 */

import { ALL_MODELS, type ModelWithProvider } from "./models";

// 默认 Context Window（用于未知模型）
export const DEFAULT_CONTEXT_WINDOW = 256_000;
const QWEN_3_6_CONTEXT_WINDOW = 262_144;
const GLM_5_2_CONTEXT_WINDOW = 1_000_000;

// 缓存模型映射表
let modelMap: Map<string, ModelWithProvider> | null = null;

const getModelMap = (): Map<string, ModelWithProvider> => {
    if (!modelMap) {
        modelMap = new Map();
        for (const model of ALL_MODELS) {
            modelMap.set(model.name, model);
            // 也按 displayName 索引（如果有）
            if (model.displayName) {
                modelMap.set(model.displayName.toLowerCase(), model);
            }
        }
    }
    return modelMap;
};

/**
 * 根据模型名称获取 Context Window 大小
 * @param modelName 模型名称（如 "gpt-4o", "claude-3-5-sonnet"）
 * @returns Context Window 大小（tokens）
 */
export const getModelContextWindow = (modelName: string): number => {
  if (!modelName) return DEFAULT_CONTEXT_WINDOW;

  const normalizedName = modelName.toLowerCase();
  const map = getModelMap();
  const model =
    map.get(modelName) ||
    map.get(normalizedName);

    if (model?.contextWindow) {
        return typeof model.contextWindow === "number"
            ? model.contextWindow
            : DEFAULT_CONTEXT_WINDOW;
    }

    if (
        normalizedName.includes("qwen3.6") ||
        normalizedName.includes("qwen3p6")
    ) {
        return QWEN_3_6_CONTEXT_WINDOW;
    }

    // 处理 GLM 5.2 的变体命名（如 opencode-glm-5.2、glm5.2 等）
    if (
        normalizedName.includes("glm-5.2") ||
        normalizedName.includes("glm5.2")
    ) {
        return GLM_5_2_CONTEXT_WINDOW;
    }

    return DEFAULT_CONTEXT_WINDOW;
};

/**
 * 获取模型的完整信息
 */
export const getModelInfo = (modelName: string): ModelWithProvider | null => {
  if (!modelName) return null;

  const map = getModelMap();
  return (
    map.get(modelName) ||
    map.get(modelName.toLowerCase()) ||
    null
  );
};

/**
 * 获取模型的 Max Output Tokens
 */
export const getModelMaxOutputTokens = (modelName: string): number => {
    const model = getModelInfo(modelName);
    if (model?.maxOutputTokens && typeof model.maxOutputTokens === "number") {
        return model.maxOutputTokens;
    }
    return 4096; // 保守默认值
};

/**
 * 获取模型是否支持视觉
 */
export const getModelHasVision = (modelName: string): boolean => {
    const model = getModelInfo(modelName);
    return model?.hasVision ?? false;
};
