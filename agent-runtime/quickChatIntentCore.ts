// quick-chat 意图分类的纯逻辑（web / CLI 共享的单一真相源）。
// 无 redux / app 层依赖：prompt 构建、输出解析、短问候快速通道、复杂度兜底。
// web 的 redux 版 classifyQuickChatIntent 与 CLI 的 autoModelRouter
// 都基于这里的纯函数实现自己的调用通道。

/** 分类器使用的小模型（平台代理）。 */
export const INTENT_MODEL = "deepseek-v4-flash";
export const INTENT_PROVIDER = "deepseek";

/** 分类器 LLM 调用超时（ms），超时后走 fallback。 */
export const QUICK_CHAT_INTENT_TIMEOUT_MS = 4000;

/** 短问候/闲聊的最大字符数。超过则走 LLM 分类。 */
const SHORT_GREETING_MAX_LENGTH = 20;

/**
 * 明显是问候/闲聊/致谢/告别的短文本。
 * 严格 `^...$` 锚定：必须是「整条」消息都是这一类词，
 * 避免吃掉「hi, 帮我做个网站」这类仍需 LLM 分类的请求。
 */
const SHORT_GREETING_PATTERN =
  /^(?:hi|hello|hey|hiya|yo|sup|howdy|嗨|哈喽|哈囉|你好|您好|在吗|在嘛|喂|早上好|中午好|下午好|晚上好|拜拜|再见|谢谢|thanks|thx|ok|好的|收到|了解)[!.。，、~～]?$/iu;

export interface TierAgentOption {
  tier: string;
  agentKey: string;
  description: string;
}

export interface QuickChatIntentResult {
  agentKey: string;
  /** LLM 分类是否成功；false 表示走了 fallback */
  classified: boolean;
  /**
   * 本轮用户消息是否表达「文件/代码/工作区」意图。
   * 为 true 时，调用方应给 quick-chat 通用档注入只读工作区工具。
   * 解析失败/超时走 fallback 时恒为 false（由 regex 兜底再判一次）。
   */
  needsWorkspace: boolean;
  /**
   * 分类器自评的置信度(0-1)。仅供诊断展示/阈值判断参考，
   * 缺失或格式不对时不影响 agentKey 的判定(不会因此走 fallback)。
   */
  confidence?: number;
  /**
   * 本轮消息命中了哪些对象操作技能（"table"=建表/表格数据处理，"doc"=文档写改）。
   * 调用方可据此给对话挂载对应内置 skill 引用；未命中时为 undefined。
   */
  skills?: Array<"table" | "doc">;
}

/**
 * 判断是否为「明显是问候/闲聊」的短文本。
 * 命中后分类器会跳过 LLM 直接返回 flash 档。
 */
export function isShortGreeting(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > SHORT_GREETING_MAX_LENGTH) return false;
  return SHORT_GREETING_PATTERN.test(trimmed);
}

const COMPLEXITY_SIMPLE_MAX_LENGTH = 80;
const COMPLEXITY_MEDIUM_MAX_LENGTH = 500;
const COMPLEXITY_KEYWORDS = /为什么|如何|分析|对比|比较|设计|架构|实现|原理|推导|评价|区别|关系|影响|优化|重构/;
const COMPLEXITY_CODE_BLOCK = /```[\s\S]*```/;

/**
 * 客户端复杂度启发式判定（LLM 分类失败时的兜底）。
 * 分为三档：simple / medium / complex。
 */
export function estimateComplexity(text: string): "simple" | "medium" | "complex" {
  const trimmed = text.trim();
  const len = trimmed.length;

  if (len > COMPLEXITY_MEDIUM_MAX_LENGTH) return "complex";
  if (COMPLEXITY_CODE_BLOCK.test(trimmed)) return "complex";

  if (len > COMPLEXITY_SIMPLE_MAX_LENGTH) return "medium";
  if (COMPLEXITY_KEYWORDS.test(trimmed)) return "medium";

  return "simple";
}

/** 各档位的中文描述，注入分类器 system prompt。 */
export const TIER_DESCRIPTIONS: Record<string, string> = {
  flash: "快速简单：问候、闲聊、快速问答、翻译、短文",
  balanced: "平衡推理：分析、中等长度写作、代码、推理",
  quality: "高质量深度：复杂推理、长文、架构设计、深度分析",
};

/**
 * 构建意图分类器 system prompt（导出供测试断言规则与 route keys）。
 */
