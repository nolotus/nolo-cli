import type { Model } from "../../ai/llm/types";

/**
 * Moonshot AI（月之暗面）开放平台模型清单（按量计费）。
 *
 * 来源：https://platform.moonshot.cn/（开放平台模型列表）
 * 接入方式：OpenAI 兼容模式
 *   Base URL: https://api.moonshot.cn/v1（国内）/ https://api.moonshot.ai/v1（海外）
 *
 * 说明：
 * - 开放平台仅按量计费（per MTok，美元），充值即用，无频控。
 *   与 Kimi Code 会员订阅（api.kimi.com/coding）是两套独立计费，不互通。
 * - 价格单位沿用本仓库 MODEL_MAP 约定（与 xaiModels 的 $×7 量纲一致），
 *   按 Moonshot 官方美元标价 × 7 填写；如官方调价请同步更新。
 * - contextWindow 单位为 token；能力标记依据开放平台模型卡片。
 * - 旧版 kimi-k2.5 已于 2026-05-25 下线，不在本清单。
 */
export const moonshotModels: Model[] = [
  // ── 旗舰 ──
  {
    name: "kimi-k3",
    displayName: "Kimi K3",
    hasVision: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 262_144,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 3 * 7, output: 15 * 7 },
    provider: "moonshot",
    description: "Moonshot 旗舰模型，原生多模态，1M 上下文，长程编程与深度推理。",
  },

  // ── 通用 ──
  {
    name: "kimi-k2.6",
    displayName: "Kimi K2.6",
    hasVision: true,
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 0.6 * 7, output: 2.4 * 7 },
    provider: "moonshot",
    description: "Moonshot 高性能通用模型。",
  },

  // ── 编程 ──
  {
    name: "kimi-k2.7-code",
    displayName: "Kimi K2.7 Code",
    hasVision: false,
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 1.2 * 7, output: 4.8 * 7 },
    provider: "moonshot",
    description: "Moonshot 编程优化模型，适合代码生成与 Agent 编程。",
  },
];

/**
 * Kimi Code 会员订阅模型清单（订阅制）。
 *
 * 来源：https://www.kimi.com/code/docs/kimi-code/models.html
 * 接入方式：OpenAI 兼容模式
 *   Base URL: https://api.kimi.com/coding/v1
 *
 * 说明：
 * - Kimi Code 随 Kimi 会员订阅一同提供，按月/年付费，每 7 天额度刷新 +
 *   每 5 小时滚动频控；CLI / VS Code / 第三方工具共享同一套配额。
 * - 模型 ID 与开放平台不同：这里是 `k3` / `kimi-for-coding` /
 *   `kimi-for-coding-highspeed`，不是 `kimi-k3`。填模型版本名（如 "Kimi K3"）
 *   会调用失败，必须填 Model ID。
 * - 订阅不按 token 计费，price 留 0（由会员额度抵扣，不在本表体现）。
 * - 调用权限随会员档位变化：Andante 不支持 k3；Moderato 的 k3 限 256k 上下文；
 *   Allegretto 及以上 k3 可用满 1M；highspeed 需 Allegretto 及以上。
 * - K3/K2.7 关闭 thinking 会被路由到 K2.6；使用 K3/K2.7 需保持 thinking 开启。
 */
export const kimiCodeModels: Model[] = [
  // ── 旗舰编程 ──
  {
    name: "k3",
    displayName: "Kimi K3",
    hasVision: false,
    contextWindow: 1_000_000,
    maxOutputTokens: 262_144,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 0, output: 0 },
    provider: "moonshot",
    description:
      "Kimi 最强旗舰编程模型，2.8T 参数，1M 上下文，low/high/max 三档思考深度，擅长复杂工程与长程推理。Moderato 及以上可用。",
  },

  // ── 成熟编程 ──
  {
    name: "kimi-for-coding",
    displayName: "Kimi K2.7 Code",
    hasVision: false,
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 0, output: 0 },
    provider: "moonshot",
    description:
      "成熟稳定的 Coding 模型，Thinking 开启下可靠遵循指令，编程任务成功率高。所有会员可用。",
  },

  // ── 高速编程 ──
  {
    name: "kimi-for-coding-highspeed",
    displayName: "Kimi K2.7 Code 高速版",
    hasVision: false,
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    jsonOutput: true,
    fnCall: true,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: { input: 0, output: 0 },
    provider: "moonshot",
    description:
      "K2.7 Code 高速版，编码能力一致，输出速度约 6 倍、消耗约 3 倍。Allegretto 及以上可用。",
  },
];