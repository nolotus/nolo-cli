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
import { buildIdentityBlock } from "../../agent-runtime/identityBlock";
// 工具驱动指令表（编排/协作 review 硬门等）独立成模块，localLoop 复用同一份。
import { resolveToolGuidedSections } from "./toolGuidedSections";

const CLARIFICATION_MODE_INSTRUCTIONS = `在你还不了解用户意图时，通过提问来澄清需求，而不是仓促给出答案。`;

const isBrowser = typeof window !== "undefined";
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

  const { name, prompt: mainPrompt, dbKey, model } = agentConfig;
  const mappedLanguage = mapLanguage(safeLanguage);

  const identitySection = buildIdentityBlock({
    agentName: name,
    agentId: dbKey,
    model,
    responseLanguage: mappedLanguage,
  });

  const corePersonaSection = mainPrompt
    ? `-- - 核心角色与任务-- -\n${mainPrompt}`
    : "";

  const agentTools = canonicalizeToolNames(agentConfig.tools ?? []);

  // 按工具能力条件注入各指令块（表驱动，见 TOOL_GUIDED_SECTIONS）
  const toolSections = resolveToolGuidedSections(agentTools);

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
  // Memory overlay content (turn-scope: changes when memory updates)
  const memoryOverlaySection = rawMemoryOverlay;
  // Memory use guidance (session-scope: fixed text, never changes between turns).
  // Injected when the agent has memory-related tools, regardless of whether
  // memory-overlay has content this turn. This keeps the guidance in the stable
  // prefix — if it were conditional on memory-overlay being non-empty, the
  // prefix would break when memory first appears or disappears.
  const hasMemoryTools = Array.isArray(agentConfig.tools) && agentConfig.tools.some(
    (t: string) => /memory/i.test(t),
  );
  const memoryUseGuidanceSection = hasMemoryTools ? MEMORY_USE_GUIDANCE : "";

  const skillGuidanceSection = buildSkillGuidanceBlock(agentConfig);
  const referenceMaterialsSection = buildReferenceMaterialsBlock(contexts);

  const dialogSummarySection = contexts.dialogSummary?.trim()
    ? `--- 历史对话摘要 ---\n${wrapHistoricalSummaryWithReplayGuard(contexts.dialogSummary)}`
    : "";

  return compileContextLayers([
    { id: "identity", owner: "platform", cacheScope: "session", content: identitySection },
    { id: "startup-protocol", owner: "platform", cacheScope: "static", content: startupProtocol },
    { id: "core-persona", owner: "agent", cacheScope: "session", content: corePersonaSection },
    { id: "agent-orchestration", owner: "platform", cacheScope: "session", content: toolSections.agentOrchestration },
    { id: "agent-collaboration", owner: "platform", cacheScope: "session", content: toolSections.agentCollaboration },
    { id: "web-access", owner: "platform", cacheScope: "session", content: toolSections.webAccess },
    { id: "menu-usage", owner: "platform", cacheScope: "session", content: toolSections.menuUsage },
    { id: "clarification-mode", owner: "platform", cacheScope: "session", content: clarifyingSection },
    { id: "knowledge-management", owner: "platform", cacheScope: "session", content: toolSections.knowledgeManagement },
    { id: "memory-capture", owner: "platform", cacheScope: "session", content: toolSections.memoryCapture },
    { id: "self-update", owner: "platform", cacheScope: "session", content: toolSections.selfUpdate },
    { id: "generic-agent-update", owner: "platform", cacheScope: "session", content: toolSections.genericAgentUpdate },
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
    { id: "skill-guidance", owner: "runtime", cacheScope: "session", content: skillGuidanceSection },
    { id: "space-context", owner: "runtime", cacheScope: "session", content: spaceContextSection },
    { id: "memory-use-guidance", owner: "platform", cacheScope: "session", content: memoryUseGuidanceSection },
    { id: "reference-materials", owner: "agent", cacheScope: "turn", content: referenceMaterialsSection },
    { id: "memory-overlay", owner: "runtime", cacheScope: "turn", content: memoryOverlaySection },
    { id: "app-working-memory", owner: "runtime", cacheScope: "turn", content: appWorkingMemorySection },
    { id: "dialog-summary", owner: "runtime", cacheScope: "turn", content: dialogSummarySection },
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
