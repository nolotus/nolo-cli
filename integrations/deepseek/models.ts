import { Model } from "../../ai/llm/types";

// 备注: 因为是中文(国内服务直接人民币计价)，所以不用乘以 7
export const deepSeekModels: Model[] = [
  {
    name: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    hasVision: false,
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: {
      input: 1,
      inputCacheHit: 0.02,
      output: 2,
    },
  },
  {
    name: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    hasVision: false,
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: {
      input: 3,
      inputCacheHit: 0.1,
      output: 6,
    },
  },
];
