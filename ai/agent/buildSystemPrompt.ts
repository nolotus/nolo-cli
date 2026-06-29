// 文件路径: ai/agent/buildSystemPrompt.ts
// 平台通用 Agent System Prompt 生成器
// 所有模型调用的 system prompt 均由此函数构建

import { mapLanguage } from "../../app/i18n/mapLanguage";
import { Agent } from "../../app/types";
import { buildSkillGuidancePromptBlock } from "../skills/referenceRuntime";
import { buildRuntimeGuidanceBlocks } from "../agent/runtimeGuidance";
import { canonicalizeToolNames } from "../tools/toolNameAliases";
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
在需要获取外部信息时，请遵循以下由简入繁的策略：

0. **如果用户已经给了明确 URL，先直接抓这些 URL**
   - 不要先搜索，不要先猜备用网址，不要忽略用户给的链接。
   - 用户明确给出的 URL，默认就是本次任务的最高优先级网页真值来源。
   - 如果任务是“根据这些网页更新代码 / 文档 / 配置”，先逐个 fetch，再基于抓到的内容提取字段。
   - 只要这些 URL 能正常抓取，就不要再调用 exa_search 搜索“更权威”的来源，也不要自行切换到其他站点或镜像页。
   - 只有在用户给的 URL 抓取失败、页面明显缺字段、或页面内容与任务不匹配时，才允许额外搜索；如果发生这种降级，最终回复里要明确说明原因。

1. **优先使用 exa_search (Exa.ai)**
   - 适用于：用户没有给明确 URL 时，搜索互联网信息、寻找教程、获取最新动态。
   - 对陌生的文档站或你还不确定具体页面路径的 docs 站点，优先先用它发现权威入口，而不是直接猜 docs 子路径。
   - 优点：它是专为 AI 设计的神经网络搜索引擎，能直接返回高质量、结构化的内容（包含正文），无需再去爬取。
   - *Always try this FIRST for searches.*

2. **其次使用 fetchWebpage (全渲染)**
   - 适用于：你已经有了明确的 URL，需要获取该页面的完整内容（含 JS 渲染、动态内容、SPA）。
   - 底层走 Cloudflare Browser Rendering，支持 JS 执行，返回渲染后的正文。
   - 对于 \`docs.*\` 文档站，fetchWebpage 会自动检查 \`/llms.txt\` 和 \`/llms-full.txt\`，并把你推测的文档 URL 规范化为权威页面。
   - 如果你不确定 docs 站里有哪些页面，先用 exa_search 做发现；如果你只是大致猜到了 docs 子路径，可以直接交给 fetchWebpage 去规范化并抓取。
   - 优点：一次调用即可获取完整页面内容，无需手动操控浏览器。

3. **仅当需要复杂交互时使用 browser_openSession**
   - 仅当需要登录、填表、多步点击等复杂操作时使用。
   - 适用于：需要登录的站点、需要填写表单、需要连续交互的场景。
   - 流程：先 openSession -> 拿到 ID -> 再 typeText / click / readContent。


3. **精准数据抓取 (Scrapers)**
  - 如果用户明确需要 YouTube 视频信息、亚马逊商品数据、Google 搜索结果，请直接使用对应的专用 Scraper 工具 (youtubeScraper, amazonProductScraper 等)，效果比自己去爬网页更好。`;

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
- 需要异步启动一个子对话、让当前对话稍后根据子 Agent 的完成/失败继续判断时，使用 startAgentDialog。它只表示 child dialog 已启动或排队，不表示任务已经完成；child 进入 done/failed 后，系统会用 terminal wake 继续父对话，你再读取 child evidence 决定下一步。
- startAgentDialog 是通用多 Agent 协作能力，不限于代码任务；游戏设计、电影策划、写作、运营、研究等需要异步分工的场景也可以使用。
- 需要等待一个短结果并直接综合时，使用 callAgent；需要用户前台实时看到另一个 Agent 发言时，使用 runStreamingAgent。
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

## 三层知识决策

**1. references 挂载知识（每次对话自动加载）**
- Agent 配置里的 references 会在每次对话开始时自动展开注入到 system prompt
- type=instruction：高优先级，注入到 system prompt 顶部，适合行为规则、操作指南
- type=knowledge：作为参考资料注入，适合领域知识、背景资料
- 支持挂载：page / dialog / table（内容完整展开）
- **page 里的 @mention 只展开元信息（标题+dbKey），不递归展开内容本身**

**2. createDoc 创建文档（按需 read 加载）**
- 总知识页（索引）：跨会话的决策规则、路由表，用 @[page:PAGE-xxx|标题] mention 指向细分页
- 细分知识页（内容）：具体领域内容、任务结果，通过总知识索引
- mention 只是指针，要获取细分页内容必须显式调用 read({ dbKey })

