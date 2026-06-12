import { APP_BUILDER_PRESET } from "../ai/tools/agent/presets/appBuilderPreset";
import { FIREWORKS_KIMI_LATEST_MODEL } from "../ai/llm/kimi";

export const BUILTIN_NOLO_AGENT_KEY = "agent-pub-01NOLOAPPBLD000000019KCKT0";
export const BUILTIN_APP_BUILDER_AGENT_KEY =
  "agent-pub-01APPBUILDER00000001YAII3I";
export const BUILTIN_ECOMMERCE_AGENT_KEY =
  "agent-pub-01ECOMMERCEAG00000001PYQ2J";
export const BUILTIN_AGENT_CREATOR_AGENT_KEY =
  "agent-pub-01NOLOAGENTCRT000000000001";
export const BUILTIN_NOLO_AGENT_ID = "01NOLOAPPBLD000000019KCKT0";
export const BUILTIN_APP_BUILDER_AGENT_ID = "01APPBUILDER00000001YAII3I";
export const BUILTIN_ECOMMERCE_AGENT_ID = "01ECOMMERCEAG00000001PYQ2J";
export const BUILTIN_AGENT_CREATOR_AGENT_ID = "01NOLOAGENTCRT000000000001";

const BUILTIN_PUBLIC_RUNTIME_SERVER_BASE = "https://nolo.chat";

const buildBuiltinBaseAgent = (overrides: Record<string, unknown>) => {
  const timestamp = Date.now();
  return {
    type: "agent",
    isPublic: true,
    userId: "builtin",
    createdAt: timestamp,
    updatedAt: timestamp,
    references: [],
    ...overrides,
  };
};

const BUILTIN_NOLO_PROMPT = [
  "你是 nolo，负责帮助刚进入产品的用户理解现在能做什么，并把他们带到合适的下一步。",
  "优先直接回答、解释入口、帮用户开始对话、创建 AI、创建文档，或把任务交给更合适的 agent。",
  "用户只是泛泛提问时，先收敛问题，不要立刻切换到重型流程。",
  `当用户明确要创建、定制或发布 AI / Agent / 智能体时，调用 runStreamingAgent 转交给 AI 创建助手，agentKey 是 ${BUILTIN_AGENT_CREATOR_AGENT_KEY}。`,
  "不要自己调用 prepareAgentDraft 或 createAgent；AI 创建助手负责草稿预览、用户确认和最终创建。",
  "不要调用 deleteSpaces 这类高风险能力。",
].join("\n");

export const BUILTIN_AGENT_CREATOR_PROMPT = [
  "你是 Nolo 的 AI 创建助手，只负责通过对话帮助用户创建或调整一个新的 Agent。",
  "先理解用户想让这个 AI 服务谁、完成什么任务、使用什么语气、需要哪些能力、是否需要知识引用，以及是否适合公开。",
  "当信息足够形成初版配置时，先调用 prepareAgentDraft，生成可预览草稿；信息不足时每次只问一个关键问题。",
  "prepareAgentDraft 只生成草稿，不代表已经创建真实 Agent。",
  "草稿展示后，等待用户明确确认，例如“确认创建”“就按这个创建”“创建这个 AI”。",
  "只有得到明确确认后，才调用 createAgent 创建真实 Agent。",
  "用户只是讨论、补充、修改或说“先看看”时，不要调用 createAgent。",
  "默认模型使用 provider=fireworks, model=accounts/fireworks/models/kimi-latest；除非用户明确要求且平台已知支持，不要选择 Claude/Anthropic 等当前 runtime 不支持的 provider。",
  "公开状态保持保守：你可以建议公开，但只有用户明确要求公开发布时，createAgent 的 isPublic 才能为 true。",
  "如果用户想手动微调模型、工具、知识引用或发布状态，可以引导用户进入 /create/agent 高级编辑页。",
].join("\n");

export const buildBuiltinNoloRecord = () =>
  buildBuiltinBaseAgent({
    dbKey: BUILTIN_NOLO_AGENT_KEY,
    id: BUILTIN_NOLO_AGENT_ID,
    name: "nolo",
    introduction:
      "专门用来引导用户理解 Nolo 能做什么，并把问题带到正确入口或更合适的 Agent。",
    greeting:
      "你好，我是 nolo。你可以直接说你想做什么，我会帮你开始、解释入口，或把任务交给更合适的能力。",
    provider: "fireworks",
    model: FIREWORKS_KIMI_LATEST_MODEL,
    useServerProxy: true,
    apiSource: "platform",
    runtimeServerBase: BUILTIN_PUBLIC_RUNTIME_SERVER_BASE,
    inputPrice: 0.95 * 8,
    outputPrice: 4 * 8,
    hasVision: true,
    tags: ["nolo", "引导", "分发"],
    tools: ["fetchWebpage", "runStreamingAgent"],
    prompt: BUILTIN_NOLO_PROMPT,
  });

export const buildBuiltinAppBuilderRecord = () =>
  buildBuiltinBaseAgent({
    ...APP_BUILDER_PRESET,
    dbKey: BUILTIN_APP_BUILDER_AGENT_KEY,
    id: BUILTIN_APP_BUILDER_AGENT_ID,
    runtimeServerBase: BUILTIN_PUBLIC_RUNTIME_SERVER_BASE,
    tags: ["应用构建", "App Builder", "无代码"],
  });

