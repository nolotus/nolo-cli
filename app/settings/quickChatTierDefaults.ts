// packages/app/settings/quickChatTierDefaults.ts
//
// 单一职责:快速对话默认档的内置智能体 key。
// 2026-08-15: 图片档已移除。有图时统一走默认档 + vision 预处理管道
// （Qwen 3.7 Flash 描述图片为文字），不再自动切 Kimi。
// 2026-08-21: 默认档从广场档改为内置 nolo 本体（见下方常量注释）。
// 「快速 / 平衡 / 质量」三档早已全部指向同一个 agent，档位只剩历史形状。
//
// 这是默认 agentKey 的唯一真相源(single source of truth)。
// `packages/app/pages/quickChatFlow.ts` 从此处 re-export,以避免 settings 包
// 反向 import pages 层造成循环依赖。`fieldSelectors.ts` 与
// `settingNormalizers.ts` 在「未定制档位 / 存的是 SYSTEM_DEFAULT_AGENT_ID 哨兵」
// 时回退到这里的默认值——现在这个默认值就是 nolo 内置 agent 本身。
//
// 与 desktopAgentRuntimeAdapter 的 BUILTIN_PLATFORM_AGENT_CONFIGS 保持一致
// (见 packages/server/handlers/desktopAgentRuntimeAdapter.ts)。

import { BUILTIN_NOLO_AGENT_KEY } from "../../core/builtinAgents";

/**
 * 快捷对话默认档 = 内置 nolo 本体，和 TUI `/switch` 的 nolo 是同一个 agent。
 *
 * 曾经指向广场档 `agent-pub-01DSV4FLASHPB…`。那样 web 的「nolo」和 TUI 的 nolo
 * 其实是两个不同 agent，各自跟着自己的记录漂移——2026-08 就漂开过：catalog 已
 * 声明 vision-exp，而那条广场记录线上仍是非 vision 的 deepseek-v4-flash。
 * 指向 nolo 本体后，它的 provider/model 由 builtinAgentCatalog 托管
 * （见 agent-runtime/builtinPlatformAgentConfigs 的 applyBuiltinAgentRuntimeOverride），
 * 换代改 catalog 一处，web / 桌面 / TUI 一起跟上。
 */
export const QUICK_CHAT_AUTO_FALLBACK_AGENT_KEY = BUILTIN_NOLO_AGENT_KEY;

/** 快速对话三档内置默认 agentKey;用户未定制时回退到这些。 */
export const QUICK_CHAT_DEFAULT_TIER_AGENTS: Record<
  "flash" | "balanced" | "quality",
  string
> = {
  flash: QUICK_CHAT_AUTO_FALLBACK_AGENT_KEY,
  balanced: QUICK_CHAT_AUTO_FALLBACK_AGENT_KEY,
  quality: QUICK_CHAT_AUTO_FALLBACK_AGENT_KEY,
};