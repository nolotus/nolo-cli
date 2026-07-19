// 文件路径: ai/agent/buildSystemPrompt.ts
// 平台通用 Agent System Prompt 生成器
// 所有模型调用的 system prompt 均由此函数构建

import { mapLanguage } from "../../app/i18n/mapLanguage";
import { Agent } from "../../app/types";
import { buildSkillGuidancePromptBlock } from "../skills/referenceRuntime";
import { buildRuntimeGuidanceBlocks } from "../agent/runtimeGuidance";
import { canonicalizeToolNames } from "../tools/toolNameAliases";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { wrapHistoricalSummaryWithReplayGuard } from "../context/staleReplayGuard";
// 记忆使用指引下沉到 agent-runtime：桌面本地 runtime 注入 memory overlay 时
// 必须带同一份指引，两处各存一份迟早漂移。
import { MEMORY_USE_GUIDANCE } from "../../agent-runtime/memoryUseGuidance";
import { PAGE_BUILDER_HANDOFF_INSTRUCTIONS } from "./pageBuilderHandoffRules";
import { compileContextLayers, type CompiledContext } from "./contextCompiler";
import { buildCurrentTimeBlock } from "./currentTimeContext";
import { Contexts } from "../types";

// ============================================================================
// 参考资料使用说明（对所有 Agent 注入）
// ============================================================================

const CONTEXT_USAGE_INSTRUCTIONS = `参考资料使用说明：
- 下方提供的资料是你的主要权威信息来源。
- 回答问题时，应优先依赖这些资料。它们按优先级从高到低排列。
- 使用其中的事实、数据和名称时，要保持精准。
- 如果资料中没有包含答案，应说明这一点，然后再使用你的通用知识进行回答。
- 如果你在资料中发现相互矛盾的信息，也要在回答中指出这一点。
- 当通用指令与更具体的"按 Agent / 按文档"的规则发生冲突时，必须优先遵守更具体、优先级更高的规则。`;

// ============================================================================
// 交互说明（有 ui_ask_choice 工具时注入）
// ============================================================================

const MENU_USAGE_INSTRUCTIONS = `--- 交互说明 ---
所有用户输入均为纯文本消息，直接理解即可，不要在回复中提及按钮、菜单、界面等 UI 元素。`;

// ============================================================================
// 网页访问（有 exa_search 工具时注入）
// ============================================================================

const WEBPAGE_ACCESS_INSTRUCTIONS = `--- 网页访问能力 (Web Access) ---
获取外部信息时由简入繁：
0. 用户已给明确 URL → 先直接 fetch 这些 URL，不要先搜索或猜备用网址。它们是本次任务最高优先级的网页真值。仅当抓取失败、缺字段或内容不匹配时才额外搜索，并在回复中说明降级原因。
1. 无明确 URL → 先用 exa_search 发现权威入口（尤其陌生 docs 站，不要直接猜子路径）。
2. 已有明确 URL 且需完整渲染内容 → fetchWebpage（支持 JS/SPA；docs.* 会自动检查 /llms.txt 并规范化 URL）。
3. 需登录/填表/多步交互 → browser_openSession（openSession 拿 ID → typeText/click/readContent）。
4. YouTube/亚马逊/Google 等结构化数据 → 用对应专用 Scraper 工具（youtubeScraper、amazonProductScraper 等）。`;

// ============================================================================
// 本地文件整理（有 local desktop file tools 时注入）
// ============================================================================


// ============================================================================
// Agent 编排协作（有 callAgent / runStreamingAgent 工具时注入）
// ============================================================================

