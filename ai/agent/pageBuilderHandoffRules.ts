export const PAGE_BUILDER_AGENT_PUBLIC_KEY =
  "agent-pub-01PAGEBUILDR00000000FT7R9G";

export type PageBuilderScenario = {
  id: string;
  label: string;
  userIntent: string;
  prompt: string;
};

export const PAGE_BUILDER_SCENARIOS: PageBuilderScenario[] = [
  {
    id: "information-display",
    label: "信息展示",
    userIntent: "主页、产品介绍、服务介绍、作品集、活动页、报价页",
    prompt:
      "帮我做一个独立 AI 产品顾问的个人主页。要看起来专业，包含个人定位、能提供的服务卡片、代表成果卡片、可信背书和联系合作按钮。",
  },
  {
    id: "data-analysis",
    label: "数据分析",
    userIntent: "日报、周报、经营看板、质检报告、销售漏斗、反馈分析",
    prompt:
      "帮我做一个 AI 客服质检日报，包含核心指标、近 7 天风险趋势、异常会话明细表，以及明天需要跟进的建议。",
  },
  {
    id: "process-guide",
    label: "流程说明",
    userIntent: "教程、SOP、onboarding、操作指南、课程步骤、申请流程",
    prompt:
      "帮我做一个新员工使用 CRM 的交互教程页面，包含学习目标、操作步骤、示例练习、检查清单和下一步按钮。",
  },
  {
    id: "decision-comparison",
    label: "决策比较",
    userIntent: "方案对比、产品选型、候选人对比、竞品分析、采购建议",
    prompt:
      "帮我做一个三款 CRM 方案对比页，包含对比维度表格、每个方案的优缺点卡片、评分、适合团队类型和最终推荐。",
  },
  {
    id: "plan-roadmap",
    label: "计划排布",
    userIntent: "项目计划、学习计划、健身计划、内容日历、发布节奏",
    prompt:
      "帮我做一个 30 天内容发布计划页面，包含阶段目标、每周任务、优先级、里程碑卡片和风险提醒。",
  },
  {
    id: "mixed-pitch",
    label: "混合长尾",
    userIntent: "汇报页、融资材料、复杂项目概览，混合展示、数据、计划、对比",
    prompt:
      "给一个早期 AI 客服创业项目做一页融资汇报页，包含市场机会、关键数据指标卡、增长趋势图、产品路线、竞品对比表、团队介绍和下一步计划。",
  },
];

const scenarioLines = PAGE_BUILDER_SCENARIOS.map(
  (scenario) => `- ${scenario.label}：${scenario.userIntent}`
).join("\n");

export const PAGE_BUILDER_HANDOFF_INSTRUCTIONS = `--- 页面生成助手 handoff ---
当用户需要把内容变成“可看的页面/报告/看板/教程/对比页/计划页”时，可以把本轮交给页面生成助手。

目标 Agent:
- agentKey: ${PAGE_BUILDER_AGENT_PUBLIC_KEY}
- 推荐工具: runStreamingAgent

适合 handoff 的视觉意图大类：
${scenarioLines}

调用边界：
- 用户明确要求“做成页面 / 看板 / 报告 / 教程 / 主页 / 对比页 / 计划表 / 可视化”时，可以直接 runStreamingAgent。
- 如果用户只是讨论内容，但你判断“文字回答不如可视化页面”，先询问用户：“这个更适合做成一页可视化页面，要我生成一个可交互版本吗？”
- 不要把普通问答、闲聊、代码解释、纯文本总结强行交给页面生成助手。
- handoff 时，把用户原始需求和你已确认的业务上下文一起放进 userInput，不要要求用户理解 React、HTML、代码块或运行时。
- 页面生成助手只负责生成和修改可交互页面；你仍负责判断、解释、澄清和后续协调。`;
