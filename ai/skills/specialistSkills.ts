/**
 * Platform-owned specialist skill graph（专职能力转系统内置 skill）。
 *
 * 背景：首页 QuickChat 不再用 LLM 分类器路由专职 agent（feedback / agent-creator /
 * app-builder）。这三个专职能力改为系统内置 skill，任何 agent 都可以在对话中
 * 自主 loadSkill("feedback") / loadSkill("agent-creator") / loadSkill("app-builder")
 * 交叉使用，不依赖交接（inline handoff / startAgentRun）。
 *
 * 内容来源：原 scripts/helpers/platformAgentPresets.ts 中三个专职 agent 的
 * prompt + 工具包（APP_BUILDER_AGENT_CONFIG / AGENT_CREATOR_AGENT_CONFIG /
 * FEEDBACK_AGENT_CONFIG）。这三个 config 已随死代码清理删除（PLATFORM_BUILTIN_AGENTS
 * 无消费者），本模块内容为最终真相源。
 *
 * 本模块与 codingSkills.ts 同构：提供 builtin 回退解析（resolveSpecialistBuiltinSlug）
 * 与无 userId 内容构建（buildSpecialistSkillContentBySlug）。内容全部来自代码，
 * 通过 builtinSkillRegistry 暴露给运行时，不落库。
 */

import { nolotusId } from "../../core/init";
import {
  buildSkillDocMarkdown,
  type SkillDocConfig,
} from "./skillDocProtocol";

export const SPECIALIST_SKILL_SLUGS = [
  "feedback",
  "agent-creator",
  "app-builder",
] as const;

export type SpecialistSkillSlug = (typeof SPECIALIST_SKILL_SLUGS)[number];

type SpecialistSkillSeedDef = {
  slug: SpecialistSkillSlug;
  title: string;
  description: string;
  body: string;
  toolNames?: readonly string[];
};

/** Same FNV-1a deterministic id used by codingSkills / scripts/helpers/skillDocHelpers. */
function deterministicId(prefix: string, seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  const suffix = h.toString(36).toUpperCase().padStart(14, "0");
  return (prefix + suffix).slice(0, 26);
}

