import type { Model } from "../../ai/llm/types";

/**
 * OpenCode Go 订阅模型清单。
 *
 * 来源：https://opencode.ai（OpenCode Go 订阅计划，$5 首月 / $10 月）
 * 接入方式：OpenAI 兼容模式
 *   Base URL: https://opencode.ai/zen/go/v1
 *
 * 说明：
 * - OpenCode Go 是订阅制（非按量），含多家厂商聚合模型：Grok/Kimi/Qwen/
 *   GLM/MiMo/MiniMax/DeepSeek。订阅按额度计量（约 $60/月价值），5 小时/每周限额。
 * - 订阅不按 token 计费，price 留 0（由订阅额度抵扣）。
 * - 模型清单随官方更新，可通过 GET /v1/models 实时校验。
 * - 与 OpenCode Zen（按量付费，充值余额）区分：Go 是订阅，Zen 是按量。
 * - hasVision 为实测值（2026-08-03，64×64 纯色图问主色）：网关按模型逐个转发，
 *   不是统一支持。glm-5.2 会静默丢掉图片并注入「我没有多模态能力」的
 *   system reminder（HTTP 200 但看不见图），mimo/deepseek 直接 400。
 *   gpt-* 只认字符串形式的 image_url，见 core/chat/bareImageUrlShape。
 */
export const opencodeGoModels: Model[] = [
  // ── OpenAI ──
  {
    name: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna (Fast)",
    hasVision: true,
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    price: { input: 0, output: 0 },
    provider: "opencode-go",
    description: "OpenAI GPT-5.6 Luna 快速模型，OpenCode Go 订阅含。",
  },
  // gpt-5.6-sol 不在 Go 订阅内：GET /models 不返回它，直接调用返回
  // 401 "Model gpt-5.6-sol is not supported"（实测 2026-08-03）。

  // ── Grok ──
  {
    name: "grok-4.5",
    displayName: "Grok 4.5",
    hasVision: true,
    contextWindow: 500_000,
    maxOutputTokens: 262_144,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    price: { input: 0, output: 0 },
    provider: "opencode-go",
    description: "xAI Grok 4.5，OpenCode Go 订阅含。",
  },

  // ── Kimi ──
  {
    name: "kimi-k3",
    displayName: "Kimi K3",
    hasVision: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 262_144,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    price: { input: 0, output: 0 },
    provider: "opencode-go",
    description: "Kimi K3 旗舰，OpenCode Go 订阅含。",
  },
  // ── Qwen ──
  {
    name: "qwen3.8-max",
    displayName: "Qwen3.8 Max",
    hasVision: true,
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    price: { input: 0, output: 0 },
    provider: "opencode-go",
    description: "千问 3.8 Max 旗舰，OpenCode Go 订阅含。",
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
    price: { input: 0, output: 0 },
    provider: "opencode-go",
    description: "千问 3.7 Max，OpenCode Go 订阅含。",
  },

  // ── GLM ──
  {
    name: "glm-5.2",
    displayName: "GLM 5.2",
    hasVision: false,
    contextWindow: 1_000_000,
    maxOutputTokens: 16_384,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    price: { input: 0, output: 0 },
    provider: "opencode-go",
    description: "智谱 GLM 5.2，OpenCode Go 订阅含。",
  },

  // ── MiMo ──
  {
    name: "mimo-v2.5-pro",
    displayName: "MiMo V2.5 Pro",
    hasVision: false,
    contextWindow: 131_072,
    maxOutputTokens: 16_384,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    price: { input: 0, output: 0 },
    provider: "opencode-go",
    description: "小米 MiMo V2.5 Pro，OpenCode Go 订阅含。",
  },

  // ── MiniMax ──
  {
    name: "minimax-m3",
    displayName: "MiniMax M3",
    hasVision: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 262_144,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    price: { input: 0, output: 0 },
    provider: "opencode-go",
    description: "MiniMax M3，OpenCode Go 订阅含。",
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
    price: { input: 0, output: 0 },
    provider: "opencode-go",
    description: "DeepSeek V4 Pro，OpenCode Go 订阅含。",
  },
  {
    name: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    hasVision: false,
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    price: { input: 0, output: 0 },
    provider: "opencode-go",
    description: "DeepSeek V4 Flash，OpenCode Go 订阅含。",
  },
];