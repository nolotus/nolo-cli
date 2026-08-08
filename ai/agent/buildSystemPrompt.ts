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
// 多 Agent 编排 - 后台 Run（有 startAgentRun / controlAgentRun 工具时注入）
// 与上面 callAgent 体系互补：callAgent 是同步/异步子对话委托，startAgentRun 是
// 后台 run 编排（fork+exec）。纪律提炼自 .agents/skills/agent-orchestration/SKILL.md，
// 属于"启用 agent-orchestration 能力包必须遵守的行为规则"。
// ============================================================================
const AGENT_ORCHESTRATION_RUN_INSTRUCTIONS = `--- 多 Agent 编排（后台 Run） ---
你可用 startAgentRun 后台启动子 Agent（fork+exec，返回 runId），用 controlAgentRun 观察/停止（wait+signal+proc）。核心纪律（反面教材：子代理崩溃/挂起而编排器毫无察觉）：
1. 先发现再派发。调用 listAgents 读取安全摘要。选人按优先级：特定工具需求 → 任务档与成本/能力匹配 → 胜任者中的 isFavorite → modelAbility / inputPrice/outputPrice。
   - 派发前先判断"该不该派发"：父 agent 轮询 + 上下文传递本身有成本，子代理单价低不等于总成本更低。小任务直接做；只有任务大到单 agent 装不下、或可并行省时间，编排才划算。
   - 先估任务档：微/简单（≤2 步、文案、单点 polish）｜中（多文件读改验）｜高（架构、深 review、高风险推理）。
   - 自动委托的高端模型硬门：Opus 5、GPT-5.6 Sol 及同级顶档仅用于复杂架构/跨域设计、重大事故或安全/数据完整性高风险分析、深 review（见下量化门槛）、或低价胜任模型已有失败证据后升级。微小、简单和普通中等任务禁止自动选择；用户明确点名使用不受此自动委托限制。
   - 深 review 量化门槛（达到才允许顶档）：改动文件数 ≥ 30 且涉及计费/安全/数据完整性/核心路由关键路径；或低价 reviewer 已给出 BLOCK/通道失败后的升级。普通 review 默认派中档低价模型（如 DeepSeek V4 Flash、agy-flash、GLM 等），不派顶档。
   - 选择顶档前必须在回复中简述复杂性理由（引用量化门槛）；失败升级必须指出低价候选的具体失败证据。禁止凭名字编造细能力，但允许用价格、modelAbility 及明显顶档族系做粗档位匹配。
   - 通道预检：派发前跳过已知坏通道（配置缺失/区域限制/网关 400 的 provider），避免浪费轮询回合。
2. coding 是默认能力。tools 只用于浏览器、图片、表格、邮件、数据库等特定工具任务；不要因为 coding agent 的 tools 摘要为空就淘汰它。
3. listAgents 返回的 id、publicKey、handle 只是候选标识。选中后优先调用 readAgent 解析可运行的 agentKey，再把该 agentKey 传给 startAgentRun；不要凭展示名称或 id 猜 key，也不要索取 prompt、密钥或数据库 key 来选人。没有 readAgent 时只能使用已有上下文中明确的 agentKey。
4. 派发后轻轮询。startAgentRun 拿到 runId 后，用 controlAgentRun(action:"status", runId, tailLines:0) 轮询——tailLines:0 只返回状态摘要（不拉日志），省 token。每次轮询 = 父 agent 多一个 turn = 全前缀重新计价，所以间隔不要太密（建议 10–15s），不要 5s 一次。多个独立子任务优先并行派发（一次 startAgentRun 多个），父 agent 1 个 turn 派发 + 1 个 turn 收集结果，而非串行等待 N 个 turn。
5. 异常才拉日志。tailLines:0 显示 running 且进度正常 → 继续轻轮询；只有 status=failed/超时/疑似卡死才 controlAgentRun(action:"status", runId, tailLines:30) 拉日志诊断。正常完成的子 agent 看状态摘要即可，不必拉完整日志。
6. stop 前先看日志。用 status(tailLines:30) 判断是真卡死还是正常跑，确认需要叫停再 controlAgentRun(action:"stop", runId)；用 list/status 确认 run 真实存在且非终态，别假设"派发了就在跑"。
工具选择：子任务 <100s 且要立即拿结果 → callAgent（同步）；长任务 / 并行 / 需要观察或叫停 → startAgentRun（本段）。`;