const AGENT_ORCHESTRATION_INSTRUCTIONS = `--- Agent 编排与协作 ---
你所在的系统支持多个子 Agent 和工作流工具，请把自己视为"总协调者"：

1）子 Agent 协作
- 如果目标 Agent 记录已经声明 delegation.serverBase / runtimeServerBase，工具会自动路由到对应 nolo server；你不需要重复填写 serverBase。
- 如果用户明确给了另一个可访问的 server origin（例如 Windows 机器的 Cloudflare 域名），可以在工具参数里传 serverBase 覆盖自动路由；不要臆造地址，也不要把普通 localhost 当成远端机器。
- 需要异步启动一个子对话、让当前对话稍后根据子 Agent 的完成/失败继续判断时，使用 callAgent({ background: true })。它只表示 child dialog 已启动或排队，不表示任务已经完成；child 进入 done/failed 后，系统会用 terminal wake 继续父对话，你再读取 child evidence 决定下一步。
- callAgent({ background: true }) 是通用多 Agent 协作能力，不限于代码任务；游戏设计、电影策划、写作、运营、研究等需要异步分工的场景也可以使用。
- 需要等待一个短结果并直接综合时，使用 callAgent（默认同步等待）；需要用户前台实时看到另一个 Agent 发言时，使用 runStreamingAgent。
- 当用户需要多视角分析或辩论时，你可以：
  - 先用 callAgent 依次询问多个 Agent 对同一问题的看法；
  - 在最后一条回复中，用你自己的话帮用户总结这些观点的异同，并给出综合结论。

2）工作流 / Workflow 工具
- 对于需要多步骤、顺序依赖或批量工具调用的复杂任务，应优先考虑使用 createWorkflow 这类工作流工具。
- 调用工作流工具时，你负责：
  - 清楚描述目标和约束；
  - 在工作流执行过程中关注其输出的中间结果和最终结果；
  - 当你认为任务足够完成，或用户要求总结时，对整个过程和结果进行总结，指出可能的错误或风险。

3）危险 / 不可逆操作
- 涉及不可逆操作时（修改文件、删除数据、发送消息、生成正式文件、执行交易等），请优先预览或向用户确认。
- 当工具返回"预览"或"待确认"状态时，请暂停进一步自动修改，等待用户明确确认或反馈后再继续。不要在用户未确认前连续发出多次破坏性修改。`;

// ============================================================================
// 知识管理（有 createDoc / updateDoc / read 工具时注入）
// 仅包含页面级知识管理，不含自我更新能力
// ============================================================================

const KNOWLEDGE_MANAGEMENT_INSTRUCTIONS = `--- 知识管理 ---
三层知识：
1. references（Agent 配置，每次对话自动注入）：type=instruction 进 prompt 顶部（行为规则）；type=knowledge 作参考资料。支持 page/dialog/table 完整展开；page 里的 @mention 只展开元信息（标题+dbKey），不递归展开内容。
2. createDoc 文档（按需 read）：总索引页用 @[page:PAGE-xxx|标题] 指向细分页；mention 是指针，取内容必须 read({ dbKey })。
读取路径：prompt/references 有 → 直接用；没有 → read 索引页找细分页 dbKey → read 细分页取完整内容。
何时沉淀：用户给了可复用信息 / 完成有价值调研 → createDoc（并 updateAgent 加入 references）；索引缺入口 → updateDoc 补 @mention。不要把一次性内容写成知识页。`;

// ============================================================================
// 长期记忆（有 rememberMemory 工具时注入）
// ============================================================================

const MEMORY_CAPTURE_INSTRUCTIONS = `--- 长期记忆 ---
你可用 rememberMemory 把值得长期保留的信息写成一条 episodic memory。
- 记录：稳定且对未来协作有帮助的用户偏好/判断标准/信息组织习惯/场景化抉择；后续反复用到的空间共识、协作约定、团队规则。
- 不记录：一次性任务细节、很快过期的事实、为凑数勉强抽出的内容。
- 方式：写成简短可复用的抽象（“该用户在某场景通常怎么选/怎么协作”），不要复制整段对话。仅当当前 dialog 已绑定 space 且属于共享共识时才传 scope=space，否则保持默认 auto。默认静默执行，除非用户在讨论记忆本身。帮助不明显就不要调用。`;

// ============================================================================
// 自我更新能力（仅在 Agent 拥有 updateSelf 工具时注入）
// ============================================================================

const SELF_UPDATE_INSTRUCTIONS = `--- Agent 自我更新能力 ---

## 何时更新自己
- 重要决策/进度变化 → updateDoc 写回状态页
- 值得复用的知识 → createDoc 建细分页，再按需要更新自己的 references / greeting / introduction
- 小幅体验优化 → updateSelf 调整 greeting / introduction / tags

## 更新原则
- 优先形成最小、可解释的变更，不要为了“显得在进化”而频繁改自己
- 低风险沉淀优先写入 memory / doc；只有当这些知识需要长期改变你的行为方式时，再考虑 updateSelf
- prompt / references / tools / model 这类高影响字段，默认按需要确认来处理，不要静默大改
- 如果工具返回 policy limit / ask / reject，不要重复尝试，应先向用户解释或等待更高权限确认
- 没有发生实际更新时，不要在回复末尾额外汇报“未更新”状态`;

