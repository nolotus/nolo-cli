// 文件路径: ai/tools/index.ts

/* ==================================================================
 *  所有 Tool 的统一注册与描述 (最终版：单一事实来源)
 * ==================================================================
 *
 *  如何使用:
 *  1. 为你的工具创建一个新文件 (例如 `myNewTool.ts`)。
 *  2. 在该文件中，导出函数的 schema 和 executor 函数。
 *  3. 在下面的 `toolDefinitions` 数组中，添加一个新的对象来定义你的工具
 *     （或在对应分组文件中添加，然后在此汇总）。
 *
 *  此文件会自动生成 toolRegistry, toolExecutors, toolDescriptions,
 *  以及 toolDefinitionsByName。
 *
 * ================================================================== */

// ---------- 1. 导入所有工具的 Schema 和 Executor ----------
// 计划与编排
import {
  createWorkflowFunctionSchema,
  createWorkflowFunc,
} from "./createWorkflowTool";
import { delayFunctionSchema, delayFunc } from "./delayTool";
import { canonicalizeToolName } from "./toolNameAliases";
import {
  completeDialogGoalFunc,
  completeDialogGoalFunctionSchema,
  createAgentAutomationFunc,
  createAgentAutomationFunctionSchema,
  createDialogGoalFunc,
  createDialogGoalFunctionSchema,
  getDialogGoalFunc,
  getDialogGoalFunctionSchema,
  notifyUserFunc,
  notifyUserFunctionSchema,
  queryModelUsageFunc,
  queryModelUsageFunctionSchema,
  queryUserGrowthReportFunc,
  queryUserGrowthReportFunctionSchema,
} from "./modelUsageTools";

// Agent 相关工具的 schema（用于 patch enum），具体定义移到 agentTools.ts
import { createAgentToolFunctionSchema } from "./agent/createAgentTool";
import { updateAgentToolFunctionSchema } from "./agent/updateAgentTool";

// 内容管理
import { createDocFunctionSchema, createDocFunc } from "./createDocTool";
import {
  createSkillDocFunctionSchema,
  createSkillDocFunc,
} from "./createSkillDocTool";
import { doctorSkillFunctionSchema, doctorSkillFunc } from "./doctorSkillTool";
import { evalSkillFunctionSchema, evalSkillFunc } from "./evalSkillTool";
import { importSkillFunctionSchema, importSkillFunc } from "./importSkillTool";
import {
  readDocFunctionSchema,
  readDocFunc,
  readPageFunctionSchema,
  readPageFunc,
} from "./readDocTool";

// 分类相关工具集中在 ./category 文件夹
import {
  createCategoryFunctionSchema,
  createCategoryFunc,
} from "./category/createCategoryTool";
import {
  updateContentCategoryFunctionSchema,
  updateContentCategoryFunc,
} from "./category/updateContentCategoryTool";
import {
  queryContentsByCategoryFunctionSchema,
  queryContentsByCategoryFunc,
} from "./category/queryContentsByCategoryTool";

// 数据操作
import { importDataFunctionSchema, importDataFunc } from "./importDataTool";
import { executeSqlFunctionSchema, executeSqlFunc } from "./executeSqlTool";
import { readFunctionSchema, readFunc } from "./readTool";
import {
  listUserSpacesFunctionSchema,
  listUserSpacesFunc,
} from "./listUserSpacesTool";
import {
  cliDoctorFunc,
  cliDoctorFunctionSchema,
  cliWhoamiFunc,
  cliWhoamiFunctionSchema,
  deleteDialogsFunc,
  deleteDialogsFunctionSchema,
  deleteDialogsPreviewFunc,
  listAgentsFunc,
  listAgentsFunctionSchema,
  listDialogsFunc,
  listDialogsFunctionSchema,
  listSpacesFunc,
  listSpacesFunctionSchema,
  queryDialogsBySubjectRefFunc,
  queryDialogsBySubjectRefFunctionSchema,
  readAgentFunc,
  readAgentFunctionSchema,
  readDialogFunc,
  readDialogFunctionSchema,
  readSkillDocFunc,
  readSkillDocFunctionSchema,
  readSpaceFunc,
  readSpaceFunctionSchema,
} from "./noloWorkspaceReadTools";
import {
  deleteSpacesFunctionSchema,
  deleteSpacesFunc,
  deleteSpacesPreviewFunc,
} from "./deleteSpacesTool";
import {
  emailArchiveFunc,
  emailArchiveFunctionSchema,
  emailExtractVerificationFunc,
  emailExtractVerificationFunctionSchema,
  emailProvisionIdentityFunc,
  emailProvisionIdentityFunctionSchema,
  emailReadFunc,
  emailReadFunctionSchema,
  emailSearchFunc,
  emailSearchFunctionSchema,
  emailSendFunc,
  emailSendFunctionSchema,
  emailUpdateTagsFunc,
  emailUpdateTagsFunctionSchema,
  emailWaitForFunc,
  emailWaitForFunctionSchema,
} from "./emailTools";
// ✅ 在当前表中新增一行的工具
import {
  addTableRowFunctionSchema,
  addTableRowFunc,
} from "./table/addTableRowTool";
import {
  createTableFunctionSchema,
  createTableFunc,
} from "./table/createTableTool";
import {
  shareTableFunctionSchema,
  shareTableFunc,
} from "./table/shareTableTool";
import {
  addTableRowsFunctionSchema,
  addTableRowsFunc,
  deleteTableRowFunctionSchema,
  deleteTableRowFunc,
  deleteTableRowsFunctionSchema,
  deleteTableRowsFunc,
  queryTableRowsFunctionSchema,
  queryTableRowsFunc,
  updateTableRowFunctionSchema,
  updateTableRowFunc,
  updateTableRowsFunctionSchema,
  updateTableRowsFunc,
} from "./table/rowTools";
import {
  addTableColumnFunctionSchema,
  addTableColumnFunc,
  deleteTableColumnFunctionSchema,
  deleteTableColumnFunc,
  renameTableColumnFunctionSchema,
  renameTableColumnFunc,
  renameTableColumnLabelFunctionSchema,
  renameTableColumnLabelFunc,
  renameTableFunctionSchema,
  renameTableFunc,
} from "./table/schemaTools";

// 网络与智能
import {
  fetchWebpageFunctionSchema,
  fetchWebpageFunc,
} from "./fetchWebpageTool";
import {
  convertMarxistsBookToOfflineHtmlFunctionSchema,
  convertMarxistsBookToOfflineHtmlFunc,
} from "./convertMarxistsBookTool";
import {
  readXPostFunctionSchema,
  readXPostFunc,
} from "./readXPostTool";
import {
  readXhsProfileFunctionSchema,
  readXhsProfileFunc,
} from "./readXhsProfileTool";
export { TOOL_PACKS } from "./toolPacks";
import { TOOL_PACKS } from "./toolPacks";
import {
  surfWeatherFunctionSchema,
  surfWeatherFunc,
} from "./surfWeatherTool";
import {
  wereadGatewayFunctionSchema,
  wereadGatewayFunc,
} from "./wereadGatewayTool";

import {
  browser_closeSession_Schema,
  browser_closeSession_Func,
} from "./browserTools/closeSession";
import {
  browser_openSession_Schema,
  browser_openSession_Func,
} from "./browserTools/openSession";
import {
  browser_selectOption_Schema,
  browser_selectOption_Func,
} from "./browserTools/selectOption";
import {
  browser_click_Schema,
  browser_click_Func,
} from "./browserTools/click";
import {
  browser_typeText_Schema,
  browser_typeText_Func,
} from "./browserTools/typeText";
import {
  browser_readContent_Schema,
  browser_readContent_Func,
} from "./browserTools/readContent";
import {
  chromeConnectorToolSchemas,
  chromeConnectorUnavailableFunc,
  getChromeConnectorToolBehavior,
  getChromeConnectorToolDefaultConsent,
} from "./chromeConnectorTools";
import {
  exaSearchSchema,
  exaSearchFunc,
} from "./exaSearchTool";
import {
  firecrawlScrapeSchema,
  firecrawlScrapeFunc,
  firecrawlSearchSchema,
  firecrawlSearchFunc,
} from "./firecrawlTool";
import {
  olmOcrSchema,
  olmOcrFunc,
} from "./olmOcrTool";
import {
  whisperTurboSchema,
  whisperTurboFunc,
  whisperV3Schema,
  whisperV3Func,
} from "./whisperTool";