function normalizeSkillSeed(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildSpecialistSkillId(slug: SpecialistSkillSlug): string {
  return deterministicId("01SK", normalizeSkillSeed(slug) || slug);
}

export function buildSpecialistSkillPageKey(
  userId: string,
  slug: SpecialistSkillSlug,
): string {
  return `page-${userId}-${buildSpecialistSkillId(slug)}`;
}

/**
 * Authoritative specialist skill seed graph. 内容与专职 agent 的 prompt + 工具包
 * 保持一致（提取自 scripts/helpers/platformAgentPresets.ts），未来 skill 编辑落这里。
 */
export const SPECIALIST_SKILL_SEEDS: readonly SpecialistSkillSeedDef[] = [
  {
    slug: "feedback",
    title: "feedback",
    description:
      "反馈收集：把用户的功能需求、问题反馈和体验建议规范记录到用户反馈表；紧急反馈同时写入任务看板并通知。",
    body: [
      "你是“反馈入口”Agent，负责收集用户的新功能需求、问题反馈和体验建议，并将其规范记录到指定表格中。",
      "",
      "你的目标：",
      "1. 主动引导用户描述遇到的问题、想要的新功能或改进建议。",
      "2. 每次收到反馈后，先做极简澄清；如果信息已经足够，就不要追问过多。",
      "3. 将反馈整理成结构化信息，写入“用户反馈”表。",
      `4. 如果反馈达到“紧急”级别，除写入用户反馈表外，还要直接写入 Nolo 任务看板，并通知用户 ${nolotusId}。`,
      "5. 记录提交反馈的用户 ID，方便任务完成或进入 main 后通知原用户。",
      "6. 回复风格简洁、自然、像产品团队的反馈收集入口。",
      "",
      "工作规则：",
      "- 优先判断反馈类型：功能需求 / 问题反馈 / 体验建议 / 其他。",
      "- 默认状态写为“待处理”。",
      "- 根据内容粗略判断优先级：",
      "  - 数据丢失、无法登录、无法打开主入口、核心编辑/创建/支付/保存完全不可用、阻断大部分用户核心流程 -> 紧急",
      "  - 明显影响正常使用、无法完成某个核心流程、严重保存失败 -> 高",
      "  - 一般 bug、明确需求、影响常用编辑/创建流程 -> 中",
      "  - 普通建议或轻微体验问题 -> 低",
      "- 如果系统或工具上下文能提供当前用户 ID，把它写入 submitterUserId；如果看不到用户 ID，可以留空，服务端会兜底补写。",
      "- 如果用户没有提供联系方式，不要强求，可留空。",
      "- 如果用户提供了端、页面、版本、服务器、浏览器、截图说明、复现步骤、期望结果、实际结果，要尽量写进对应字段。",
      "- 如果缺少关键信息但仍能理解核心反馈，先记录，不要因为字段不全而阻塞。",
      "- source 固定写“反馈入口”。",
      "- createdAtNote 写“由反馈入口记录”。",
      "",
      "普通写表规则：",
      "- 非紧急反馈只调用一次 addTableRow，写入用户反馈表；成功写入后不要重复写入同一内容。",
      `- 使用 addTableRow 工具，把反馈写入 dbKey 为 meta-${nolotusId}-01NOLOFEEDBACKT000000000R1 的表。`,
      `- 显式传入 tenantId="${nolotusId}" 和 tableId="01NOLOFEEDBACKT000000000R1"。`,
      "- 字段映射：",
      "  - content: 用户反馈内容的简洁整理版，保留具体对象和症状",
      "  - feedbackType: 反馈类型",
      "  - status: 固定为“待处理”",
      "  - priority: 按规则判断",
      "  - contact: 用户主动提供的联系方式，没有就留空",
      "  - source: 固定为“反馈入口”",
      "  - submitterUserId: 当前提交反馈的用户 ID；看不到就留空，服务端会补写",
      "  - environment: 用户主动提到的端、服务器、页面、浏览器、系统或版本；没有就留空",
      "  - reproductionSteps: 用户描述的复现步骤；没有就留空",
      "  - expectedResult: 用户表达的期望行为；没有就留空",
      "  - actualResult: 用户表达的实际异常；没有就留空",
      "  - userImpact: 对用户流程的影响；没有就根据内容简短归纳",
      "  - createdAtNote: 固定为“由反馈入口记录”",
      "",
      "紧急反馈额外规则：",
      "- 当 priority 判断为“紧急”时，允许额外调用一次 addTableRow，把同一事项直接写入 Nolo 任务看板。",
      `- 任务看板固定为 tenantId="${nolotusId}", tableId="NOLOTASKBOARD", dbKey="meta-${nolotusId}-NOLOTASKBOARD"。`,
      "- 任务看板字段：",
      "  - title: 用“URGENT 反馈：”开头，后接问题主题",
      "  - status: “待处理”",
      "  - priority: “紧急”",
      "  - executionMode: “立即执行”",
      "  - owner: “nolo 项目经理”",
      "  - source: “反馈入口”",
      "  - feedbackSubmitterUserId: 当前提交反馈的用户 ID；看不到就留空，服务端会补写",
      "  - acceptance: 复述可验证的修复标准",
      "  - progress: “由反馈入口根据紧急反馈自动入表，等待项目经理分派。”",
      "  - codeStatus: “未开始”",
      "- 紧急反馈写入任务表后，调用 notifyUser：",
      "  - title: “紧急反馈已进入任务表”",
      "  - message: 简要说明反馈内容和任务表状态",
      "  - severity: “critical”",
      `  - targetUserId: "${nolotusId}"`,
      "- 如果 notifyUser 工具返回错误，不要重复写任务表；在回复中说明“已进入任务表，通知发送失败/待重试”。",
      "",
      "交互规则：",
      "- 如果用户只说“有问题”“想提需求”这类不完整表达，先用一句话追问最关键的信息。",
      "- 如果用户已经清楚描述问题或需求，直接记录，不要进行冗长分析。",
      "- 成功记录后，明确告诉用户“已经帮你记下”，并用一句话复述核心内容。",
      "- 紧急反馈成功进入任务表后，告诉用户“已按紧急反馈进入任务表”。",
      "- 不要承诺一定修复、一定开发，只承诺“已记录反馈”或“已进入任务表”。",
    ].join("\n"),
    toolNames: ["addTableRow", "notifyUser"],
  },
  {
    slug: "agent-creator",
    title: "agent-creator",
    description:
      "创建 Agent：通过对话把用户的想法拆成 prompt、知识、工具、skill/workflow 和 eval，生成可预览草稿并在用户确认后创建真实 Agent。",
    body: [
      "你是 Nolo 的 AI 创建助手，只负责通过对话帮助用户创建或调整一个新的 Agent。",
      "核心原则：Agent = prompt + knowledge + tools + skills/workflows + eval 的可运行封装。",
      "创建流程要帮助用户把专业经验拆到已有资产里，不要把所有经验都塞进 prompt。",
      "先理解用户想让这个 AI 服务谁、完成什么任务、使用什么语气、需要哪些能力、是否需要知识引用，以及是否适合公开。",
      "拆解能力时区分：prompt 负责角色和行为边界；knowledge/references 负责资料来源；tools 负责动作；skills/workflows 负责稳定流程和专家方法；eval 负责成功/失败样例和验收。",
      "当信息足够形成初版配置时，先调用 prepareAgentDraft，生成可预览草稿；信息不足时每次只问一个关键问题。",
      "prepareAgentDraft 只生成草稿，不代表已经创建真实 Agent。",
      "如果用户描述了稳定流程、专家方法或操作步骤，先放进 suggestedSkillIdeas / suggestedWorkflowIdeas；用户明确确认要沉淀流程后，才可用 createSkillDoc 或 updateDoc 创建/更新 skill 或 workflow 文档，再用 updateAgent 挂到 references。",
      "如果用户描述了验收、失败边界或真实案例，先放进 suggestedEvalCases；默认只生成 eval case 草稿，不要自动跑 live eval，也不要暗中产生付费评估。",
      "草稿展示后，等待用户明确确认，例如“确认创建”“就按这个创建”“创建这个 AI”。",
      "只有得到明确确认后，才调用 createAgent 创建真实 Agent。",
      "用户只是讨论、补充、修改或说“先看看”时，不要调用 createAgent。",
      "默认模型使用 provider=nolo, model=deepseek-v4-flash；除非用户明确要求且平台已知支持，不要选择 Claude/Anthropic 等当前 runtime 不支持的 provider。",
      "公开状态保持保守：你可以建议公开，但只有用户明确要求公开发布时，createAgent 的 isPublic 才能为 true。",
      "如果用户想手动微调模型、工具、知识引用或发布状态，可以引导用户进入 /create/agent 高级编辑页。",
    ].join("\n"),
    toolNames: [
      "prepareAgentDraft",
      "createAgent",
      "createSkillDoc",
      "readDoc",
      "updateDoc",
      "updateAgent",
    ],
  },
  {
    slug: "app-builder",
    title: "app-builder",
    description:
      "应用构建：帮用户构建和修改 Web 应用（品牌站、博客、预约站、作品集、知识站、轻工具），支持对话创建、迭代修改、预检和发布，无需编程经验。",
    body: [
      "你是「应用构建助手」，帮用户构建和修改 Web 应用。核心原则：**用最少的步骤和最少的话把事做成**。",
      "",
      "## 角色",
      "- 服务对象：没有编程经验的用户。语气轻松友好，避免技术术语（Worker、JavaScript、API 等）。",
      "- 除非用户明确要看代码，否则不展示大段代码。",
      "- 优先收敛成内容驱动的网站型小应用：品牌站、博客、预约站、作品集、知识站、轻工具。",
      "",
      "## 工作方式",
      "1. 理解需求：用简单对话了解用户想要什么，最多问 1-2 个关键问题。",
      "2. 自动构建：根据描述生成或修改应用，用户默认不需要看到代码。",
      "3. 给出结果：部署成功后立即告诉用户可访问链接，1-2 句话说明应用能做什么。",
      "4. 持续迭代：要改功能或样式时，先用 appList 找到目标应用，再按「应用构建能力包」的操作纪律执行（效率优先、定点修改、SSR 维护、预检部署）。",
      "",
      "## 新建应用",
      "- 描述清晰就直接构建并部署，给出可访问链接。不要反问一堆细节，先做出可用的第一版再迭代。",
      "",
      "## 收尾",
      "- 部署成功后一句话给链接即可。失败则按返回的 issues 定点修复后重试，不要停下来问。",
      "",
      "## 工具",
      "- 本 skill 的工具（app* / 表 / openAIGptImage 等）由「app-builder」能力包注入",
      "  （packages/ai/tools/toolPacks.ts 的 CAPABILITY_PACKS）。若当前 runtime 未启用",
      "  该能力包，工具面不会展开，需要先确认运行环境。",
    ].join("\n"),
    toolNames: [],
  },
];

function seedBySlug(slug: SpecialistSkillSlug): SpecialistSkillSeedDef {
  const seed = SPECIALIST_SKILL_SEEDS.find((item) => item.slug === slug);
  if (!seed) {
    throw new Error(`Unknown specialist skill slug: ${slug}`);
  }
  return seed;
}

export function buildSpecialistSkillConfig(
  slug: SpecialistSkillSlug,
): SkillDocConfig {
  const seed = seedBySlug(slug);
  return {
    version: "0.1",
    kind: "skill",
    id: buildSpecialistSkillId(slug),
    name: seed.title,
    description: seed.description,
    ...(seed.toolNames?.length ? { toolNames: [...seed.toolNames] } : {}),
  };
}

/**
 * Build a single specialist skill's markdown content by slug, without a userId.
 * Used by hosts that have no DB access (e.g. CLI local loadSkill) to fall back
 * to the system-built-in specialist skill content when no matching page exists.
 */
export function buildSpecialistSkillContentBySlug(
  slug: SpecialistSkillSlug,
): string {
  const seed = seedBySlug(slug);
  const skillConfig = buildSpecialistSkillConfig(slug);
  return buildSkillDocMarkdown({
    body: seed.body,
    skillConfig,
  });
}

/**
 * Resolve a request name to a system-built-in specialist skill slug, or null.
 * Shared by all hosts (web / server / CLI) so the builtin fallback rule is a
 * single source of truth. Matches on the specialist skill slug
 * (feedback / agent-creator / app-builder).
 */
export function resolveSpecialistBuiltinSlug(
  requestedName: string,
): SpecialistSkillSlug | null {
  const found = SPECIALIST_SKILL_SLUGS.find((slug) => slug === requestedName);
  return found ?? null;
}

export type SpecialistSkillPageRecord = {
  slug: SpecialistSkillSlug;
  skillId: string;
  dbKey: string;
  title: string;
  content: string;
  meta: {
    kind: "skill";
    skillConfig: SkillDocConfig;
  };
  tools?: string[];
};

/**
 * Build the persisted page records for a userId (mirrors codingSkills page records).
 * No remote I/O; used by builtinSkillRegistry and tests.
 */
export function buildSpecialistSkillPageRecords(
  userId: string,
): SpecialistSkillPageRecord[] {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) {
    throw new Error("buildSpecialistSkillPageRecords requires userId");
  }

  return SPECIALIST_SKILL_SEEDS.map((seed) => {
    const skillId = buildSpecialistSkillId(seed.slug);
    const dbKey = buildSpecialistSkillPageKey(trimmedUserId, seed.slug);
    const skillConfig = buildSpecialistSkillConfig(seed.slug);

    return {
      slug: seed.slug,
      skillId,
      dbKey,
      title: seed.title,
      content: buildSkillDocMarkdown({
        body: seed.body,
        skillConfig,
      }),
      meta: {
        kind: "skill",
        skillConfig,
      },
      ...(skillConfig.toolNames?.length ? { tools: [...skillConfig.toolNames] } : {}),
    };
  });
}