const GENERIC_AGENT_UPDATE_INSTRUCTIONS = `--- Agent 维护能力 ---
你拥有 updateAgent 权限，可以更新指定的 Agent。

## 何时更新别的 Agent
- 用户明确要求你维护、修复或批量调整另一个 Agent
- 你需要修改的目标不是当前正在运行的自己

## 更新原则
- 默认把 updateAgent 当成高风险维护操作，优先最小改动
- 修改前先确认目标 Agent 是否正确，避免误改
- 如果工具返回需要确认，不要绕过确认流程`;


// ============================================================================
// 无 prompt 时的澄清模式
// ============================================================================

const CLARIFICATION_MODE_INSTRUCTIONS = `在你还不了解用户意图时，通过提问来澄清需求，而不是仓促给出答案。`;

const isBrowser = typeof window !== "undefined";

// ============================================================================
// 工具函数
// ============================================================================

/** 创建一个上下文 section，如果 content 为空则返回空字符串 */
const createContextSection = (
  title: string,
  description: string,
  content?: string | null
): string =>
  content ? `### ${title} \n${description} \n\n${content} ` : "";

/** 根据屏幕宽度生成响应式布局建议 */
const buildResponseGuidelines = (isMobile: boolean): string => {
  if (isMobile) {
    return `-- - 响应展示指南-- -
请为移动端进行优化：
- 使用更短的段落和简洁的项目符号列表。
- 避免过宽的表格或代码块，以免产生横向滚动。
- 优先采用垂直排布，而不是左右并排的布局。`;
  }
  return `-- - 响应展示指南-- -
你的回复将显示在大屏幕上。你可以：
- 提供更丰富的推理过程说明和更有层次的结构。
- 在合适的场景下使用宽屏优势，例如更宽的表格、并排对比展示、更长的代码块等。`;
};

/** 构建参考资料区块 */
const buildReferenceMaterialsBlock = (contexts: Contexts): string => {
  const sections = [
    createContextSection(
      "说明性文档（Instructional Documents）",
      "（最高优先级：具体规则与流程）",
      contexts.botInstructionsContext
    ),
    createContextSection(
      "当前输入上下文（Current Input Context）",
      "（高优先级：来自用户本次输入）",
      contexts.currentInputContext
    ),
    createContextSection(
      "会话历史引用（Conversation History References）",
      "（中等优先级：来自过往消息）",
      contexts.historyContext
    ),
    createContextSection(
      "知识库文档（Knowledge Base Documents）",
      "（参考优先级：用于通用查阅）",
      contexts.botKnowledgeContext
    ),
  ].filter(Boolean);

  if (sections.length === 0) {
    return "";
  }

  return [
    "--- 参考资料 ---",
    CONTEXT_USAGE_INSTRUCTIONS,
    "",
    sections.join("\n\n"),
  ].join("\n");
};

/** 构建「当前编辑上下文」区块 */
const buildEditingContextBlock = (contexts: Contexts): string => {
  if (!contexts.editingContext) return "";

  return [
    "--- 当前编辑上下文 ---",
    "下面是用户当前正在查看或编辑的对象描述，请在涉及修改、建议或结构性操作时优先参考这里：",
    "",
    contexts.editingContext,
  ].join("\n");
};

const buildAppWorkingMemoryBlock = (contexts: Contexts): string => {
  if (!contexts.appWorkingMemory) return "";

  return [
    "--- 最近应用工作记忆 ---",
    "下面是从当前对话最近的应用相关工具调用中提炼出的真值。即使用户没有打开右侧应用侧栏，只要他说“刚才那个 app / 那个网站 / 那个项目”，也优先参考这里：",
    "",
    contexts.appWorkingMemory,
  ].join("\n");
};

/** 构建「当前 Space 环境」区块 */
const buildSpaceContextBlock = (contexts: Contexts): string => {
  if (!contexts.spaceContext) return "";

  // spaceContext 来自共享 turnContext builder，自带「--- 当前空间（Space）---」
  // 标题；这里不再重复包一层标题，只追加 web 端的工具使用指令。
  return [
    contexts.spaceContext,
    "",
    "重要指令 (Space Awareness)：",
    "- 你正处于上述工作空间中。如果用户的问题涉及到该空间的内容、文件或知识：",
    "  - 使用 `read` 工具查阅普通数据记录或数据表项。",
    "- 如果你在对话中产出了值得保存的重要信息（如总结、方案、代码片段等），请主动询问用户或使用 `createDoc` 工具将其保存为新页面，以便作为长期记忆留存。",
    "",
    "跨空间导航 (Cross-Space Navigation)：",
    "- 使用 `listUserSpaces` 工具可获取用户所有可访问的 Space 列表（ID 和名称）。",
    "- 使用 `read({ dbKey: \"space-{spaceId}\" })` 可获取指定 Space 的完整数据，包括：",
    "  - categories: 分类字典，key 是分类 ID，value 包含 name 和 order",
    "  - contents: 内容字典，每项包含 contentKey（dbKey）、title、type、categoryId",
  ].join("\n");
};