export const buildBuiltinEcommerceAgentRecord = () =>
  buildBuiltinBaseAgent({
    dbKey: BUILTIN_ECOMMERCE_AGENT_KEY,
    id: BUILTIN_ECOMMERCE_AGENT_ID,
    name: "电商商品参数助手",
    introduction:
      "专门获取淘宝、天猫、京东等电商商品真实参数、SKU、价格、库存和店铺信息，并做结构化对比。",
    greeting: "发给我淘宝、天猫或京东商品链接，我会尽量获取真实商品参数。",
    provider: "fireworks",
    model: FIREWORKS_KIMI_LATEST_MODEL,
    useServerProxy: true,
    apiSource: "platform",
    runtimeServerBase: BUILTIN_PUBLIC_RUNTIME_SERVER_BASE,
    inputPrice: 0.95 * 8,
    outputPrice: 4 * 8,
    hasVision: false,
    tags: ["电商", "商品参数", "数据抓取"],
    tools: ["taobaoTmallProductScraper", "jdProductScraper"],
    prompt: [
      "你是电商商品参数助手，只负责获取和整理电商商品真实数据。",
      "当用户给淘宝/天猫链接或商品 ID 时，先提取数字 itemId，再调用 taobaoTmallProductScraper。",
      "当用户给京东链接或 SKU 时，先提取数字 skuId，再调用 jdProductScraper。",
      "输出要结构化：商品标题、品牌、型号、店铺、价格、SKU/规格、库存、尺寸重量、质保、数据来源和缺失项。",
      "用户问参数或详情时，必须展开工具返回的详细参数，不要只摘要基础字段。",
      "只输出用户请求的数据结果；不要输出寒暄、确认、过渡句或结尾追问。",
      "如果用户给多个商品，逐个调用对应工具后再做对比表。",
      "如果工具返回缺失字段，如实说明缺失；不要编造参数，也不要要求用户手抄页面。",
    ].join("\n"),
  });

export const buildBuiltinAgentCreatorRecord = () =>
  buildBuiltinBaseAgent({
    dbKey: BUILTIN_AGENT_CREATOR_AGENT_KEY,
    id: BUILTIN_AGENT_CREATOR_AGENT_ID,
    name: "AI 创建助手",
    introduction:
      "通过对话帮你整理专属 AI 的用途、能力、Prompt、知识引用和发布建议，并在确认后创建。",
    greeting:
      "告诉我你想创建一个什么样的 AI：它要帮谁、完成什么、需要哪些能力或资料？",
    provider: "fireworks",
    model: "accounts/fireworks/models/kimi-latest",
    useServerProxy: true,
    apiSource: "platform",
    runtimeServerBase: BUILTIN_PUBLIC_RUNTIME_SERVER_BASE,
    inputPrice: 0.95 * 8,
    outputPrice: 4 * 8,
    hasVision: false,
    tags: ["AI 创建", "Agent 创建", "配置助手"],
    tools: ["prepareAgentDraft", "createAgent"],
    prompt: BUILTIN_AGENT_CREATOR_PROMPT,
  });

export const normalizeBuiltinPublicAgentRecord = <T extends Record<string, any>>(
  agent: T,
): T => {
  if (!agent || typeof agent !== "object") return agent;
  const key = typeof agent.dbKey === "string" ? agent.dbKey : "";
  const id = typeof agent.id === "string" ? agent.id : "";
  const isBuiltinCreator =
    key === BUILTIN_AGENT_CREATOR_AGENT_KEY || id === BUILTIN_AGENT_CREATOR_AGENT_ID;

  if (!isBuiltinCreator) return agent;

  const builtin = buildBuiltinAgentCreatorRecord();
  return {
    ...agent,
    name: builtin.name,
    introduction: builtin.introduction,
    greeting: builtin.greeting,
    provider: builtin.provider,
    model: builtin.model,
    useServerProxy: builtin.useServerProxy,
    apiSource: builtin.apiSource,
    runtimeServerBase: builtin.runtimeServerBase,
    inputPrice: builtin.inputPrice,
    outputPrice: builtin.outputPrice,
    hasVision: builtin.hasVision,
    references: builtin.references,
    tags: builtin.tags,
    tools: builtin.tools,
    prompt: builtin.prompt,
  };
};

export const BUILTIN_PLATFORM_AGENT_KEYS = [
  BUILTIN_NOLO_AGENT_KEY,
  BUILTIN_APP_BUILDER_AGENT_KEY,
  BUILTIN_ECOMMERCE_AGENT_KEY,
  BUILTIN_AGENT_CREATOR_AGENT_KEY,
] as const;

const BUILTIN_PLATFORM_AGENT_KEY_SET = new Set<string>(BUILTIN_PLATFORM_AGENT_KEYS);

export const isBuiltinPlatformAgentRecord = (agent: {
  dbKey?: string | null;
  id?: string | null;
}): boolean => {
  const dbKey = typeof agent?.dbKey === "string" ? agent.dbKey : "";
  if (dbKey && BUILTIN_PLATFORM_AGENT_KEY_SET.has(dbKey)) return true;

  const id = typeof agent?.id === "string" ? agent.id : "";
  if (!id) return false;

  return BUILTIN_PLATFORM_AGENT_KEYS.some((key) => key.endsWith(id));
};

export const shouldHideBuiltinAgentFromPublicPlaza = (agent: {
  dbKey?: string | null;
  id?: string | null;
}): boolean => isBuiltinPlatformAgentRecord(agent);

export const buildBuiltinPlatformAgentRecord = (dbKey: string) => {
  if (dbKey === BUILTIN_NOLO_AGENT_KEY) {
    return buildBuiltinNoloRecord();
  }
  if (dbKey === BUILTIN_APP_BUILDER_AGENT_KEY) {
    return buildBuiltinAppBuilderRecord();
  }
  if (dbKey === BUILTIN_ECOMMERCE_AGENT_KEY) {
    return buildBuiltinEcommerceAgentRecord();
  }
  if (dbKey === BUILTIN_AGENT_CREATOR_AGENT_KEY) {
    return buildBuiltinAgentCreatorRecord();
  }
  return null;
};
