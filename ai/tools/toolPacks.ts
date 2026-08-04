import {
  SYSTEM_AGENT_CAPABILITIES,
  SYSTEM_AGENT_CAPABILITY_IDS,
} from "./agentCapabilities";

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
  /**
   * 能力包附带的方法论文档（Markdown）。启用该包时，此内容会随工具一起
   * 注入 system prompt 的「技能提示」块，与 skill reference 的 promptPatch
   * 走同一条注入链（mergeAgentToolsWithRuntime → buildSkillGuidanceBlock）。
   * 用于承载"这套工具的配合纪律/流程/模板"，让能力包 = 工具 + 用法。
   */
  promptPatch?: string;
};

const SYSTEM_AGENT_CAPABILITY_PACKS: CapabilityPack[] =
  SYSTEM_AGENT_CAPABILITIES.map((capability) => ({ ...capability }));

export const CAPABILITY_PACKS: CapabilityPack[] = [
  ...SYSTEM_AGENT_CAPABILITY_PACKS,
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
      "先按收藏、简介、能力和成本列出安全 agent 摘要，按需读取候选配置解析可运行 key，再后台启动其他 agent 执行子任务，并观察、查询、停止运行中的 agent run——适合并行派发、长任务跟踪、中途叫停等编排场景。",
    tools: ["startAgentRun", "controlAgentRun", "listAgents"],
    defaultEnabled: true,
    icon: "🧩",
  },
  {
    id: "skills",
    label: "技能加载",
    description:
      "按名加载工作区技能（SKILL.md）并读取技能文档——让 agent 在需要时把对应技能的方法论、命令和流程拉进上下文再执行。",
    tools: ["loadSkill", "readSkillDoc"],
    defaultEnabled: true,
    icon: "📚",
  },
  {
    id: "app-builder",
    label: "应用构建",
    description:
      "构建/修改/发布 Web 应用：读取应用源码、定点修改、预检、部署，无需编程经验。",
    tools: [
      "appRead",
      "appFileList",
      "appFileSearch",
      "appFileRead",
      "appFileReplace",
      "appFileWrite",
      "appPreflight",
      "appDeploy",
      "appList",
      "appDelete",
      "createTable",
      "addTableRow",
      "addTableRows",
      "queryTableRows",
      "updateTableRow",
      "deleteTableRow",
      "openAIGptImage",
    ],
    defaultEnabled: false,
    icon: "🖥",
    promptPatch: `# 应用构建能力包 — 操作纪律

## 效率优先（省 token）
- 不复述用户需求，不解释你「打算怎么做」，直接动手。改完只用一两句话说清「改了什么、去哪看」。
- 思考简短：定位问题即可，不做长篇推演。
- 小改动（改文字、颜色、间距、圆角、单个组件）走最短路径：\`appFileSearch\` 或 \`appFileRead\` 定位 → \`appFileReplace\` 精确替换 → \`appPreflight\` → \`appDeploy\`。能一次命中就不要反复读文件。
- 已经知道文件和位置时，跳过多余的 search/read，直接 replace。
- 禁止为一个小改动整页重写或连带改动未命中的部分。

## 定点修改
- 如果上下文里带有用户「选中的元素」（cssPath / HTML 片段 / 源码位置），直接据此定位，不要再全局搜索。
- 修改收敛在命中的元素及其样式来源（组件 / 类 / design token）。

## 持续迭代流程
- 用户要改功能或样式时，先用 appList 找到目标应用，再用 appRead 判断当前是源码工作区还是部署产物；一旦拿到 appId，后续都必须复用同一个 appId。
- 每次修改后：appPreflight → appDeploy；appDeploy 必须继续传同一个 appId。
- 收到 repairPlan 就直接修：按返回 issues 定点修复并重新预检，不要整站重写，也不要先问用户要不要修。

## Nolo React SSR 维护纪律（当前默认路径）
- 新建和维护的应用优先走 Nolo React SSR（framework: "nolo-react", renderMode: "ssr"）。
- 当 appRead 返回 workspaceRef / sourceFiles / sourceOmitted 时，不要整站重写；使用受限 workspace 文件工具：appFileList / appFileSearch / appFileRead / appFileReplace / appFileWrite。
- 小改动必须优先 appFileReplace；只有新建文件或确实需要整文件重写时才 appFileWrite。
- 不要静默把 nolo-react 应用退回 react-spa 或单文件 Worker。
- 视觉微调优先改 theme / tokens / design system；旧写法应用可先做最小 token 迁移，再改视觉参数。

## 表单 / 数据收集
- 留言、联系表单、预约、订阅、反馈收集优先用表工具，不要自己发明 JSON 文件存储。
- 公开网页表单先 createTable，并配置 publicIntake（enabled、slug、allowedFields、requiredFields、可选 honeypotField）。
- 公开访客提交只能调用 /api/table/public-submit；不要把 tenantId、tableId、token 写进公开应用代码。

## 项目素材
- 首页插画、封面、横幅、按钮图标等视觉素材，优先 openAIGptImage，再接入应用。

## 通道异常止损
- 如果工具返回 HTML / 非 JSON / transport failure / retryable=false，停止自动重试，说明是平台通道异常。

## 缺少源码要说明风险
- 如果 appRead 读出来的是 HTML 壳、importmap、压缩 bundle，必须先告知用户当前更像部署产物而不是可维护源码，得到确认后再继续大改。

## 部署应答模板
部署成功后：
"✅ 你的应用已经好了！

🔗 访问链接：[URL]

这个应用可以帮你 [一句话功能描述]。想要修改或添加功能，直接告诉我就行！"`,
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
 * Pack ids that are "system built-in skills" — capabilities Nolo ships with
 * that every agent gets by default, but which the user can globally disable
 * from the settings page (vs per-agent `enabledPacks` which are per-agent
 * toggles). The global on/off state lives in `SettingState.systemBuiltinSkills`.
 *
 * Only packs listed here are subject to the global filter. Add a new global
 * capability to `agentCapabilities.ts`; this list is derived automatically.
 */
export const SYSTEM_BUILTIN_SKILL_PACK_IDS = SYSTEM_AGENT_CAPABILITY_IDS;

/**
 * Filter tool names according to the global `systemBuiltinSkills` setting.
 *
 * For each system built-in skill pack that is explicitly disabled in the map,
 * its tools are removed from the list. Missing keys are treated as enabled
 * (matching `normalizeSystemBuiltinSkills` which fills missing keys from
 * defaults). This is the single shared filter point called by all three
 * runtimes (Web / CLI / Desktop) after `expandEnabledPacks`, so behavior is
 * uniform across hosts.
 *
 * Pure function; safe to call with null/undefined map (no-op).
 */
export function applySystemBuiltinSkillFilter(
  toolNames: string[],
  systemBuiltinSkills: Record<string, boolean> | null | undefined,
): string[] {
  if (!systemBuiltinSkills) return toolNames;
  const disabledToolSet = new Set<string>();
  for (const packId of SYSTEM_BUILTIN_SKILL_PACK_IDS) {
    const enabled = systemBuiltinSkills[packId];
    // Explicit false => disabled; undefined/null/true => enabled.
    if (enabled === false) {
      const pack = CAPABILITY_PACK_BY_ID[packId];
      if (pack) pack.tools.forEach((t) => disabledToolSet.add(t));
    }
  }
  if (disabledToolSet.size === 0) return toolNames;
  return toolNames.filter((t) => !disabledToolSet.has(t));
}

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
 * Collect promptPatch (方法论文档) from enabled packs. Merged into
 * agent.skillPromptPatches at runtime so the pack's discipline lands in the
 * system prompt's skill-guidance block together with its tools.
 */
export function expandEnabledPackPromptPatches(
  enabledPacks: string[] | null | undefined,
): string[] {
  return (enabledPacks ?? [])
    .map((id) => CAPABILITY_PACK_BY_ID[id]?.promptPatch)
    .filter((patch): patch is string => typeof patch === "string" && patch.length > 0);
}

/**
 * Append enabled packs' promptPatch docs to an agent's raw prompt. No-op when
 * the agent has no enabled pack with a promptPatch.
 *
 * 用途：CLI / 桌面 runtime 的 system prompt 直接使用 agentConfig.prompt
 * （不经过 buildSystemPrompt 的 skill-guidance 层），因此在这里把能力包的
 * 操作纪律追加进 prompt，保证「工具 + 纪律」在这两端同样整体生效。
 */
export function appendEnabledPackPromptPatches(
  prompt: string | null | undefined,
  enabledPacks: string[] | null | undefined,
): string | undefined {
  const patches = expandEnabledPackPromptPatches(enabledPacks);
  if (patches.length === 0) return prompt ?? undefined;
  const base = typeof prompt === "string" ? prompt.trim() : "";
  const addition = patches.join("\n\n");
  if (!base) return addition;
  if (base.includes(addition)) return base;
  return `${base}\n\n${addition}`;
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