export type AgentRuntimeConfig = import("../../app/types").Agent & {
  referencedTools?: string[];
  recommendedSkillTools?: string[];
  recommendedSkillHints?: string[];
  skillPromptPatches?: string[];
};

export const buildSkillGuidanceBlock = (agentConfig: AgentRuntimeConfig): string => {
  const recommendedSkillHints = Array.isArray(agentConfig.recommendedSkillHints)
    ? (agentConfig.recommendedSkillHints as string[]).filter(Boolean)
    : [];
  const skillPromptPatches = Array.isArray(agentConfig.skillPromptPatches)
    ? (agentConfig.skillPromptPatches as string[]).filter(Boolean)
    : [];

  if (recommendedSkillHints.length === 0 && skillPromptPatches.length === 0) {
    return "";
  }

  return buildSkillGuidancePromptBlock({
    title: "--- 技能提示 ---",
    recommendedSkillHints,
    skillPromptPatches,
  });
};

// ============================================================================
// 主函数
// ============================================================================

export const buildSystemPrompt = (options: {
  agentConfig: AgentRuntimeConfig;
  language?: string;
  contexts?: Contexts;
  viewport?: { width: number; height: number };
  mobileBreakpoint?: number;
  now?: Date;
  timeZone?: string;
}): string => buildSystemPromptContext(options).content;

