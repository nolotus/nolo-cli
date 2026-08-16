// packages/app/settings/quickChatTierDefaults.ts
//
// 单一职责:快速对话「快速 / 平衡 / 质量」三档的内置默认智能体 key。
// 2026-08-15: 图片档已移除。有图时统一走 flash 档 + vision 预处理管道
// （Qwen 3.7 Flash 描述图片为文字），不再自动切 Kimi。用户如需精确视觉
// 可手动切换到 Kimi K2.6 agent。
//
// 这是三档默认 agentKey 的唯一真相源(single source of truth)。
// `packages/app/pages/quickChatFlow.ts` 从此处 re-export,以避免 settings 包
// 反向 import pages 层造成循环依赖。`fieldSelectors.ts` 与
// `settingNormalizers.ts` 在「未定制档位 / 存的是 SYSTEM_DEFAULT_AGENT_ID 哨兵」
// 时回退到这些档位默认值,而不是 nolo 内置 agent。
//
// 与 desktopAgentRuntimeAdapter 的 BUILTIN_PLATFORM_AGENT_CONFIGS 保持一致
// (见 packages/server/handlers/desktopAgentRuntimeAdapter.ts)。

import {
  PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
} from "../../core/builtinAgents";

export const QUICK_CHAT_AUTO_FALLBACK_AGENT_KEY = PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY;

/** 快速对话三档内置默认 agentKey;用户未定制时回退到这些。 */
export const QUICK_CHAT_DEFAULT_TIER_AGENTS: Record<
  "flash" | "balanced" | "quality",
  string
> = {
  flash: QUICK_CHAT_AUTO_FALLBACK_AGENT_KEY,
  balanced: QUICK_CHAT_AUTO_FALLBACK_AGENT_KEY,
  quality: QUICK_CHAT_AUTO_FALLBACK_AGENT_KEY,
};