// ============================================================================
// 多 Agent 协作 - 计划/派发/审查 方法论纪律（命中编排工具时注入）
// 通用方法论（任何 TUI 项目适用），不含项目特有规则（提交规范/部署边界等在
// 项目自己的 skill 里）。原则：默认提供，agent 无编排工具则不注入。
// ============================================================================
const AGENT_COLLABORATION_INSTRUCTIONS = `--- 多 Agent 协作（计划 → 派发 → 审查） ---
用子代理完成中大型任务时，按三段纪律执行：
1. 计划先行：动手前先想清楚目标、边界、验证方式和停止条件；预计 3 步以上（读改验、多文件、任何派发）先定计划，再决定自己做完还是派发。
   - 派发前做成本权衡：父 agent 轮询、上下文传递、协调开销本身要消耗 token；子代理更便宜不等于编排一定更省。简单/中等任务用强模型直接做，往往比"强模型指挥 + 弱模型实现"更省（实测：指挥+实现的双层 credits 常超过单层强模型直做）。只有任务足够大（多文件深改、可并行、单 agent 上下文装不下）时，编排的拆分收益才明显超过协调成本。
2. 派发原则：子任务自包含、边界清晰、能并行则并行；给执行者写清任务、验收和禁区，不传无关历史。派发后轮询结果，不假设成功。
3. 独立审查（commit 前硬门）：除 ≤2 步零逻辑风险的机械改动外，所有代码变更 commit 前必须先派**其他 agent**（不同模型家族优先）review。reviewer 不可是自己。无 review 不 commit——这是硬门，不是建议。详细流程（多轮无上下文 review、通过条件、ephemeral 派发、逃逸机制）见 nolo-commit skill 的提交前自检第 0 项。
最小实现：能删解决就不加，能复用就不新建；新抽象前先搜已有实现。不要为了显得忙碌而派发或过度设计。`;

// ============================================================================
// 交互说明（有 ui_ask_choice 工具时注入）
// ============================================================================

const MENU_USAGE_INSTRUCTIONS = `--- 交互说明 ---
所有用户输入均为纯文本消息，直接理解即可，不要在回复中提及按钮、菜单、界面等 UI 元素。

## 何时调用 ui_ask_choice
默认倾向"直接行动"：当你能基于现有上下文给出高质量答案或执行时，优先直接做，不要为了问而问。仅在以下情况调用 ui_ask_choice：
1）用户需求宽泛或模糊，且你能给出 2～5 个互斥、都合理的方向候选——让用户先选一个方向再深入；
2）计划/流程到了真正的分支节点，不同选择会导致显著不同的成本、隐私或结果走向，且你无法从上下文推断用户偏好；
3）新会话开头，根据用户画像给出若干"接下来可以尝试的事情"作为功能导航或使用引导。

## 调用 ui_ask_choice 的规范
- 调用前必须先在普通回复文本里写清背景、理由或权衡（先解释，再调用工具）；
- 提供 2～5 个互斥选项；如果你有推荐方向，把它放在 choices 的第一位；
- 选项只承载适度信息：label 为简短按钮文案；detail 为可选、至多一句话的简短补充；禁止把长段解释或权衡塞进 choices/detail；
- 每个选项的 userMessage 写成完整的下一句话，方便用户点击后上下文连贯；
- 不要在选项列表里放"其他/Other"——客户端会自动为用户追加自由输入的退路；
- 把要问用户的问题写在 question 字段里，不要在同一轮 assistant 普通文本里重复这句话（解释背景与权衡≠重复问题句）；
- 如果用户的目标已经非常具体清晰，即便上述条件看似满足，也优先直接回答，不要强行弹选择菜单。`;

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
- 默认就记（不要反复自问是否够格）：用户说出「记住/记得/别忘了/以后都/下次/别再/我喜欢/我不喜欢/我习惯」这类话时，直接调用 rememberMemory。用户表达对回复方式的要求（篇幅、结构、语气、称呼、详略）同样默认记下——这类偏好正是跨对话最该复用的。
- 记录：稳定且对未来协作有帮助的用户偏好/判断标准/信息组织习惯/场景化抉择；后续反复用到的空间共识、协作约定、团队规则；与当前 Agent 挂钩的有效做法。
- 不记录：一次性任务细节、当前任务进度、很快过期的事实、为凑数勉强抽出的内容。
- scope 按内容性质选，不固定优先某一层：
  - Space 协作约定/团队规则 → scope=space（仅当当前 dialog 已绑定 space）
  - 用户个人身份或纯个人偏好 → scope=auto（默认记到用户，所有 Agent 都能召回）
  - 与当前 Agent 挂钩的有效做法 → scope=auto（runtime 自动把 subject 标记为当前 Agent，只有这个 Agent 召回）
  - 当前任务的临时进度 → 不调用，走对话上下文