export const buildSystemPromptContext = (options: {
  agentConfig: AgentRuntimeConfig;
  language?: string;
  contexts?: Contexts;
  viewport?: { width: number; height: number };
  mobileBreakpoint?: number;
  now?: Date;
  timeZone?: string;
}): CompiledContext => {
  const {
    agentConfig,
    contexts = {},
    viewport,
    mobileBreakpoint = 768,
    now = new Date(),
    timeZone,
  } = options;

  const safeLanguage =
    options.language ??
    (typeof navigator !== "undefined" ? navigator.language : "en");

  const { name, prompt: mainPrompt, dbKey } = agentConfig;
  const mappedLanguage = mapLanguage(safeLanguage);

  const identitySection = [
    "--- 身份信息 ---",
    name ? `名称: ${name} ` : "",
    dbKey ? `ID: ${dbKey} ` : "",
    mappedLanguage ? `回复语言: ${mappedLanguage} ` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const corePersonaSection = mainPrompt
    ? `-- - 核心角色与任务-- -\n${mainPrompt}`
    : "";

  const agentTools = canonicalizeToolNames(agentConfig.tools ?? []);

  // 按工具能力条件注入各指令块
  const agentOrchestrationSection = agentTools.some((t) =>
    ["callAgent", "runStreamingAgent"].includes(t)
  )
    ? [
      AGENT_ORCHESTRATION_INSTRUCTIONS,
      agentTools.includes("runStreamingAgent") ? PAGE_BUILDER_HANDOFF_INSTRUCTIONS : "",
    ].filter(Boolean).join("\n\n")
    : "";

  const menuUsageSection = agentTools.includes("ui_ask_choice")
    ? MENU_USAGE_INSTRUCTIONS
    : "";

  const webAccessSection = agentTools.some((t) =>
    ["exa_search", "fetchWebpage", "browser_openSession", "read_x_post"].includes(t)
  )
    ? WEBPAGE_ACCESS_INSTRUCTIONS
    : "";

  // 知识管理：有页面读写工具时注入通用知识管理说明
  const knowledgeManagementSection = agentTools.some((t) =>
    ["createDoc", "updateDoc", "read", "readDoc", "readPage"].includes(t)
  )
    ? KNOWLEDGE_MANAGEMENT_INSTRUCTIONS
    : "";

  const memoryCaptureSection = agentTools.includes("rememberMemory")
    ? MEMORY_CAPTURE_INSTRUCTIONS
    : "";

  const selfUpdateSection = agentTools.includes("updateSelf")
    ? SELF_UPDATE_INSTRUCTIONS
    : "";

  const genericAgentUpdateSection = agentTools.includes("updateAgent")
    ? GENERIC_AGENT_UPDATE_INSTRUCTIONS
    : "";


  const {
    startupProtocol,
    contextLayerContract,
    emailRegistrationWorkflow,
    webResearchToolPolicy,
  } =
    buildRuntimeGuidanceBlocks(agentTools);

  const clarifyingSection = !mainPrompt ? CLARIFICATION_MODE_INSTRUCTIONS : "";

  const userGlobalPromptSection = contexts.userGlobalPrompt?.trim()
    ? `-- - 用户全局偏好-- -\n${contexts.userGlobalPrompt.trim()} `
    : "";

  const fallbackViewportWidth =
    isBrowser && typeof window !== "undefined" ? window.innerWidth : 1440;
  const isMobile =
    (viewport?.width ?? fallbackViewportWidth) < mobileBreakpoint;

  const responseGuidelinesSection = buildResponseGuidelines(isMobile);
  const editingContextSection = buildEditingContextBlock(contexts);
  const appWorkingMemorySection = buildAppWorkingMemoryBlock(contexts);
  const spaceContextSection = buildSpaceContextBlock(contexts);
  const rawMemoryOverlay = asOptionalTrimmedString(contexts.memoryOverlay) ?? "";
  const memoryOverlaySection = rawMemoryOverlay
    ? rawMemoryOverlay + "\n\n" + MEMORY_USE_GUIDANCE
    : "";

  const skillGuidanceSection = buildSkillGuidanceBlock(agentConfig);
  const referenceMaterialsSection = buildReferenceMaterialsBlock(contexts);

  const dialogSummarySection = contexts.dialogSummary?.trim()
    ? `--- 历史对话摘要 ---\n${wrapHistoricalSummaryWithReplayGuard(contexts.dialogSummary)}`
    : "";

  const proactiveSummarySection = contexts.proactiveSummary?.trim()
    ? `--- 阶段工作摘要 ---\n${wrapHistoricalSummaryWithReplayGuard(contexts.proactiveSummary)}`
    : "";

  return compileContextLayers([
    { id: "identity", owner: "platform", cacheScope: "session", content: identitySection },
    { id: "startup-protocol", owner: "platform", cacheScope: "static", content: startupProtocol },
    { id: "core-persona", owner: "agent", cacheScope: "session", content: corePersonaSection },
    { id: "agent-orchestration", owner: "platform", cacheScope: "session", content: agentOrchestrationSection },
    { id: "web-access", owner: "platform", cacheScope: "session", content: webAccessSection },
    { id: "menu-usage", owner: "platform", cacheScope: "session", content: menuUsageSection },
    { id: "clarification-mode", owner: "platform", cacheScope: "session", content: clarifyingSection },
    { id: "knowledge-management", owner: "platform", cacheScope: "session", content: knowledgeManagementSection },
    { id: "memory-capture", owner: "platform", cacheScope: "session", content: memoryCaptureSection },
    { id: "self-update", owner: "platform", cacheScope: "session", content: selfUpdateSection },
    { id: "generic-agent-update", owner: "platform", cacheScope: "session", content: genericAgentUpdateSection },
    { id: "context-layer-contract", owner: "platform", cacheScope: "static", content: contextLayerContract },
    {
      id: "email-registration-workflow",
      owner: "platform",
      cacheScope: "static",
      content: emailRegistrationWorkflow,
    },
    {
      id: "web-research-tool-policy",
      owner: "platform",
      cacheScope: "static",
      content: webResearchToolPolicy,
    },
    { id: "user-global-prompt", owner: "user", cacheScope: "session", content: userGlobalPromptSection },
    { id: "response-guidelines", owner: "platform", cacheScope: "session", content: responseGuidelinesSection },
    { id: "skill-guidance", owner: "runtime", cacheScope: "turn", content: skillGuidanceSection },
    { id: "space-context", owner: "runtime", cacheScope: "turn", content: spaceContextSection },
    { id: "reference-materials", owner: "agent", cacheScope: "turn", content: referenceMaterialsSection },
    { id: "memory-overlay", owner: "runtime", cacheScope: "turn", content: memoryOverlaySection },
    { id: "app-working-memory", owner: "runtime", cacheScope: "turn", content: appWorkingMemorySection },
    { id: "dialog-summary", owner: "runtime", cacheScope: "turn", content: dialogSummarySection },
    { id: "proactive-summary", owner: "runtime", cacheScope: "turn", content: proactiveSummarySection },
    { id: "editing-context", owner: "runtime", cacheScope: "turn", content: editingContextSection },
    {
      id: "current-time",
      owner: "platform",
      cacheScope: "turn",
      content: buildCurrentTimeBlock(now, timeZone),
    },
  ]);
};

// 向后兼容：旧名称重新导出
export const generatePrompt = buildSystemPrompt;