// ✅ generateDocx 工具（前端生成并下载 DOCX）
import {
  generateDocxFunctionSchema,
  generateDocxFunc,
} from "./generateDocxTool";

// ✅ Google Search Scraper (Apify)
import {
  googleSearchScraperFunctionSchema,
  googleSearchScraperFunc,
} from "./googleSearchScraperTool";

// ✅ Cloudflare Browser Rendering 爬取工具
import {
  cloudflareCrawlFunctionSchema,
  cloudflareCrawlFunc,
  cloudflareCrawlStatusFunctionSchema,
  cloudflareCrawlStatusFunc,
} from "./cloudflareCrawlTool";

// ✅ Apify / 抓取相关工具
import {
  youtubeScraperFunctionSchema,
  youtubeScraperFunc,
} from "./youtubeScraperTool";
import {
  ecommerceScraperFunctionSchema,
  ecommerceScraperFunc,
} from "./ecommerceScraperTool";
import {
  amazonProductScraperFunctionSchema,
  amazonProductScraperFunc,
} from "./amazonProductScraperTool";
import {
  taobaoTmallProductScraperFunctionSchema,
  taobaoTmallProductScraperFunc,
} from "./taobaoTmallProductScraperTool";
import {
  jdProductScraperFunctionSchema,
  jdProductScraperFunc,
} from "./jdProductScraperTool";

// ✅ 多模态：Gemini 图片（2.5 Flash 文生图 / 3 Pro 编辑）
import {
  geminiFlashLiteImageFunctionSchema,
  geminiFlashLiteImageFunc,
  geminiFlashImageFunctionSchema,
  geminiFlashImageFunc,
  geminiProImagePreviewFunctionSchema,
  geminiProImagePreviewFunc,
} from "./geminiImagePreviewTool";
import {
  openAIGptImageEditFunctionSchema,
  openAIGptImageEditFunc,
  openAIGptImageFunctionSchema,
  openAIGptImageGenerateFunctionSchema,
  openAIGptImageGenerateFunc,
  openAIGptImageFunc,
} from "./openaiImageTool";
import {
  remotionRenderVideoFunctionSchema,
  remotionRenderVideoFunc,
} from "./remotionVideoTool";
import { uiAskChoiceFunc, uiAskChoiceFunctionSchema } from "./uiAskChoiceTool";
import {
  rememberMemoryFunc,
  rememberMemoryFunctionSchema,
} from "./rememberMemoryTool";
import { execShellFunctionSchema, execShellFunc } from "./execShellTool";
import { checkEnvFunctionSchema, checkEnvFunc } from "./checkEnvTool";

import { agentToolDefinitions } from "./agent/agentTools";
import { codeToolDefinitions } from "./codeTools";
import {
  cfScreenshotFunctionSchema,
  cfScreenshotFunc,
  cfGetMarkdownFunctionSchema,
  cfGetMarkdownFunc,
  cfGeneratePDFFunctionSchema,
  cfGeneratePDFFunc,
  cfExtractJSONFunctionSchema,
  cfExtractJSONFunc,
} from "./cfBrowserTools";
import {
  appPreflightFunctionSchema,
  appPreflightFunc,
  appDeployFunctionSchema,
  appDeployFunc,
  appListFunctionSchema,
  appListFunc,
  appDeleteFunctionSchema,
  appDeleteFunc,
  appReadFunctionSchema,
  appReadFunc,
  appFileListFunctionSchema,
  appFileListFunc,
  appFileReadFunctionSchema,
  appFileReadFunc,
  appFileSearchFunctionSchema,
  appFileSearchFunc,
  appFileReplaceFunctionSchema,
  appFileReplaceFunc,
  appFileWriteFunctionSchema,
  appFileWriteFunc,
} from "./appTools";
import {
  cfSpeechToTextFunctionSchema,
  cfSpeechToTextFunc,
} from "./cfSpeechToTextTool";
import {
  updateContentTitleTool,
  updateContentTitleFunc,
} from "./updateContentTitleTool";
import {
  searchAllSpacesFunc,
  searchAllSpacesFunctionSchema,
  searchWorkspaceFunctionSchema,
  searchWorkspaceFunc,
} from "./searchWorkspaceTool";
import {
  searchDialogMessagesFunc,
  searchDialogMessagesFunctionSchema,
} from "./searchDialogMessagesTool";
import {
  updateDocFunctionSchema,
  updateDocFunc,
} from "./updateDocTool";
import {
  updateUserPreferenceProfileFunctionSchema,
  updateUserPreferenceProfileFunc,
} from "./updateUserPreferenceProfileTool";
import {
  ziweiChartFunctionSchema,
  ziweiChartFunc,
} from "./ziweiChartTool";


// ---------- 2. 定义工具规范接口 ----------

export type ToolBehavior = "orchestrator" | "data" | "action" | "answer";
export type ToolCapability =
  | "knowledge_capture"
  | "space_context"
  | "self_evolution"
  | "web_access"
  | "browser_automation"
  | "code_edit"
  | "app_deploy"
  | "general";
export type ToolRiskLevel = "low" | "medium" | "high";
export type ToolCostLevel = "low" | "medium" | "high";
export type ToolConsentMode = "auto" | "ask" | "blocked";

// 交互模式：
// - auto: 直接执行
// - confirm: 需要用户确认后才执行（危险操作）
// - authorize: 需要用户授权后才执行（权限/敏感资源）
export type ToolInteraction = "auto" | "confirm" | "authorize";

/**
 * 前端分组用：
 * - general: 普通
 * - agent  : Agent / 应用相关
 * - content: 内容与页面
 * - media  : 多媒体（生成图片 / 生成视频等）
 * - data   : 数据操作
 */
export type ToolUiGroup = "general" | "agent" | "content" | "media" | "data";

/**
 * 分组元信息：
 * - id: 分组 ID（与 ToolUiGroup 一致）
 * - label: 默认中文标题（前端可直接用，也可以自己做 i18n 映射）
 * - order: 分组显示顺序（从小到大）
 * - fallbackCategories:
 *   当某个工具没有显式指定 uiGroup 时，可以根据工具的 category 使用兜底分组。
 */
export interface ToolGroupMeta {
  id: ToolUiGroup;
  label: string;
  order: number;
  fallbackCategories?: string[];
}

/**
 * 单一事实来源：所有分组配置
 * 以后增加 / 修改分组，只需要改这里一处。
 */
export const TOOL_GROUP_META: ToolGroupMeta[] = [
  {
    id: "general",
    label: "普通",
    order: 0,
  },
  {
    id: "agent",
    label: "Agent / 应用",
    order: 1,
  },
  {
    id: "content",
    label: "内容与页面",
    order: 2,
    fallbackCategories: ["内容管理"],
  },
  {
    id: "media",
    label: "多媒体生成",
    order: 3,
    fallbackCategories: ["多媒体生成"],
  },
  {
    id: "data",
    label: "数据操作",
    order: 4,
    fallbackCategories: ["数据操作"],
  },
];

export interface ToolDefinition {
  id: string; // 唯一ID (camelCase)
  schema: any; // 提供给 LLM 的函数 Schema

  executor: (
    args: any,
    thunkApi: any,
    context?: { parentMessageId: string; signal?: AbortSignal; toolRunId?: string }
  ) => Promise<any>;

  /**
   * ✅ 新增：预览执行（无副作用）
   * - 仅当 interaction 为 confirm/authorize 时会被调用
   * - 用于生成 “待确认/待授权” 阶段的 tool message content（预览输出）
   */
  previewExecutor?: (
    args: any,
    thunkApi: any,
    context?: { parentMessageId: string; signal?: AbortSignal; toolRunId?: string }
  ) => Promise<any>;

  description: {
    name: string;
    description: string;
    category: string;
  };

  behavior?: ToolBehavior; // 工具在系统中的角色
  capability?: ToolCapability; // 用户策略与预算主要按 capability 生效
  interaction?: ToolInteraction; // 不写默认 "auto"
  uiGroup?: ToolUiGroup; // 前端展示分组，不写默认 "general"
  riskLevel?: ToolRiskLevel;
  costLevel?: ToolCostLevel;
  defaultConsent?: ToolConsentMode;

  /**
   * ✅ 新增：是否支持取消（未来 executeToolRun 传 signal 后即可实现）
   * - 现在先作为 UI/能力标记预留，不影响 DB 结构
   */
  cancelable?: boolean;

  /**
   * ✅ 新增：授权相关元信息预留（未来可扩展，不强制使用）
   * - 现在不实现授权策略，仅留接口，避免未来改 DB/大改代码
   */
  auth?: {
    kind: "domain" | "resource" | "scopes";
    scopeHint?: string; // 给 UI/日志的提示
  };
}