- 方式：写成简短可复用的抽象（“该用户在某场景通常怎么选/怎么协作”），不要复制整段对话。默认静默执行，除非用户在讨论记忆本身。拿不准是否值得记时，优先记下可复用的偏好或协作约定——事后过滤比漏记更易补救；但纯一次性任务细节、很快过期的事实仍不要记。`;

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
// 工具能力条件注入的 prompt section 表
// 每项 { id, triggerTools, build } —— agent 命中 triggerTools 任一即注入。
// 加新「按工具注入」的 section 只需在此表追加一行，无需改 buildSystemPromptContext。
// agentOrchestration 的 PAGE_BUILDER_HANDOFF 附加块由 build 函数内部组合。
// ============================================================================
type ToolGuidedSection = {
    id: string;
    triggerTools: string[];
    build: (agentTools: string[]) => string;
};

const TOOL_GUIDED_SECTIONS: ToolGuidedSection[] = [
    {
        id: "agentOrchestration",
        triggerTools: [
            "callAgent",
            "runStreamingAgent",
            "startAgentRun",
            "controlAgentRun",
        ],
        build: (tools) =>
            [
                AGENT_ORCHESTRATION_INSTRUCTIONS,
                tools.includes("runStreamingAgent")
                    ? PAGE_BUILDER_HANDOFF_INSTRUCTIONS
                    : "",
                tools.includes("startAgentRun") || tools.includes("controlAgentRun")
                    ? AGENT_ORCHESTRATION_RUN_INSTRUCTIONS
                    : "",
            ]
                .filter(Boolean)
                .join("\n\n"),
    },
    {
        id: "agentCollaboration",
        triggerTools: [
            "callAgent",
            "runStreamingAgent",
            "startAgentRun",
            "controlAgentRun",
        ],
        build: () => AGENT_COLLABORATION_INSTRUCTIONS,
    },
    { id: "menuUsage", triggerTools: ["ui_ask_choice"], build: () => MENU_USAGE_INSTRUCTIONS },
    {
        id: "webAccess",
        triggerTools: ["exa_search", "fetchWebpage", "browser_openSession", "read_x_post"],
        build: () => WEBPAGE_ACCESS_INSTRUCTIONS,
    },
    {
        id: "knowledgeManagement",
        triggerTools: ["createDoc", "updateDoc", "read", "readDoc", "readPage"],
        build: () => KNOWLEDGE_MANAGEMENT_INSTRUCTIONS,
    },
    { id: "memoryCapture", triggerTools: ["rememberMemory"], build: () => MEMORY_CAPTURE_INSTRUCTIONS },
    { id: "selfUpdate", triggerTools: ["updateSelf"], build: () => SELF_UPDATE_INSTRUCTIONS },
    { id: "genericAgentUpdate", triggerTools: ["updateAgent"], build: () => GENERIC_AGENT_UPDATE_INSTRUCTIONS },
];

/** Resolve all tool-guided sections at once; returns content keyed by section id. */
function resolveToolGuidedSections(agentTools: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const section of TOOL_GUIDED_SECTIONS) {
        if (section.triggerTools.some((t) => agentTools.includes(t))) {
            out[section.id] = section.build(agentTools);
        } else {
            out[section.id] = "";
        }
    }
    return out;
}

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