export function buildQuickChatIntentSystemPrompt(tierAgents: TierAgentOption[]): string {
  const agentList = tierAgents
    .map((t) => `  - "${t.agentKey}"：${t.description}`)
    .join("\n");
  return `你是一个意图路由器。根据用户消息，判断应该交给哪个 agent 处理。

可选 agent 列表（agentKey 与描述）：
${agentList}

判断原则（默认偏向通用档位；专职 agent 在明确匹配时使用；**编码/本地仓库任务走通用档 + needsWorkspace=true**）：
- 默认情况下，**除非用户明确表达要建应用/建 Agent/提交反馈/多 Agent 编排**，否则选通用档位（flash/balanced/quality）：
  - 简单问候、闲聊、快速问答、翻译、短文 → 选 flash 档
  - 需要推理、分析、中等长度写作、普通代码解释/架构问答 → 选 balanced 档
  - 复杂推理、长文、架构设计、深度分析 → 选 quality 档
  - **明确编码任务（实现功能、修 bug、refactor、写/补测试、跑 build/tests/ci）或查看本机仓库/代码状态（git/分支/commit/本地与远程差距/未提交改动等）** → 选 balanced 或 quality 档（按复杂度；**不要选 flash**），且 needsWorkspace=true
- 专职 agent 路由规则（有明确匹配时使用）：
  - 要提交/记录 bug、体验问题、数据异常、产品建议，或口语如「想反馈一些问题」「反馈一下」→ 选意见反馈专职 agent
  - 要新建或定制 AI/Agent/智能体助手（含配置工具、知识、确认创建）→ 选创建 Agent 专职 agent
  - 要做/改/发布网站、网页、小应用、预约页、博客、看板 → 选应用构建专职 agent
  - 要派多个 agent、多 agent 并行、拆成任务后台执行、多个 agent review、让不同 agent 讨论/会商 → 选多 Agent 编排专职 agent（显式 multi-agent 优先）
- **拿不准时**：纯闲聊选 flash；**若沾边本地仓库/当前代码状态，选 balanced/quality + needsWorkspace=true**。

同时判断本轮是否需要注入「工作区只读工具」（listFiles/globFiles/searchFiles/readFile/execShell 等）：
- needsWorkspace=true 的场景：用户要读/改/分析文件或代码、提到了文件路径/扩展名（.md/.csv/.ts 等）、提到工作区/代码库/仓库/目录/git/分支、要看当前代码或仓库状态、本地搜索/查看代码。
- needsWorkspace=false 的场景：通用知识问答（如「广东经济数据」「写一首诗」）、纯闲聊问候、翻译、不涉及本地文件/仓库。
- 漏判（用户要文件而没带工具）比误判（白搜几轮）代价更高，宁可偏宽判 true。

在给出 agentKey 之前，先在心里区分候选档位的边界再给置信度：balanced 与 quality 的边界在于复杂度/篇幅/是否需要深度分析，拿不准就给低 confidence。

同时判断本轮消息是否需要挂载对象操作技能（skills 数组，未命中给 []）：
- 用户要新建/整理/录入/批量处理表格数据（建表、加行、改列、按条件整理数据）→ skills 含 "table"
- 用户要写/润色/改写/续写/排版一篇文档或文章 → skills 含 "doc"
- 普通问答/闲聊/代码任务/建应用 → skills 为 []

只输出 JSON，不要输出其他内容：
{"confidence": <0到1之间的小数，表示你对这个分类判断的把握程度>, "agentKey": "<从列表中选择的 agentKey>", "needsWorkspace": <true 或 false>, "skills": <字符串数组，元素只能是 "table" 或 "doc"，未命中给 []>}`;
}

/**
 * 解析 LLM 输出。agentKey 必须在 tierAgents 列表中才算解析成功。
 * confidence 只是诊断用的补充信息:缺失或格式不对时不影响 agentKey 的判定,
 * 直接当作未提供(undefined),不应该因为这一个字段拖累整体分类结果。
 */
export function parseQuickChatIntentResult(
  content: string,
  tierAgents: TierAgentOption[],
): {
  agentKey: string;
  needsWorkspace: boolean;
  confidence?: number;
  skills?: Array<"table" | "doc">;
} | null {
  try {
    const parsed = JSON.parse(content.trim()) as unknown;
    if (typeof parsed !== "object" || parsed === null || !("agentKey" in parsed)) return null;
    const key = (parsed as { agentKey?: unknown }).agentKey;
    if (typeof key !== "string") return null;
    if (!tierAgents.some((t) => t.agentKey === key)) return null;
    const rawNeedsWorkspace = (parsed as { needsWorkspace?: unknown }).needsWorkspace;
    // 解析 needsWorkspace；非布尔时默认 false（regex 兜底会再判一次）。
    const needsWorkspace = rawNeedsWorkspace === true;
    const rawConfidence = (parsed as { confidence?: unknown }).confidence;
    const confidence =
      typeof rawConfidence === "number" &&
      Number.isFinite(rawConfidence) &&
      rawConfidence >= 0 &&
      rawConfidence <= 1
        ? rawConfidence
        : undefined;
    // 解析 skills：只保留 "table"/"doc"，非法值与重复值过滤掉；空数组视为未命中。
    const rawSkills = (parsed as { skills?: unknown }).skills;
    let skills: Array<"table" | "doc"> | undefined;
    if (Array.isArray(rawSkills)) {
      const filtered = [...new Set(rawSkills)].filter(
        (s): s is "table" | "doc" => s === "table" || s === "doc",
      );
      if (filtered.length > 0) skills = filtered;
    }
    return { agentKey: key, needsWorkspace, confidence, skills };
  } catch {
    return null;
  }
}
