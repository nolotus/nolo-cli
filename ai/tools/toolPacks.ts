/**
 * 能力分级定义 (Capability Tiers)
 */
export const TOOL_PACKS = {
  // L1 - 核心：交互 + 记忆读写 + 自我更新，所有 Agent 必有
  CORE: ["ui_ask_choice", "rememberMemory", "read", "searchDialogMessages", "createDoc", "updateDoc", "search_workspace", "search_all_spaces", "updateSelf", "queryModelUsage", "queryUserGrowthReport", "createAgentAutomation", "notifyUser"],
  // L2 - 联网搜索：配置了 web-capable tools 的 Agent 默认加，纯 QA bot 不加
  LIGHT_WEB: ["exa_search", "read_x_post", "read_xhs_profile"],
  // L3 - 深度浏览器：全套复杂网页交互
  FULL_BROWSER: [
    "browser_openSession",
    "browser_closeSession",
    "browser_click",
    "browser_typeText",
    "browser_readContent",
    "browser_selectOption",
    "fetchWebpage",
  ],
} as const;

// ============================================================================
// 能力包 (Capability Packs) — 面向用户的工具分组，一个开关控制一整组工具。
// 普通用户在创建/编辑 agent 时看到的是能力包开关（如「联网搜索」），而非
// 散装工具名（如 exa_search）。agent 记录存 enabledPacks: string[]，运行时
// 展开成工具名。高级用户仍可展开看/加散装工具（tools 字段）。
// ============================================================================

export type CapabilityPack = {
  /** 稳定 ID，存入 agent.enabledPacks */
  id: string;
  /** 面向用户的名称（i18n key 或直接中文） */
  label: string;
  /** 一句话描述这个能力包做什么 */
  description: string;
  /** 这个包包含的工具名 */
  tools: readonly string[];
  /** 默认是否启用（新建 agent 时默认勾选的包） */
  defaultEnabled: boolean;
  /** 图标 emoji（UI 展示用） */
  icon: string;
};

export const CAPABILITY_PACKS: CapabilityPack[] = [
  {
    id: "web-search",
    label: "联网搜索",
    description: "让 agent 能搜索互联网、抓取网页内容，获取最新信息。",
    tools: ["exa_search", "fetchWebpage"],
    defaultEnabled: true,
    icon: "🌐",
  },
  {
    id: "full-browser",
    label: "深度浏览器",
    description: "完整浏览器自动化：打开页面、点击、输入、读取动态渲染内容。",
    tools: TOOL_PACKS.FULL_BROWSER,
    defaultEnabled: false,
    icon: "🖥",
  },
  {
    id: "social-reader",
    label: "社交内容读取",
    description: "读取 X/Twitter 帖子、小红书用户画像等社交平台内容。",
    tools: ["read_x_post", "read_xhs_profile"],
    defaultEnabled: false,
    icon: "📡",
  },
];

/** Map of pack id → pack, for quick lookup. */
export const CAPABILITY_PACK_BY_ID: Record<string, CapabilityPack> =
  CAPABILITY_PACKS.reduce(
    (acc, pack) => {
      acc[pack.id] = pack;
      return acc;
    },
    {} as Record<string, CapabilityPack>,
  );

/** All tool names covered by capability packs (for detecting pack-managed tools). */
export const PACK_MANAGED_TOOLS = new Set<string>(
  CAPABILITY_PACKS.flatMap((pack) => pack.tools),
);

/** Default-enabled pack ids (for new agents). */
export const DEFAULT_ENABLED_PACKS = CAPABILITY_PACKS.filter(
  (pack) => pack.defaultEnabled,
).map((pack) => pack.id);

/**
 * Expand enabledPacks into tool names. Merged with any explicit tools the
 * creator added (advanced mode). Returns a deduplicated list.
 */
export function expandEnabledPacks(
  enabledPacks: string[] | null | undefined,
  explicitTools: string[] | null | undefined = [],
): string[] {
  const packTools = (enabledPacks ?? [])
    .map((id) => CAPABILITY_PACK_BY_ID[id]?.tools ?? [])
    .flat();
  return [...new Set([...packTools, ...(explicitTools ?? [])])];
}

/**
 * 强制工具层 (Forced)：CLI 和桌面端不可关闭的工具，即使 declared-only / ablation
 * 模式也保留。web 端通过 getRuntimeCoreTools() 已覆盖（CORE 含 ui_ask_choice），
 * 但 inline-artifact agent 特意跳过 CORE——这是预期行为（纯产物生成 agent 不交互）。
 *
 * 与 CORE 的区别：CORE 是「默认有、可关」，FORCED 是「CLI/桌面永远有」。
 */
export const FORCED_TOOLS = ["ui_ask_choice"] as const;

/**
 * Filter out disabledTools from a tool list, preserving FORCED_TOOLS (which
 * cannot be disabled). Used by all three runtimes (web/CLI/desktop) after
 * default/recommended tool injection so a creator's "don't give this agent
 * web search" intent is enforced at the schema level — the tool never reaches
 * the model, costing zero tokens.
 */
export function applyDisabledTools(
  toolNames: string[],
  disabledTools?: string[] | null,
): string[] {
  if (!Array.isArray(disabledTools) || disabledTools.length === 0) {
    return toolNames;
  }
  const disabled = new Set(disabledTools);
  const forced = new Set<string>(FORCED_TOOLS);
  return toolNames.filter((name) => !disabled.has(name) || forced.has(name));
}