/* ==================================================================
 *  2.1 toolquery 工具：帮助模型发现可用工具
 * ================================================================== */

export const toolQueryFunctionSchema = {
  name: "toolquery",
  description:
    "根据当前任务描述，列出系统中可能有用的工具。适合在不确定可用工具时先调用本函数。",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "用户当前的任务或需求描述。",
      },
      top_k: {
        type: "number",
        description: "最多返回多少个候选工具（默认 5）。",
        default: 5,
      },
    },
    required: ["task"],
  },
};

export async function toolQueryFunc(args: any): Promise<{
  rawData: any;
  displayData: string;
}> {
  const { task, top_k } = args || {};
  const query = String(task || "").trim();
  const topK = typeof top_k === "number" && top_k > 0 && top_k < 50 ? top_k : 5;

  if (!query) {
    const msg = "toolquery 需要提供 task 描述，比如：'分析数据库相关的工具'。";
    return { rawData: [], displayData: msg };
  }

  const lowered = query.toLowerCase();

  const candidates = toolDefinitions
    .filter((tool) => tool.id !== "toolquery")
    .map((tool) => {
      const { description, behavior } = tool;
      const haystack =
        `${description.name} ${description.description} ${description.category} ${behavior || ""}`.toLowerCase();
      const score = haystack.includes(lowered) ? 1 : 0;
      return { tool, score };
    })
    .filter((item) => item.score > 0)
    .slice(0, topK);

  const rawData = candidates.map(({ tool }) => ({
    name: tool.schema.name,
    id: tool.id,
    description: tool.description.description,
    category: tool.description.category,
    behavior: tool.behavior ?? null,
  }));

  let displayData: string;

  if (rawData.length === 0) {
    displayData =
      `根据当前描述暂时没有找到明显匹配的工具。\n` +
      `你可以尝试：\n` +
      `- 换一种更具体的说法描述任务\n` +
      `- 直接选择你认为合适的工具调用`;
  } else {
    displayData =
      `根据你的任务描述，我找到了 ${rawData.length} 个可能有用的工具：\n\n` +
      rawData
        .map((t: any, idx: number) => {
          const behaviorLabel = t.behavior ? `，类型：${t.behavior}` : "";
          return `${idx + 1}. \`${t.name}\`（${t.category}${behaviorLabel}）\n   - ${t.description}`;
        })
        .join("\n");
  }

  return { rawData, displayData };
}

/* ==================================================================
 *  3. [核心] 单一事实来源：在此处定义所有工具
 * ================================================================== */

