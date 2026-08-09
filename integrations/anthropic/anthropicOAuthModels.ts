// integrations/anthropic/anthropicOAuthModels.ts
//
// Claude OAuth 订阅通道（apiKeyRef="claude"）专属模型表。
//
// 数据来源（2026-08-09 实测 + 官方文档）：
// - 模型全集：GET https://api.anthropic.com/v1/models（OAuth token 直调，返回恰好
//   10 个，has_more=false）。与 API 通道的 anthropicModels.ts（sk-ant-* key 模型集）
//   完全不同——API 表里的 claude-3-5-haiku-20241022 / claude-3-7-sonnet-latest 等
//   在 OAuth 下实测 404，切勿混用。
// - contextWindow / thinking 模式：官方 Models overview 明确 5 代（fable/opus/
//   sonnet-5）= 1M + Adaptive thinking(always on)；claude-haiku-4-5-20251001 =
//   200k + Extended thinking；4.6/4.7/4.8 系官方未单列（参照 fuzzy 规则
//   claude-4.6→1M 及旗舰定位标注 1M，如需精确值可后续实测校正）。
//
// 价格：OAuth 订阅制，按量计费在 resolveBillable 层已返回 false（不扣费），
// 此处 price 填 0 表示"订阅已付、不按量计费"，避免展示/统计误计费。
//
// thinkingMode（权威来源，provider 读此判定而非自己硬编码）：
// - "adaptive"：5 代 + 4.6/4.7/4.8 系（官方 Adaptive thinking）
// - "extended"：4.5 及更早（官方 Extended thinking(enabled)）

import type { Model } from "../../ai/llm/types";

type OAuthModelSpec = {
  name: string;
  displayName: string;
  contextWindow: number;
  thinkingMode: "adaptive" | "extended";
  /** 仅 5 代（官方 max output 128k）；4.x 系未公布/未填，保持与原表一致。 */
  maxOutputTokens?: number;
};

const oauthModel = ({ name, displayName, contextWindow, thinkingMode, maxOutputTokens }: OAuthModelSpec): Model => ({
  name,
  displayName,
  hasVision: true,
  description: `OAuth 订阅模型（${displayName}，${thinkingMode === "adaptive" ? "Adaptive thinking" : "Extended thinking"}）`,
  contextWindow,
  ...(maxOutputTokens ? { maxOutputTokens } : {}),
  supportsReasoningEffort: true,
  price: { input: 0, output: 0 },
});

export const anthropicOAuthModels: Model[] = [
  // 5 代（1M + Adaptive thinking always-on；官方 max output 128k）
  oauthModel({ name: "claude-fable-5", displayName: "Claude Fable 5", contextWindow: 1_000_000, thinkingMode: "adaptive", maxOutputTokens: 128_000 }),
  oauthModel({ name: "claude-opus-5", displayName: "Claude Opus 5", contextWindow: 1_000_000, thinkingMode: "adaptive", maxOutputTokens: 128_000 }),
  oauthModel({ name: "claude-sonnet-5", displayName: "Claude Sonnet 5", contextWindow: 1_000_000, thinkingMode: "adaptive", maxOutputTokens: 128_000 }),
  // 4.6/4.7/4.8 系（Adaptive thinking；context 官方未单列，参照 fuzzy claude-4.6→1M）
  oauthModel({ name: "claude-opus-4-8", displayName: "Claude Opus 4.8", contextWindow: 1_000_000, thinkingMode: "adaptive" }),
  oauthModel({ name: "claude-opus-4-7", displayName: "Claude Opus 4.7", contextWindow: 1_000_000, thinkingMode: "adaptive" }),
  oauthModel({ name: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", contextWindow: 1_000_000, thinkingMode: "adaptive" }),
  oauthModel({ name: "claude-opus-4-6", displayName: "Claude Opus 4.6", contextWindow: 1_000_000, thinkingMode: "adaptive" }),
  // 4.5 系（Extended thinking；官方发布规格 1M）
  oauthModel({ name: "claude-opus-4-5-20251101", displayName: "Claude Opus 4.5", contextWindow: 1_000_000, thinkingMode: "extended" }),
  oauthModel({ name: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5", contextWindow: 1_000_000, thinkingMode: "extended" }),
  // haiku-4-5（官方明确 context=200k + Extended thinking）
  oauthModel({ name: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", contextWindow: 200_000, thinkingMode: "extended" }),
];

const OAUTH_MODEL_THINKING_MODE = new Map(
  anthropicOAuthModels.map((m) => [m.name, m.thinkingMode]),
);

/**
 * 模型 id → 是否走 adaptive thinking。权威来源是模型表的 thinkingMode 字段；
 * 未命中（未来新增模型未入表）时用 id 子串 fallback（与旧行为一致），
 * 新模型入表后自动走表内判定，无需改此处。
 */
export function isAdaptiveThinkingModelId(model: string | undefined): boolean {
  if (!model) return false;
  const tableMode = OAUTH_MODEL_THINKING_MODE.get(model);
  if (tableMode === "adaptive") return true;
  if (tableMode === "extended") return false;
  const n = model.toLowerCase();
  return (
    n.includes("fable-5") ||
    n.includes("opus-5") ||
    n.includes("sonnet-5") ||
    n.includes("opus-4-8") ||
    n.includes("opus-4-7") ||
    n.includes("sonnet-4-6") ||
    n.includes("opus-4-6")
  );
}
