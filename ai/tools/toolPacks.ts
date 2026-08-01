/**
 * 能力分级定义 (Capability Tiers)
 */
export const TOOL_PACKS = {
  // L1 - 核心：交互 + 自我更新，所有 Agent 必有。
  // rememberMemory 已移至「长期记忆」能力包（defaultEnabled:true），用户可单关。
  CORE: ["ui_ask_choice", "read", "searchDialogMessages", "createDoc", "updateDoc", "search_workspace", "search_all_spaces", "updateSelf", "queryModelUsage", "queryUserGrowthReport", "createAgentAutomation", "notifyUser"],
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
    id: "long-term-memory",
    label: "长期记忆",
    description: "让 agent 能把值得长期保留的用户偏好、协作约定写成 episodic memory，跨对话复用。",
    tools: ["rememberMemory"],
    defaultEnabled: true,
    icon: "🧠",
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
  {
    id: "code",
    label: "代码执行",
    description:
      "读写代码文件、搜索代码库、执行 shell 命令——让 agent 能改代码、跑测试。",
    tools: [
      "readFile",
      "writeFile",
      "editFile",
      "applyEdit",
      "applyLineEdits",
      "codeSearch",
      "globFiles",
      "searchFiles",
      "listFiles",
      "execShell",
      "launchProcess",
      "listProcesses",
    ],
    defaultEnabled: false,
    icon: "💻",
  },
  {
    id: "agent-orchestration",
    label: "多 agent 编排",
    description:
      "后台启动其他 agent 执行子任务，并观察、查询、停止运行中的 agent run——适合并行派发、长任务跟踪、中途叫停等编排场景。",
    tools: ["startAgentRun", "controlAgentRun"],
    defaultEnabled: false,
    icon: "🧩",
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
 *
 * 注意：空 enabledPacks 时**不**在此处 fallback 到 DEFAULT_ENABLED_PACKS。
 * 是否给"未配置 pack 的 agent"补默认能力包，由调用方按 agent 类型决定
 * （例如 inline-artifact agent 不该获得任何工具，故调用方不 fallback；
 * 普通 agent 由 mergeAgentToolsWithRuntime 补 DEFAULT_ENABLED_PACKS）。
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

/**
 * Tools that imply web-access capability (triggers LIGHT_WEB auto-inject).
 * Shared by CLI and desktop runtimes.
 */
const WEB_CAPABLE_TOOL_NAMES = new Set<string>([
  "fetchWebpage",
  "exa_search",
  "firecrawl_scrape",
  "firecrawl_search",
  "read_x_post",
  "read_xhs_profile",
]);

function isWebCapableTool(name: string): boolean {
  return WEB_CAPABLE_TOOL_NAMES.has(name) || name.startsWith("browser_");
}

/**
 * If an agent has explicitly declared any web-capable tool, auto-inject the
 * full LIGHT_WEB pack. Shared by CLI (localRuntimeAdapter) and desktop
 * (desktopAgentRuntimeToolBuilders) runtimes to avoid duplicated logic.
 */
export function addDefaultLightWebToolsForConfiguredAgents(
  toolNames: string[],
  agentConfig?: {
    toolSurface?: { explicitToolNames?: string[] };
    toolNames?: string[];
  } | null,
): string[] {
  const explicitToolNames = Array.isArray(
    (agentConfig as any)?.toolSurface?.explicitToolNames,
  )
    ? (agentConfig as any).toolSurface.explicitToolNames
    : agentConfig?.toolNames;
  if (!Array.isArray(explicitToolNames) || explicitToolNames.length === 0)
    return toolNames;
  const webCapable = explicitToolNames.some(isWebCapableTool);
  if (!webCapable) return toolNames;
  return [...new Set([...toolNames, ...TOOL_PACKS.LIGHT_WEB])];
}

/**
 * Shared server/web runtime default web tool pack injection:
 * - LIGHT_WEB auto-added when there are any declared tools (unless skipWeb).
 * - FULL_BROWSER auto-added when any browser_* tool is declared.
 * Used by runtimePreparation (server) and streamAgentChatTurnUtils (web).
 * Only handles LIGHT_WEB + FULL_BROWSER; other tool merging stays at call sites.
 */
export function applyDefaultWebToolPacks(args: {
  toolNames: string[];
  skipWeb?: boolean;
}): string[] {
  const enhanced = new Set(args.toolNames);
  // LIGHT_WEB auto-inject only when a web-capable tool is present (not merely
  // when toolNames is non-empty). Previously any non-empty tool list triggered
  // LIGHT_WEB, which incorrectly injected read_x_post/read_xhs_profile for
  // agents whose only tool was e.g. rememberMemory.
  if (!args.skipWeb && args.toolNames.some(isWebCapableTool)) {
    TOOL_PACKS.LIGHT_WEB.forEach((t) => enhanced.add(t));
  }
  if (args.toolNames.some((t) => t.startsWith("browser_"))) {
    TOOL_PACKS.FULL_BROWSER.forEach((t) => enhanced.add(t));
  }
  return [...enhanced];
}