// 这里保留“非 Agent / 非代码”的工具定义，
// Agent 工具在 agentTools.ts，代码相关工具在 codeTools.ts。
const baseToolDefinitions: ToolDefinition[] = [
  {
    id: "uiAskChoice",
    schema: uiAskChoiceFunctionSchema,
    executor: uiAskChoiceFunc,
    description: {
      name: "ui_ask_choice",
      description:
        "向用户提出一个带多个选项的问题，让界面展示按钮供用户选择。",
      category: "交互 / UI",
    },
    behavior: "answer",
  },
  {
    id: "rememberMemory",
    schema: rememberMemoryFunctionSchema,
    executor: rememberMemoryFunc,
    description: {
      name: "rememberMemory",
      description: "将值得长期保留的用户偏好或空间共识写入一条 episodic memory。",
      category: "记忆 / 长期上下文",
    },
    behavior: "action",
  },
  {
    id: "updateUserPreferenceProfile",
    schema: updateUserPreferenceProfileFunctionSchema,
    executor: updateUserPreferenceProfileFunc,
    description: {
      name: "updateUserPreferenceProfile",
      description: "保存用户的语气、知识沉淀、空间读取等个性化偏好设置。",
      category: "用户设置 / 个性化",
    },
    behavior: "action",
  },
  {
    id: "ziweiChart",
    schema: ziweiChartFunctionSchema,
    executor: ziweiChartFunc,
    description: {
      name: "ziweiChart",
      description: "生成紫微斗数本命盘，并输出可读的十二宫文字盘。",
      category: "命理 / 排盘",
    },
    behavior: "answer",
    capability: "general",
    uiGroup: "general",
    riskLevel: "low",
    costLevel: "low",
    defaultConsent: "auto",
  },

  // --- 计划与编排（不含 Agent 专用） ---
  {
    id: "createWorkflow",
    schema: createWorkflowFunctionSchema,
    executor: createWorkflowFunc,
    description: {
      name: "createWorkflow",
      description:
        "当执行路径已知时，定义并执行一个多步骤 workflow。引擎自动运行，无需每步调用 LLM，大幅节省 token。",
      category: "计划与编排",
    },
    behavior: "orchestrator",
  },
  {
    id: "toolquery",
    schema: toolQueryFunctionSchema,
    executor: toolQueryFunc,
    description: {
      name: "toolquery",
      description:
        "根据任务描述列出可能有用的工具，帮助你选择合适的工具链。",
      category: "计划与编排",
    },
    behavior: "answer",
  },
  {
    id: "delay",
    schema: delayFunctionSchema,
    executor: delayFunc,
    description: {
      name: "delay",
      description:
        "让计划暂停一小段时间（毫秒），用于节流批量操作（例如连续下载多个文件）。",
      category: "计划与编排",
    },
    behavior: "action",
  },
  {
    id: "queryModelUsage",
    schema: queryModelUsageFunctionSchema,
    executor: queryModelUsageFunc,
    description: {
      name: "queryModelUsage",
      description:
        "查询模型/API 用量与费用，带用户/管理员权限限制，可用于每日用量告警。",
      category: "计费 / 用量",
    },
    behavior: "answer",
    uiGroup: "general",
    capability: "general",
    riskLevel: "low",
    costLevel: "low",
    defaultConsent: "auto",
  },
  {
    id: "queryUserGrowthReport",
    schema: queryUserGrowthReportFunctionSchema,
    executor: queryUserGrowthReportFunc,
    description: {
      name: "queryUserGrowthReport",
      description: "读取管理员增长统计报表，用于生成增长汇报。",
      category: "统计",
    },
    behavior: "data",
    uiGroup: "general",
    capability: "general",
    riskLevel: "low",
    costLevel: "low",
    defaultConsent: "auto",
  },
  {
    id: "createDialogGoal",
    schema: createDialogGoalFunctionSchema,
    executor: createDialogGoalFunc,
    description: {
      name: "createDialogGoal",
      description: "为当前对话创建或替换一个目标，并可选设置 token 预算。",
      category: "计划与编排",
    },
    behavior: "action",
    uiGroup: "general",
    capability: "general",
    riskLevel: "low",
    costLevel: "low",
    defaultConsent: "auto",
  },
  {
    id: "getDialogGoal",
    schema: getDialogGoalFunctionSchema,
    executor: getDialogGoalFunc,
    description: {
      name: "getDialogGoal",
      description: "读取当前对话目标、完成状态和 token 预算报告。",
      category: "计划与编排",
    },
    behavior: "answer",
    uiGroup: "general",
    capability: "general",
    riskLevel: "low",
    costLevel: "low",
    defaultConsent: "auto",
  },
  {
    id: "completeDialogGoal",
    schema: completeDialogGoalFunctionSchema,
    executor: completeDialogGoalFunc,
    description: {
      name: "completeDialogGoal",
      description: "将当前对话目标标记为完成并持久化。",
      category: "计划与编排",
    },
    behavior: "action",
    uiGroup: "general",
    capability: "general",
    riskLevel: "low",
    costLevel: "low",
    defaultConsent: "auto",
  },
  {
    id: "createAgentAutomation",
    schema: createAgentAutomationFunctionSchema,
    executor: createAgentAutomationFunc,
    description: {
      name: "createAgentAutomation",
      description:
        "创建由 agent 执行的 cron automation，可选择创建后立即试运行一次。",
      category: "计划与编排",
    },
    behavior: "action",
    uiGroup: "general",
    capability: "general",
    riskLevel: "medium",
    costLevel: "low",
    defaultConsent: "ask",
  },
  {
    id: "notifyUser",
    schema: notifyUserFunctionSchema,
    executor: notifyUserFunc,
    description: {
      name: "notifyUser",
      description: "发送站内通知给当前用户，用于告警和任务结果提醒。",
      category: "通知",
    },
    behavior: "action",
    uiGroup: "general",
    capability: "general",
    riskLevel: "low",
    costLevel: "low",
    defaultConsent: "auto",
  },

  // --- 内容管理 ---
  {
    id: "createDoc",
    schema: createDocFunctionSchema,
    executor: createDocFunc,
    description: {
      name: "createDoc",
      description: "在当前空间中创建新页面",
      category: "内容管理",
    },
    behavior: "action",
    uiGroup: "content",
    capability: "knowledge_capture",
    riskLevel: "medium",
    costLevel: "medium",
    defaultConsent: "ask",
  },
  {
    id: "createSkillDoc",
    schema: createSkillDocFunctionSchema,
    executor: createSkillDocFunc,
    description: {
      name: "createSkillDoc",
      description: "创建带 skill-config / eval-config 协议块的本地 skill 文档。",
      category: "内容管理",
    },
    behavior: "action",
    uiGroup: "content",
    capability: "knowledge_capture",
    riskLevel: "medium",
    costLevel: "medium",
    defaultConsent: "ask",
  },
  {
    id: "doctorSkill",
    schema: doctorSkillFunctionSchema,
    executor: doctorSkillFunc,
    description: {
      name: "doctorSkill",
      description: "诊断 skill 文档协议、工具绑定和常见问题。",
      category: "内容管理",
    },
    behavior: "answer",
    uiGroup: "content",
    capability: "knowledge_capture",
    riskLevel: "low",
    costLevel: "low",
  },
  {
    id: "evalSkill",
    schema: evalSkillFunctionSchema,
    executor: evalSkillFunc,
    description: {
      name: "evalSkill",
      description: "根据 eval-config 评估一个 skill 文档是否满足预期。",
      category: "内容管理",
    },
    behavior: "answer",
    uiGroup: "content",
    capability: "knowledge_capture",
    riskLevel: "low",
    costLevel: "low",
  },
  {
    id: "importSkill",
    schema: importSkillFunctionSchema,
    executor: importSkillFunc,
    description: {
      name: "importSkill",
      description: "导入外部 SKILL.md 或 Markdown skill 文档到当前空间。",
      category: "内容管理",
    },
    behavior: "action",
    uiGroup: "content",
    capability: "knowledge_capture",
    riskLevel: "medium",
    costLevel: "medium",
    defaultConsent: "ask",
  },
  {
    id: "wereadGateway",
    schema: wereadGatewayFunctionSchema,
    executor: wereadGatewayFunc,
    description: {
      name: "wereadGateway",
      description: "调用微信读书接口，支持书架、搜索、阅读统计、笔记划线、书评和推荐。",
      category: "网络",
    },
    behavior: "data",
    uiGroup: "external",
    capability: "web_search",
    riskLevel: "low",
    costLevel: "low",
  },
  {
    id: "readDoc",
    schema: readDocFunctionSchema,
    executor: readDocFunc,
    description: {
      name: "readDoc",
      description: "读取指定文档/页面的内容（Markdown 格式）",
      category: "内容管理",
    },
    behavior: "data",
    uiGroup: "content",
    capability: "space_context",
    riskLevel: "low",
    costLevel: "medium",
  },
  {
    id: "readSkillDoc",
    schema: readSkillDocFunctionSchema,
    executor: readSkillDocFunc,
    description: {
      name: "readSkillDoc",
      description: "Read a Nolo skill doc/page.",
      category: "Nolo workspace",
    },
    behavior: "data",
    uiGroup: "content",
    capability: "space_context",
    riskLevel: "low",
    costLevel: "medium",
  },
  {
    id: "readPage",
    schema: readPageFunctionSchema,
    executor: readPageFunc,
    description: {
      name: "readPage",
      description: "读取指定页面的内容（Markdown 格式，兼容旧名称）",
      category: "内容管理",
    },
    behavior: "data",
    uiGroup: "content",
    capability: "space_context",
    riskLevel: "low",
    costLevel: "medium",
  },
  {
    id: "updateDoc",
    schema: updateDocFunctionSchema,
    executor: updateDocFunc,
    description: {
      name: "updateDoc",
      description: "更新指定页面/文档的内容。支持全量覆盖或在末尾追加内容。",
      category: "内容管理",
    },
    behavior: "action",
    uiGroup: "content",
    capability: "knowledge_capture",
    riskLevel: "medium",
    costLevel: "medium",
    defaultConsent: "ask",
  },
  {
    id: "searchWorkspace",
    schema: searchWorkspaceFunctionSchema,
    executor: searchWorkspaceFunc,
    description: {
      name: "search_workspace",
      description: "在当前空间（Workspace）中搜索页面、表格等内容。",
      category: "内容管理",
    },
    behavior: "data",
    uiGroup: "content",
    capability: "space_context",
    riskLevel: "low",
    costLevel: "low",
  },
  {
    id: "searchAllSpaces",
    schema: searchAllSpacesFunctionSchema,
    executor: searchAllSpacesFunc,
    description: {
      name: "search_all_spaces",
      description: "在你可访问的全部空间中搜索页面、表格等内容，并返回所属空间。",
      category: "内容管理",
    },
    behavior: "data",
    uiGroup: "content",
    capability: "space_context",
    riskLevel: "low",
    costLevel: "medium",
  },
  {
    id: "searchDialogMessages",
    schema: searchDialogMessagesFunctionSchema,
    executor: searchDialogMessagesFunc,
    description: {
      name: "searchDialogMessages",
      description: "在指定对话的原始消息中搜索文本，并返回命中的 messageId、角色、原文片段和邻近上下文。",
      category: "内容管理",
    },
    behavior: "data",
    uiGroup: "content",
    capability: "space_context",
    riskLevel: "low",
    costLevel: "low",
  },
  {
    id: "createCategory",
    schema: createCategoryFunctionSchema,
    executor: createCategoryFunc,
    description: {
      name: "createCategory",
      description: "在当前空间中创建新分类",
      category: "内容管理",
    },
    behavior: "action",
    uiGroup: "content",
  },
  {
    id: "updateContentCategory",
    schema: updateContentCategoryFunctionSchema,
    executor: updateContentCategoryFunc,
    description: {
      name: "updateContentCategory",
      description: "更新内容的分类",
      category: "内容管理",
    },
    behavior: "action",
    uiGroup: "content",
  },
  {
    id: "queryContentsByCategory",
    schema: queryContentsByCategoryFunctionSchema,
    executor: queryContentsByCategoryFunc,
    description: {
      name: "queryContentsByCategory",
      description: "查询分类下的所有内容",
      category: "内容管理",
    },
    behavior: "data",
    uiGroup: "content",
  },

  // --- 数据操作 ---
  {
    id: "createTable",
    schema: createTableFunctionSchema,
    executor: createTableFunc,
    description: {
      name: "createTable",
      description: "在当前租户下创建一张新的数据表，并定义字段结构。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
    capability: "knowledge_capture",
    riskLevel: "medium",
    costLevel: "medium",
    defaultConsent: "ask",
  },
  {
    id: "shareTable",
    schema: shareTableFunctionSchema,
    executor: shareTableFunc,
    description: {
      name: "shareTable",
      description: "把表发布为可分享链接，可用于社区分享。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
    riskLevel: "medium",
    costLevel: "low",
    defaultConsent: "ask",
  },
  {
    id: "importData",
    schema: importDataFunctionSchema,
    executor: importDataFunc,
    description: {
      name: "importData",
      description: "将用户上传的文件数据导入数据库表",
      category: "数据操作",
    },
    behavior: "data",
    uiGroup: "data",
    capability: "space_context",
    riskLevel: "low",
    costLevel: "medium",
  },
  {
    id: "executeSql",
    schema: executeSqlFunctionSchema,
    executor: executeSqlFunc,
    description: {
      name: "executeSql",
      description: "直接执行 SQL 语句",
      category: "数据操作",
    },
    behavior: "data",
    uiGroup: "data",
  },
  {
    id: "read",
    schema: readFunctionSchema,
    executor: readFunc,
    description: {
      name: "read",
      description:
        "根据指定的 dbKey 从本地/远程数据库读取一条记录，可选择本地优先或等待远程结果。",
      category: "数据操作",
    },
    behavior: "data",
    uiGroup: "data",
  },
  {
    id: "email_provision_identity",
    schema: emailProvisionIdentityFunctionSchema,
    executor: emailProvisionIdentityFunc,
    description: {
      name: "email_provision_identity",
      description: "为 agent 生成并绑定受控域名邮箱身份。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
    riskLevel: "medium",
    costLevel: "low",
    defaultConsent: "ask",
  },
  {
    id: "email_send",
    schema: emailSendFunctionSchema,
    executor: emailSendFunc,
    description: {
      name: "email_send",
      description: "以 agent 已绑定邮箱身份发送邮件。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
    riskLevel: "medium",
    costLevel: "low",
    defaultConsent: "ask",
  },
  {
    id: "email_wait_for",
    schema: emailWaitForFunctionSchema,
    executor: emailWaitForFunc,
    description: {
      name: "email_wait_for",
      description: "等待符合条件的邮件到达。",
      category: "数据操作",
    },
    behavior: "data",
    uiGroup: "data",
    riskLevel: "low",
    costLevel: "low",
  },
  {
    id: "email_extract_verification",
    schema: emailExtractVerificationFunctionSchema,
    executor: emailExtractVerificationFunc,
    description: {
      name: "email_extract_verification",
      description: "从邮件中提取验证码和验证链接。",
      category: "数据操作",
    },
    behavior: "data",
    uiGroup: "data",
    riskLevel: "low",
    costLevel: "low",
  },
  {
    id: "email_search",
    schema: emailSearchFunctionSchema,
    executor: emailSearchFunc,
    description: {
      name: "email_search",
      description: "查询当前主体可访问的邮件列表。",
      category: "数据操作",
    },
    behavior: "data",
    uiGroup: "data",
    riskLevel: "low",
    costLevel: "low",
  },
  {
    id: "email_read",
    schema: emailReadFunctionSchema,
    executor: emailReadFunc,
    description: {
      name: "email_read",
      description: "读取一封邮件的完整内容。",
      category: "数据操作",
    },
    behavior: "data",
    uiGroup: "data",
    riskLevel: "low",
    costLevel: "low",
  },
  {
    id: "email_update_tags",
    schema: emailUpdateTagsFunctionSchema,
    executor: emailUpdateTagsFunc,
    description: {
      name: "email_update_tags",
      description: "替换一封邮件的 tags。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
    riskLevel: "medium",
    costLevel: "low",
  },
  {
    id: "email_archive",
    schema: emailArchiveFunctionSchema,
    executor: emailArchiveFunc,
    description: {
      name: "email_archive",
      description: "把一封邮件移动到 archive mailbox。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
    riskLevel: "medium",
    costLevel: "low",
  },
  {
    id: "addTableRow",
    schema: addTableRowFunctionSchema,
    executor: addTableRowFunc,
    description: {
      name: "addTableRow",
      description:
        "在当前已打开的表中新增一行数据，通常由 AI 根据分析结果自动填充各列。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
  },
  {
    id: "queryTableRows",
    schema: queryTableRowsFunctionSchema,
    executor: queryTableRowsFunc,
    description: {
      name: "queryTableRows",
      description: "查询指定表中的行，支持过滤、排序和分页。",
      category: "数据操作",
    },
    behavior: "data",
    uiGroup: "data",
  },
  {
    id: "updateTableRow",
    schema: updateTableRowFunctionSchema,
    executor: updateTableRowFunc,
    description: {
      name: "updateTableRow",
      description: "更新表中的单行数据。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
  },
  {
    id: "deleteTableRow",
    schema: deleteTableRowFunctionSchema,
    executor: deleteTableRowFunc,
    description: {
      name: "deleteTableRow",
      description: "删除表中的单行数据。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
  },
  {
    id: "addTableRows",
    schema: addTableRowsFunctionSchema,
    executor: addTableRowsFunc,
    description: {
      name: "addTableRows",
      description: "批量向表中新增多行数据。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
  },
  {
    id: "updateTableRows",
    schema: updateTableRowsFunctionSchema,
    executor: updateTableRowsFunc,
    description: {
      name: "updateTableRows",
      description: "批量更新表中的多行数据。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
  },
  {
    id: "deleteTableRows",
    schema: deleteTableRowsFunctionSchema,
    executor: deleteTableRowsFunc,
    description: {
      name: "deleteTableRows",
      description: "批量删除表中的多行数据。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
  },
  {
    id: "addTableColumn",
    schema: addTableColumnFunctionSchema,
    executor: addTableColumnFunc,
    description: {
      name: "addTableColumn",
      description: "向表中新增字段。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
  },
  {
    id: "deleteTableColumn",
    schema: deleteTableColumnFunctionSchema,
    executor: deleteTableColumnFunc,
    description: {
      name: "deleteTableColumn",
      description: "删除表中的字段，并同步清理现有行数据。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
  },
  {
    id: "renameTableColumn",
    schema: renameTableColumnFunctionSchema,
    executor: renameTableColumnFunc,
    description: {
      name: "renameTableColumn",
      description: "修改表字段的 machine name，并迁移已有行数据。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
  },
  {
    id: "renameTableColumnLabel",
    schema: renameTableColumnLabelFunctionSchema,
    executor: renameTableColumnLabelFunc,
    description: {
      name: "renameTableColumnLabel",
      description: "修改表字段的显示名。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
  },
  {
    id: "renameTable",
    schema: renameTableFunctionSchema,
    executor: renameTableFunc,
    description: {
      name: "renameTable",
      description: "更新表的显示名称。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
  },
  {
    id: "updateContentTitle",
    schema: updateContentTitleTool.function,
    executor: updateContentTitleFunc as any,
    description: {
      name: "update_content_title",
      description: "更新当前空间中某个内容的标题",
      category: "内容管理",
    },
    behavior: "action",
    uiGroup: "content",
  },
  // === Space 导航工具 ===
  {
    id: "listUserSpaces",
    schema: listUserSpacesFunctionSchema,
    executor: listUserSpacesFunc,
    description: {
      name: "listUserSpaces",
      description:
        "获取当前用户可访问的所有 Space 列表（概览），只返回 ID 和名称。",
      category: "数据操作",
    },
    behavior: "data",
    uiGroup: "data",
  },
  {
    id: "listDialogs",
    schema: listDialogsFunctionSchema,
    executor: listDialogsFunc,
    description: {
      name: "listDialogs",
      description: "List the current user's Nolo dialogs.",
      category: "Nolo workspace",
    },
    behavior: "data",
    uiGroup: "content",
    capability: "space_context",
    riskLevel: "low",
    costLevel: "low",
  },
  {
    id: "readDialog",
    schema: readDialogFunctionSchema,
    executor: readDialogFunc,
    description: {
      name: "readDialog",
      description: "Read a Nolo dialog and recent messages.",
      category: "Nolo workspace",
    },
    behavior: "data",
    uiGroup: "content",
    capability: "space_context",
    riskLevel: "low",
    costLevel: "medium",
  },
  {
    id: "queryDialogsBySubjectRef",
    schema: queryDialogsBySubjectRefFunctionSchema,
    executor: queryDialogsBySubjectRefFunc,
    description: {
      name: "queryDialogsBySubjectRef",
      description: "Query Nolo dialog evidence by generic subjectRefs.",
      category: "Nolo workspace",
    },
    behavior: "data",
    uiGroup: "content",
    capability: "space_context",
    riskLevel: "low",
    costLevel: "low",
  },
  {
    id: "deleteDialogs",
    schema: deleteDialogsFunctionSchema,
    executor: deleteDialogsFunc,
    previewExecutor: deleteDialogsPreviewFunc,
    description: {
      name: "deleteDialogs",
      description:
        "按标题或 ID 删除当前用户拥有的对话；先列出候选，用户确认后才删除。",
      category: "Nolo workspace",
    },
    behavior: "action",
    uiGroup: "content",
    capability: "space_context",
    interaction: "confirm",
    riskLevel: "high",
    costLevel: "low",
    defaultConsent: "ask",
  },
  {
    id: "listAgents",
    schema: listAgentsFunctionSchema,
    executor: listAgentsFunc,
    description: {
      name: "listAgents",
      description: "List the current user's Nolo agents.",
      category: "Nolo workspace",
    },
    behavior: "data",
    uiGroup: "content",
    capability: "space_context",
    riskLevel: "low",
    costLevel: "low",
  },
  {
    id: "readAgent",
    schema: readAgentFunctionSchema,
    executor: readAgentFunc,
    description: {
      name: "readAgent",
      description: "Read a Nolo agent config.",
      category: "Nolo workspace",
    },
    behavior: "data",
    uiGroup: "content",
    capability: "space_context",
    riskLevel: "low",
    costLevel: "low",
  },
  {
    id: "listSpaces",
    schema: listSpacesFunctionSchema,
    executor: listSpacesFunc,
    description: {
      name: "listSpaces",
      description: "List joined Nolo spaces.",
      category: "Nolo workspace",
    },
    behavior: "data",
    uiGroup: "content",
    capability: "space_context",
    riskLevel: "low",
    costLevel: "low",
  },
  {
    id: "readSpace",
    schema: readSpaceFunctionSchema,
    executor: readSpaceFunc,
    description: {
      name: "readSpace",
      description: "Read a Nolo space and its contents.",
      category: "Nolo workspace",
    },
    behavior: "data",
    uiGroup: "content",
    capability: "space_context",
    riskLevel: "low",
    costLevel: "medium",
  },
  {
    id: "cliWhoami",
    schema: cliWhoamiFunctionSchema,
    executor: cliWhoamiFunc,
    description: {
      name: "cliWhoami",
      description: "Show current Nolo runtime identity.",
      category: "Nolo workspace",
    },
    behavior: "data",
    uiGroup: "content",
    capability: "space_context",
    riskLevel: "low",
    costLevel: "low",
  },
  {
    id: "cliDoctor",
    schema: cliDoctorFunctionSchema,
    executor: cliDoctorFunc,
    description: {
      name: "cliDoctor",
      description: "Show current Nolo runtime diagnostics.",
      category: "Nolo workspace",
    },
    behavior: "data",
    uiGroup: "content",
    capability: "space_context",
    riskLevel: "low",
    costLevel: "low",
  },
  {
    id: "deleteSpaces",
    schema: deleteSpacesFunctionSchema,
    executor: deleteSpacesFunc,
    previewExecutor: deleteSpacesPreviewFunc,
    description: {
      name: "deleteSpaces",
      description:
        "按名称或 ID 删除当前用户拥有的 Space；先列出候选，用户确认后才删除 Space 壳和成员关系。",
      category: "数据操作",
    },
    behavior: "action",
    uiGroup: "data",
    capability: "space_context",
    interaction: "confirm",
    riskLevel: "high",
    costLevel: "low",
    defaultConsent: "ask",
  },

  // --- 网络与智能 ---
  {
    id: "fetchWebpage",
    schema: fetchWebpageFunctionSchema,
    executor: fetchWebpageFunc,
    description: {
      name: "fetchWebpage",
      description: "访问网页并获取其内容",
      category: "网络与智能",
    },
    behavior: "data",
  },
  {
    id: "convertMarxistsBookToOfflineHtml",
    schema: convertMarxistsBookToOfflineHtmlFunctionSchema,
    executor: convertMarxistsBookToOfflineHtmlFunc,
    description: {
      name: "convertMarxistsBookToOfflineHtml",
      description:
        "将 Marxists.org 中文旧式书籍页面转换成保留原 CSS、背景和排版的离线单 HTML。",
      category: "网络与智能",
    },
    behavior: "data",
    capability: "web_access",
    riskLevel: "low",
    costLevel: "medium",
    defaultConsent: "auto",
    cancelable: true,
  },
  {
    id: "readXPost",
    schema: readXPostFunctionSchema,
    executor: readXPostFunc,
    description: {
      name: "read_x_post",
      description:
        "读取 X/Twitter status 链接的可见帖子正文和结构化数据，适合总结、解释或抽取用户给出的 X 帖子。",
      category: "网络与智能",
    },
    behavior: "data",
    capability: "web_access",
    riskLevel: "low",
    costLevel: "low",
    defaultConsent: "auto",
    cancelable: true,
  },
  {
    id: "readXhsProfile",
    schema: readXhsProfileFunctionSchema,
    executor: readXhsProfileFunc,
    description: {
      name: "read_xhs_profile",
      description:
        "读取小红书用户主页的公开信息：用户资料、笔记列表、笔记详情指标和评论摘要。适合分析小红书账号内容和互动数据。",
      category: "网络与智能",
    },
    behavior: "data",
    capability: "web_access",
    riskLevel: "low",
    costLevel: "low",
    defaultConsent: "auto",
    cancelable: true,
  },

  {
    id: "surfWeather",
    schema: surfWeatherFunctionSchema,
    executor: surfWeatherFunc,
    description: {
      name: "surfWeather",
      description:
        "获取指定海岸位置的冲浪天气预报（浪高、涌浪、周期、浪向），判断是否适合冲浪。",
      category: "网络与智能",
    },
    behavior: "data",
  },

  // === Cloudflare Browser Rendering 爬取工具 ===
  {
    id: "cloudflareCrawl",
    schema: cloudflareCrawlFunctionSchema,
    executor: cloudflareCrawlFunc,
    description: {
      name: "cloudflareCrawl",
      description:
        "使用 Cloudflare Browser Rendering 爬取整个网站（支持 JS 渲染），一次调用可获取多页 Markdown 内容，适合站点级内容抓取。",
      category: "网络与智能",
    },
    behavior: "data",
  },
  {
    id: "cloudflareCrawlStatus",
    schema: cloudflareCrawlStatusFunctionSchema,
    executor: cloudflareCrawlStatusFunc,
    description: {
      name: "cloudflareCrawlStatus",
      description: "查询 Cloudflare 爬取任务的当前状态和结果（配合 cloudflareCrawl wait=false 使用）。",
      category: "网络与智能",
    },
    behavior: "data",
  },

  // === Apify 抓取工具 ===
  {
    id: "googleSearchScraper",
    schema: googleSearchScraperFunctionSchema,
    executor: googleSearchScraperFunc,
    description: {
      name: "googleSearchScraper",
      description: "抓取 Google 搜索结果（SERP），返回自然结果、广告、People Also Ask 等结构化数据。",
      category: "网络与智能",
    },
    behavior: "data",
  },
  {
    id: "youtubeScraper",
    schema: youtubeScraperFunctionSchema,
    executor: youtubeScraperFunc,
    description: {
      name: "youtubeScraper",
      description:
        "使用 Apify YouTube Scraper 抓取指定视频、频道或搜索结果的详细数据（支持字幕）。",
      category: "网络与智能",
    },
    behavior: "data",
  },
  {
    id: "ecommerceScraper",
    schema: ecommerceScraperFunctionSchema,
    executor: ecommerceScraperFunc,
    description: {
      name: "ecommerceScraper",
      description:
        "使用 Apify E-commerce Scraping Tool 抓取电商产品、评论和卖家信息。",
      category: "网络与智能",
    },
    behavior: "data",
  },
  {
    id: "taobaoTmallProductScraper",
    schema: taobaoTmallProductScraperFunctionSchema,
    executor: taobaoTmallProductScraperFunc,
    description: {
      name: "taobaoTmallProductScraper",
      description:
        "使用 Apify Taobao/Tmall Product Scraper 抓取淘宝/天猫商品真实详情、SKU、价格、库存和规格参数。",
      category: "网络与智能",
    },
    behavior: "data",
    capability: "web_access",
    riskLevel: "low",
    costLevel: "high",
    defaultConsent: "auto",
    cancelable: true,
  },
  {
    id: "jdProductScraper",
    schema: jdProductScraperFunctionSchema,
    executor: jdProductScraperFunc,
    description: {
      name: "jdProductScraper",
      description:
        "抓取京东商品页内嵌真实商品参数，返回标题、品牌、型号、店铺、尺寸重量、价格、图片、变体和库存状态。",
      category: "网络与智能",
    },
    behavior: "data",
    capability: "web_access",
    riskLevel: "low",
    costLevel: "low",
    defaultConsent: "auto",
    cancelable: true,
  },
  {
    id: "amazonProductScraper",
    schema: amazonProductScraperFunctionSchema,
    executor: amazonProductScraperFunc,
    description: {
      name: "amazonProductScraper",
      description:
        "使用 Apify Amazon Product Scraper 抓取亚马逊商品和类目数据。",
      category: "网络与智能",
    },
    behavior: "data",
  },

  // 浏览器会话工具
  {
    id: "browserCloseSession",
    schema: browser_closeSession_Schema,
    executor: browser_closeSession_Func,
    description: {
      name: "browser_closeSession",
      description: "关闭浏览器会话并释放服务器槽位。",
      category: "网络与智能",
    },
    behavior: "action",
  },
  {
    id: "browserOpenSession",
    schema: browser_openSession_Schema,
    executor: browser_openSession_Func,
    description: {
      name: "browser_openSession",
      description: "打开一个新的浏览器会话并导航到 URL，返回会话ID",
      category: "网络与智能",
    },
    behavior: "action",
  },
  {
    id: "browserSelectOption",
    schema: browser_selectOption_Schema,
    executor: browser_selectOption_Func,
    description: {
      name: "browser_selectOption",
      description: "在浏览器会话中选择一个下拉框选项",
      category: "网络与智能",
    },
    behavior: "action",
  },
  {
    id: "browserClick",
    schema: browser_click_Schema,
    executor: browser_click_Func,
    description: {
      name: "browser_click",
      description: "在浏览器会话中点击指定元素 (例如按钮、链接)。",
      category: "网络与智能",
    },
    behavior: "action",
  },
  {
    id: "browserTypeText",
    schema: browser_typeText_Schema,
    executor: browser_typeText_Func,
    description: {
      name: "browser_typeText",
      description: "在浏览器会话中向输入框填写文本 (可选回车)。",
      category: "网络与智能",
    },
    behavior: "action",
  },
  {
    id: "browserReadContent",
    schema: browser_readContent_Schema,
    executor: browser_readContent_Func,
    description: {
      name: "browser_readContent",
      description: "读取当前浏览器页面或指定元素的可见文本内容。",
      category: "网络与智能",
    },
    behavior: "data",
  },
  ...chromeConnectorToolSchemas.map((schema) => ({
    id: schema.name,
    schema,
    executor: chromeConnectorUnavailableFunc,
    description: {
      name: schema.name,
      description: schema.description,
      category: "网络与智能",
    },
    behavior: getChromeConnectorToolBehavior(schema.name),
    capability: "browser_automation" as const,
    riskLevel: schema.name === "chrome_click" || schema.name === "chrome_type"
      ? "medium" as const
      : "low" as const,
    costLevel: "low" as const,
    defaultConsent: getChromeConnectorToolDefaultConsent(schema.name),
    cancelable: true,
  })),
  {
    id: "exaSearch",
    schema: exaSearchSchema,
    executor: exaSearchFunc,
    description: {
      name: "exa_search",
      description: "使用 Exa 神经网络搜索引擎获取高质量、结构化的网络信息（包含正文）。",
      category: "网络与智能",
    },
    behavior: "data",
  },
  {
    id: "firecrawlScrape",
    schema: firecrawlScrapeSchema,
    executor: firecrawlScrapeFunc,
    description: {
      name: "firecrawl_scrape",
      description:
        "使用 Firecrawl 抓取网页或 PDF 并返回 Markdown，适合反爬页面和 PDF 解析。",
      category: "网络与智能",
    },
    behavior: "data",
  },
  {
    id: "firecrawlSearch",
    schema: firecrawlSearchSchema,
    executor: firecrawlSearchFunc,
    description: {
      name: "firecrawl_search",
      description:
        "使用 Firecrawl 搜索互联网，并可返回每个结果的 Markdown 正文。",
      category: "网络与智能",
    },
    behavior: "data",
  },
  {
    id: "olmOcr",
    schema: olmOcrSchema,
    executor: olmOcrFunc,
    description: {
      name: "olm_ocr",
      description: "使用 olmOCR-2-7B-1025 进行图片文字识别，适合文档、论文等结构化文本的高质量识别。",
      category: "网络与智能",
    },
    behavior: "data",
  },
  {
    id: "whisperTurbo",
    schema: whisperTurboSchema,
    executor: whisperTurboFunc,
    description: {
      name: "whisper_turbo",
      description: "使用 whisper-large-v3-turbo 快速转录音频为文字，支持多语言，速度快价格低。",
      category: "音频与媒体",
    },
    behavior: "data",
  },
  {
    id: "whisperV3",
    schema: whisperV3Schema,
    executor: whisperV3Func,
    description: {
      name: "whisper_v3",
      description: "使用 whisper-large-v3 高精度转录音频，中文/多语言准确率更高，适合对质量要求严格的场景。",
      category: "音频与媒体",
    },
    behavior: "data",
  },

  // --- Cloudflare Browser Rendering ---

  {
    id: "cfScreenshot",
    schema: cfScreenshotFunctionSchema,
    executor: cfScreenshotFunc,
    description: {
      name: "cfScreenshot",
      description: "使用 Cloudflare Browser Rendering 对网页或 HTML 截图，支持全页截图和自定义视口。",
      category: "网络与智能",
    },
    behavior: "data",
    uiGroup: "general",
  },
  {
    id: "cfGetMarkdown",
    schema: cfGetMarkdownFunctionSchema,
    executor: cfGetMarkdownFunc,
    description: {
      name: "cfGetMarkdown",
      description: "使用 Cloudflare Browser Rendering 将网页转为 Markdown，支持 JS 渲染，速度快于多页爬取。",
      category: "网络与智能",
    },
    behavior: "data",
    uiGroup: "general",
  },
  {
    id: "cfGeneratePDF",
    schema: cfGeneratePDFFunctionSchema,
    executor: cfGeneratePDFFunc,
    description: {
      name: "cfGeneratePDF",
      description: "使用 Cloudflare Browser Rendering 将网页或 HTML 渲染为 PDF 文件，适合文档导出。",
      category: "文档生成",
    },
    behavior: "action",
    uiGroup: "general",
  },
  {
    id: "cfExtractJSON",
    schema: cfExtractJSONFunctionSchema,
    executor: cfExtractJSONFunc,
    description: {
      name: "cfExtractJSON",
      description: "使用 Cloudflare Browser Rendering + AI 从网页提取结构化 JSON 数据，用自然语言描述需要的字段。",
      category: "网络与智能",
    },
    behavior: "data",
    uiGroup: "general",
  },
  {
    id: "appPreflight",
    schema: appPreflightFunctionSchema,
    executor: appPreflightFunc,
    description: {
      name: "appPreflight",
      description: "在部署前检查应用结构、依赖、图标与常见构建问题。",
      category: "应用部署",
    },
    behavior: "data",
    uiGroup: "general",
  },
  {
    id: "appDeploy",
    schema: appDeployFunctionSchema,
    executor: appDeployFunc,
    description: {
      name: "appDeploy",
      description: "将 JavaScript/TypeScript 代码部署为平台托管的 Web 应用。",
      category: "应用部署",
    },
    behavior: "data",
    uiGroup: "general",
  },
  {
    id: "appList",
    schema: appListFunctionSchema,
    executor: appListFunc,
    description: {
      name: "appList",
      description: "列出当前用户已部署的所有应用，包括名称、appId 和访问 URL。",
      category: "应用部署",
    },
    behavior: "data",
    uiGroup: "general",
  },
  {
    id: "appDelete",
    schema: appDeleteFunctionSchema,
    executor: appDeleteFunc,
    description: {
      name: "appDelete",
      description: "删除一个已部署的应用，删除后 URL 立即失效。",
      category: "应用部署",
    },
    behavior: "data",
    uiGroup: "general",
  },
  {
    id: "appRead",
    schema: appReadFunctionSchema,
    executor: appReadFunc,
    description: {
      name: "appRead",
      description: "读取已部署应用的当前代码，修改应用前必须先调用此工具获取现有代码。",
      category: "应用部署",
    },
    behavior: "data",
    uiGroup: "general",
  },
  {
    id: "appFileList",
    schema: appFileListFunctionSchema,
    executor: appFileListFunc,
    description: {
      name: "appFileList",
      description: "列出 Nolo React SSR 应用源码工作区文件。",
      category: "应用部署",
    },
    behavior: "data",
    uiGroup: "general",
  },
  {
    id: "appFileRead",
    schema: appFileReadFunctionSchema,
    executor: appFileReadFunc,
    description: {
      name: "appFileRead",
      description: "读取 Nolo React SSR 应用源码工作区单个文件。",
      category: "应用部署",
    },
    behavior: "data",
    uiGroup: "general",
  },
  {
    id: "appFileWrite",
    schema: appFileWriteFunctionSchema,
    executor: appFileWriteFunc,
    description: {
      name: "appFileWrite",
      description: "写入 Nolo React SSR 应用源码工作区单个文件。",
      category: "应用部署",
    },
    behavior: "data",
    uiGroup: "general",
  },
  {
    id: "appFileSearch",
    schema: appFileSearchFunctionSchema,
    executor: appFileSearchFunc,
    description: {
      name: "appFileSearch",
      description: "搜索 Nolo React SSR 应用源码工作区文件片段。",
      category: "应用部署",
    },
    behavior: "data",
    uiGroup: "general",
  },
  {
    id: "appFileReplace",
    schema: appFileReplaceFunctionSchema,
    executor: appFileReplaceFunc,
    description: {
      name: "appFileReplace",
      description: "精确替换 Nolo React SSR 应用源码工作区单个文件片段。",
      category: "应用部署",
    },
    behavior: "data",
    uiGroup: "general",
  },
  {
    id: "cfSpeechToText",
    schema: cfSpeechToTextFunctionSchema,
    executor: cfSpeechToTextFunc,
    description: {
      name: "cfSpeechToText",
      description: "使用 Cloudflare Workers AI (@cf/openai/whisper) 将音频文件转换为文字，支持多语言自动识别。",
      category: "媒体处理",
    },
    behavior: "data",
    uiGroup: "general",
  },
  {
    id: "execShell",
    schema: execShellFunctionSchema,
    executor: execShellFunc,
    description: {
      name: "exec_shell",
      description:
        "通过后端 shell 执行接口运行跨平台命令：Windows 优先 PowerShell，Linux/macOS 使用 bash，仅用于本地开发调试。",
      category: "网络与智能",
    },
    behavior: "action",
  },
  {
    id: "checkEnv",
    schema: checkEnvFunctionSchema,
    executor: checkEnvFunc,
    description: {
      name: "checkEnv",
      description:
        "执行环境检查（当前默认并支持 build），用于代码变更后的快速生效前验证。",
      category: "网络与智能",
    },
    behavior: "action",
    uiGroup: "data",
  },

  // --- 多媒体生成 / 文档生成 ---

  {
    id: "geminiFlashLiteImage",
    schema: geminiFlashLiteImageFunctionSchema,
    executor: geminiFlashLiteImageFunc,
    description: {
      name: "geminiFlashLiteImage",
      description:
        "使用 Gemini 3.1 Flash Lite Image 模型（Nano Banana 2 Lite），根据文字说明和可选输入图片生成图像，速度最快、成本最低。",
      category: "多媒体生成",
    },
    behavior: "action",
    uiGroup: "media",
  },
  {
    id: "geminiFlashImage",
    schema: geminiFlashImageFunctionSchema,
    executor: geminiFlashImageFunc,
    description: {
      name: "geminiFlashImage",
      description:
        "使用 Gemini 2.5 Flash 模型，根据文字说明和可选输入图片生成图像，适合文生图和轻量编辑。",
      category: "多媒体生成",
    },
    behavior: "action",
    uiGroup: "media",
  },
  {
    id: "geminiProImagePreview",
    schema: geminiProImagePreviewFunctionSchema,
    executor: geminiProImagePreviewFunc,
    description: {
      name: "geminiProImagePreview",
      description:
        "使用 Gemini 3 Pro Image Preview 模型，基于一张或多张输入图片进行复杂编辑和多图合成。",
      category: "多媒体生成",
    },
    behavior: "action",
    uiGroup: "media",
  },
  {
    id: "openAIGptImageGenerate",
    schema: openAIGptImageGenerateFunctionSchema,
    executor: openAIGptImageGenerateFunc,
    description: {
      name: "openAIGptImageGenerate",
      description:
        "使用 OpenAI GPT Image 2 生成新图片，适合文本出图与基于参考图的单次新图生成。",
      category: "多媒体生成",
    },
    behavior: "action",
    uiGroup: "media",
  },
  {
    id: "openAIGptImageEdit",
    schema: openAIGptImageEditFunctionSchema,
    executor: openAIGptImageEditFunc,
    description: {
      name: "openAIGptImageEdit",
      description:
        "使用 OpenAI GPT Image 2 编辑现有图片，适合多图参考、局部修改与连续改图。",
      category: "多媒体生成",
    },
    behavior: "action",
    uiGroup: "media",
  },
  {
    id: "openAIGptImage",
    schema: openAIGptImageFunctionSchema,
    executor: openAIGptImageFunc,
    description: {
      name: "openAIGptImage",
      description:
        "使用 OpenAI GPT Image 1.5 生成或编辑图片，适合项目页素材、海报、插画和改图。",
      category: "多媒体生成",
    },
    behavior: "action",
    uiGroup: "media",
  },
  {
    id: "remotionRenderVideo",
    schema: remotionRenderVideoFunctionSchema,
    executor: remotionRenderVideoFunc,
    description: {
      name: "remotionRenderVideo",
      description:
          "使用平台内 Remotion 模板渲染手机传播视频或产品介绍视频，并保存为 MP4。",
      category: "多媒体生成",
    },
    behavior: "action",
    uiGroup: "media",
    capability: "general",
    riskLevel: "medium",
    costLevel: "medium",
    defaultConsent: "ask",
    cancelable: true,
  },
  {
    id: "generateDocx",
    schema: generateDocxFunctionSchema,
    executor: generateDocxFunc,
    description: {
      name: "generateDocx",
      description:
        "在浏览器端根据指定 DOCX 模板 URL 和变量生成文档，并触发下载。",
      category: "文档生成",
    },
    behavior: "action",
  },
];

// 汇总所有工具定义：基础工具 + Agent 分组 + 代码分组
const toolDefinitions: ToolDefinition[] = [
  ...baseToolDefinitions,
  ...agentToolDefinitions,
  ...codeToolDefinitions,
];

/* ==================================================================
 *  3.1 动态为 createAgent / updateAgent 的 tools 字段补 enum
 * ================================================================== */

// 所有函数工具的 schema.name 列表
const ALL_TOOL_FUNCTION_NAMES: string[] = toolDefinitions
  .map((tool) => tool.schema?.name)
  .filter((name): name is string => Boolean(name));

// Agent 可用的工具名：保留 ui_ask_choice，排除 toolquery 和默认开启的浏览器/搜索工具
const AGENT_AVAILABLE_TOOL_NAMES = ALL_TOOL_FUNCTION_NAMES.filter(
  (name) =>
    name !== "toolquery" &&
    !name.startsWith("browser_") &&
    name !== "exa_search"
);

// 给 createAgent / updateAgent 的 tools 参数 items 动态挂 enum
export const patchAgentToolSchemas = () => {
  try {
    const createAgentToolsProp =
      createAgentToolFunctionSchema?.parameters?.properties?.tools;
    if (createAgentToolsProp?.items && !(createAgentToolsProp.items as any).enum) {
      (createAgentToolsProp.items as any).enum = AGENT_AVAILABLE_TOOL_NAMES;
    }

    const updateAgentToolsProp =
      updateAgentToolFunctionSchema?.parameters?.properties?.tools;
    if (updateAgentToolsProp?.items && !(updateAgentToolsProp.items as any).enum) {
      (updateAgentToolsProp.items as any).enum = AGENT_AVAILABLE_TOOL_NAMES;
    }
  } catch {
    // 静默失败即可，不影响其他工具
  }
};

patchAgentToolSchemas();

/* ==================================================================
 *  4. 程序化生成所需的各个对象
 * ================================================================== */

export const toolRegistry: Record<string, any> = toolDefinitions.reduce(
  (acc, tool) => {
    acc[tool.schema.name] = { type: "function", function: tool.schema };
    return acc;
  },
  {} as Record<string, any>
);

export const toolExecutors: Record<string, ToolDefinition["executor"]> =
  toolDefinitions.reduce(
    (acc, tool) => {
      acc[tool.schema.name] = tool.executor;
      return acc;
    },
    {} as Record<string, ToolDefinition["executor"]>
  );

export const toolDescriptions: Record<string, ToolDefinition["description"]> =
  toolDefinitions.reduce(
    (acc, tool) => {
      acc[tool.schema.name] = tool.description;
      return acc;
    },
    {} as Record<string, ToolDefinition["description"]>
  );

export const toolDefinitionsByName: Record<string, ToolDefinition> =
  toolDefinitions.reduce(
    (acc, tool) => {
      acc[tool.schema.name] = tool;
      return acc;
    },
    {} as Record<string, ToolDefinition>
  );

/* ==================================================================
 *  5. 工具查找辅助函数
 * ================================================================== */
const normalizeToolName = (name: string): string =>
  name.replace(/[-_]/g, "").toLowerCase();

export const findToolExecutor = (
  rawName: string
): {
  executor: ToolDefinition["executor"];
  canonicalName: string;
} => {
  const normalizedRawName = normalizeToolName(canonicalizeToolName(rawName));
  const canonicalName = Object.keys(toolExecutors).find(
    (key) => normalizeToolName(key) === normalizedRawName
  );

  if (canonicalName && toolExecutors[canonicalName]) {
    return {
      executor: toolExecutors[canonicalName],
      canonicalName,
    };
  }
  throw new Error(`执行器未找到：未知工具 "${rawName}"`);
};