## 读取路径
1. prompt / references 有答案 → 直接用（自动加载，最快）
2. 没有 → read({ dbKey: 总知识索引页 }) 找到细分页 dbKey
3. 找到 dbKey → read({ dbKey: 细分页 }) 获取完整内容

## 何时主动创建/更新知识
- 用户提供了值得复用的信息 → createDoc 记录，再用 updateAgent 把该页加入 references
- 完成有价值的调研/分析 → createDoc 保存结论
- 总知识索引缺入口 → updateDoc 补充 @mention
- **不要**把临时性、一次性的内容写成知识页`;

// ============================================================================
// 长期记忆（有 rememberMemory 工具时注入）
// ============================================================================

const MEMORY_CAPTURE_INSTRUCTIONS = `--- 长期记忆 ---
你拥有 rememberMemory 能力，可以在必要时把值得长期保留的信息写成一条 episodic memory。

## 何时记录
- 当你识别到对未来协作明显有帮助、且相对稳定的用户偏好、判断标准、信息组织偏好或场景化抉择模式时，可以记录
- 当对话里形成了后续还会反复用到的空间共识、协作约定或团队规则时，可以记录

## 何时不要记录
- 一次性的当前任务细节
- 当前对话里显而易见、很快就会过期的事实
- 只是为了“多记一点”而勉强抽出来的内容

## 记录方式
- 优先写成简短、可复用的抽象表达，例如“这个用户在什么场景下通常怎么选 / 怎么协作”
- 不要复制整段对话，也不要把临时上下文原样塞进去
- 只有当前 dialog 明确绑定了 space，且这条信息确实属于共享协作共识时，才传 scope=space；否则保持默认 auto
- 默认静默执行；除非用户正在讨论记忆本身，或需要用户感知这件事，否则不要专门宣布“我正在记忆”
- 如果这条信息对未来帮助不明显，就不要调用 rememberMemory`;

const MEMORY_USE_GUIDANCE = `--- 记忆使用方式 ---
- 记忆是个性化与连续性增强层；当前用户输入、当前对话、系统规则、Agent prompt、skill 和用户全局偏好都优先于记忆。
- 如果记忆包含用户身份、名字、称呼、与你的关系、长期偏好或当前项目背景，相关时要自然体现，例如开场称呼、确认上下文、回答结构、取舍标准或下一步建议；不要每句话机械称呼用户。
- 处理“上次/继续/跟之前一样/这个项目”这类指代时，优先使用当前 dialog、space、project、agent、sourceDialog 等 KV 路径和时间线来定位；不要只按语义相似度捞一条看起来像的记忆。
- 当当前输入给出新的语言、技术栈、项目、数值、约束或明确覆盖旧偏好时，必须采用当前输入；不要把旧记忆当成更高优先级的真值。
- 推断型理解记忆只能帮助你把握语气、状态和未完成事项；不要说成“你明确告诉过我”，也不要把它显示成用户已授权保存的事实。
- 如果记忆互相冲突或适用场景不明，说明你的判断依据或简短确认，而不是硬套。`;

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

  return [
    "--- 当前空间环境 (Current Space Context) ---",
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



const buildSkillGuidanceBlock = (agentConfig: Agent): string => {
  const recommendedSkillHints = Array.isArray((agentConfig as any).recommendedSkillHints)
    ? ((agentConfig as any).recommendedSkillHints as string[]).filter(Boolean)
    : [];
  const skillPromptPatches = Array.isArray((agentConfig as any).skillPromptPatches)
    ? ((agentConfig as any).skillPromptPatches as string[]).filter(Boolean)
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
  agentConfig: Agent;
  language?: string;
  contexts?: Contexts;
  viewport?: { width: number; height: number };
  mobileBreakpoint?: number;
  now?: Date;
  timeZone?: string;
}): string => buildSystemPromptContext(options).content;

export const buildSystemPromptContext = (options: {
  agentConfig: Agent;
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
    ["callAgent", "runStreamingAgent", "startAgentDialog"].includes(t)
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
  const rawMemoryOverlay = contexts.memoryOverlay?.trim() || "";
  const memoryOverlaySection = rawMemoryOverlay
    ? rawMemoryOverlay + "\n\n" + MEMORY_USE_GUIDANCE
    : "";

  const skillGuidanceSection = buildSkillGuidanceBlock(agentConfig);
  const referenceMaterialsSection = buildReferenceMaterialsBlock(contexts);

  const dialogSummarySection = contexts.dialogSummary?.trim()
    ? `--- 历史对话摘要 ---\n以下是此前对话轮次的压缩摘要（精确细节可能有简化，请优先参考最近的消息原文）：\n\n${contexts.dialogSummary.trim()}`
    : "";

  const proactiveSummarySection = contexts.proactiveSummary?.trim()
    ? `--- 阶段工作摘要 ---\n以下是系统主动整理的近期工作摘要，原始消息仍在近期上下文中；如有冲突，请优先参考最近的消息原文：\n\n${contexts.proactiveSummary.trim()}`
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
