import type { Model } from "../../ai/llm/types";

/**
 * 千问 AI 平台（DashScope）模型清单。
 *
 * 来源：https://platform.qianwenai.com/docs/developer-guides/getting-started/text-generation-models
 * 接入方式：OpenAI 兼容模式
 *   Base URL: https://dashscope.aliyuncs.com/compatible-mode/v1
 *
 * 说明：
 * - 国内服务，人民币计价，价格不乘以汇率系数（与 deepSeekModels 一致）。
 * - 仅收录 OpenAI 兼容模式下常用的主力/旗舰模型；千问平台还提供大量带日期后缀的
 *   快照版本（如 qwen3-max-2025-09-23）、开源权重版本（qwen2.5-*）、音频/图像/
 *   向量等模态，可按需扩展。
 * - contextWindow 单位为 token；能力标记依据平台「文本生成模型」支持矩阵。
 */
export const qwenModels: Model[] = [
  // ── Qwen3 旗舰 ──
  {
    name: "qwen3-max",
    displayName: "Qwen3 Max",
    hasVision: true,
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 6, output: 24 },
    provider: "qwen",
    description: "千问3 旗舰模型，支持思考模式、函数调用、结构化输出。",
  },
  {
    name: "qwen3-max-preview",
    displayName: "Qwen3 Max Preview",
    hasVision: true,
    contextWindow: 81_920,
    maxOutputTokens: 32_768,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 6, output: 24 },
    provider: "qwen",
  },
  {
    name: "qwen3-235b-a22b-instruct-2507",
    displayName: "Qwen3 235B A22B Instruct",
    hasVision: true,
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 4, output: 12 },
    provider: "qwen",
  },
  {
    name: "qwen3-next-80b-a3b-instruct",
    displayName: "Qwen3 Next 80B A3B Instruct",
    hasVision: true,
    contextWindow: 81_920,
    maxOutputTokens: 32_768,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 2, output: 6 },
    provider: "qwen",
  },

  // ── Qwen3-Coder 编程系列 ──
  {
    name: "qwen3-coder-plus",
    displayName: "Qwen3 Coder Plus",
    hasVision: false,
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 3, output: 9 },
    provider: "qwen",
    description: "千问3 编程旗舰，1M 长上下文，适合代码生成与 Agent 编程。",
  },
  {
    name: "qwen3-coder-flash",
    displayName: "Qwen3 Coder Flash",
    hasVision: false,
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 1, output: 3 },
    provider: "qwen",
  },
  {
    name: "qwen3-coder-480b-a35b-instruct",
    displayName: "Qwen3 Coder 480B A35B Instruct",
    hasVision: false,
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 5, output: 15 },
    provider: "qwen",
  },

  // ── 长上下文 ──
  {
    name: "qwen-long",
    displayName: "Qwen Long",
    hasVision: false,
    contextWindow: 10_485_760,
    maxOutputTokens: 8_192,
    jsonOutput: true,
    fnCall: false,
    supportsTool: false,
    price: { input: 0.5, output: 2 },
    provider: "qwen",
    description: "10M 超长上下文，适合长文档处理。",
  },

  // ── 旧版主力（仍常用） ──
  {
    name: "qwen-plus",
    displayName: "Qwen Plus",
    hasVision: true,
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 0.8, output: 2 },
    provider: "qwen",
  },
  {
    name: "qwen-turbo",
    displayName: "Qwen Turbo",
    hasVision: false,
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    price: { input: 0.3, output: 0.6 },
    provider: "qwen",
  },
  {
    name: "qwen-flash",
    displayName: "Qwen Flash",
    hasVision: false,
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    price: { input: 0.1, output: 0.3 },
    provider: "qwen",
  },

  // ── 推理（QwQ） ──
  {
    name: "qwq-plus",
    displayName: "QwQ Plus",
    hasVision: false,
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 2, output: 8 },
    provider: "qwen",
    description: "深度思考推理模型。",
  },
];

/**
 * 千问 Token Plan（个人版）订阅支持的模型清单。
 *
 * 来源：https://platform.qianwenai.com/docs/token-plan/personal/token-plan-personal-overview#支持的模型
 *
 * Token Plan 是 Credits 统一计量、每 7 天 / 每 5 小时限额的订阅制，
 * 模型范围与按量计费的 DashScope API 不同——这里聚合了千问、智谱、DeepSeek、
 * 万相等多家模型，因此单列一份，不要与 qwenModels（DashScope API）混用。
 *
 * 价格：订阅不按 token 计费，price 留 0（由 Credits 抵扣，不在本表体现）。
 */
export const qwenTokenPlanModels: Model[] = [
  // ── 千问 ──
  {
    name: "qwen3.8-max-preview",
    displayName: "Qwen3.8 Max Preview",
    hasVision: true,
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 0, output: 0 },
    provider: "qwen",
    description: "推理模型、视觉理解、文本生成（预览版）。",
  },
  {
    name: "qwen3.7-max",
    displayName: "Qwen3.7 Max",
    hasVision: false,
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 0, output: 0 },
    provider: "qwen",
    description: "推理模型、文本生成。",
  },
  {
    name: "qwen3.7-plus",
    displayName: "Qwen3.7 Plus",
    hasVision: true,
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 0, output: 0 },
    provider: "qwen",
    description: "推理模型、视觉理解、文本生成。",
  },
  {
    name: "qwen3.6-flash",
    displayName: "Qwen3.6 Flash",
    hasVision: true,
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 0, output: 0 },
    provider: "qwen",
    description: "推理模型、视觉理解、文本生成（轻量快速）。",
  },

  // ── 智谱 AI ──
  {
    name: "glm-5.2",
    displayName: "GLM 5.2",
    hasVision: false,
    contextWindow: 1_000_000,
    maxOutputTokens: 16_384,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 0, output: 0 },
    provider: "qwen",
    description: "智谱 AI 推理模型、文本生成。",
  },

  // ── DeepSeek ──
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
    price: { input: 0, output: 0 },
    provider: "qwen",
    description: "DeepSeek 推理模型、文本生成。",
  },

  // ── 万相（图片生成）──
  {
    name: "wan2.7-image",
    displayName: "Wan2.7 Image",
    hasVision: false,
    hasImageOutput: true,
    contextWindow: 0,
    maxOutputTokens: 0,
    price: { input: 0, output: 0 },
    provider: "qwen",
    description: "万相图片生成。",
  },
  {
    name: "wan2.7-image-pro",
    displayName: "Wan2.7 Image Pro",
    hasVision: false,
    hasImageOutput: true,
    contextWindow: 0,
    maxOutputTokens: 0,
    price: { input: 0, output: 0 },
    provider: "qwen",
    description: "万相图片生成（Pro）。",
  },
];