/**
 * Builtin object assistant skill definitions (doc + table + code).
 *
 * These skill pages are referenced by the builtin object assistant agents
 * instead of carrying tool lists directly on the agent record.
 */

import type { ReferenceItem } from "../../app/types";
import { DataType } from "../../create/types";
import { createKey } from "../../database/keys";
import { buildSkillDocMarkdown, type SkillDocConfig } from "./skillDocProtocol";

export const BUILTIN_OBJECT_SKILL_IDS = {
  table: "builtin-table-skill-v1",
  doc: "builtin-doc-skill-v1",
  code: "builtin-code-skill-v1",
  image: "builtin-image-skill-v1",
  file: "builtin-file-skill-v1",
  pagebuilder: "builtin-pagebuilder-skill-v1",
} as const;

export type BuiltinObjectSkillKind = "doc" | "table" | "code" | "image" | "file" | "pagebuilder";

/** 每个 skill 的差异化定义；公共字段（version/kind/triggerMode）由 builder 补齐。 */
type SkillDef = {
  id: string;
  name: string;
  description: string;
  toolNames: string[];
  promptPatch: string;
  keywords: string[];
};

const SKILL_DEFS: Record<BuiltinObjectSkillKind, SkillDef> = {
  doc: {
    id: BUILTIN_OBJECT_SKILL_IDS.doc,
    name: "文档编辑技能",
    description: "提供文档读取与更新能力，供文档助手使用。",
    toolNames: ["readDoc", "updateDoc"],
    promptPatch: [
      "文档编辑指南：",
      "1. 修改前先 readDoc 读取当前文档真值，再基于现有内容用 updateDoc 做定点增量编辑。",
      "2. 不要脱离现有内容空想重写；润色/改写/续写都应保留用户原有的结构与事实。",
    ].join("\n"),
    keywords: ["文档", "润色", "改写", "续写", "排版", "文章", "document", "polish"],
  },
  table: {
    id: BUILTIN_OBJECT_SKILL_IDS.table,
    name: "表格编辑技能",
    description: "提供表格创建、查询、新增、更新与删除能力，供表格助手使用。",
    toolNames: [
      "createTable",
      "addTableRow",
      "addTableRows",
      "queryTableRows",
      "updateTableRow",
      "deleteTableRow",
    ],
    promptPatch: [
      "表格操作指南：",
      "1. 用户要新建表格时，调用 createTable，并从需求推断合理的字段设计（字段名、类型、必填、可选值）。",
      "2. 新增记录必须调用 addTableRow / addTableRows，不要只在回答里口头描述。",
      "3. addTableRow 的 values 是对象，key 必须用字段名（name，不是显示名 label）；尽量从用户自然语言推断并填满相关字段，必填字段尤其注意；用户没提到的字段可用空字符串或 null 占位；绝不要传空对象 {}。",
      "4. 更新或删除前，先用 queryTableRows 确认目标行，必要时向用户确认目标行/字段。",
    ].join("\n"),
    keywords: ["表格", "建表", "新增一行", "记录", "字段", "table", "spreadsheet", "csv"],
  },
  code: {
    id: BUILTIN_OBJECT_SKILL_IDS.code,
    name: "编码风格技能",
    description: "提供编码规范与风格约束，供代码任务使用。",
    toolNames: [],
    promptPatch: [
      "编码风格与规范指南：",
      "1. 文件拆分：优先拆分为多文件（MANY SMALL FILES），典型长度 200-400 行，单文件最多 800 行（800 max）。",
      "2. 函数与嵌套：函数保持短小（<50 lines），优先使用 early returns 提前返回，嵌套层级不超过 4 层（nesting ≤4）。",
      "3. 不可变性（immutability）：保持数据不可变，不要原地 mutate 现有对象或数组，必须返回新对象/数组。",
      "4. 错误处理与校验：显式处理所有错误（explicit error handling），在系统边界完成校验（validate at boundaries），不隐式吞错。",
      "5. 完成前 Checklist：完成前自查函数/文件尺寸、嵌套深度、不可变性与边界错误处理。",
    ].join("\n"),
    keywords: ["代码", "编码", "重构", "修bug", "code", "refactor", "bugfix", "coding-style"],
  },
  image: {
    id: BUILTIN_OBJECT_SKILL_IDS.image,
    name: "图片分析技能",
    description: "提供图片理解、描述与整理建议能力，供图片助手使用。",
    toolNames: [],
    promptPatch: [
      "图片分析指南：",
      "1. 当前阶段重点围绕当前图片做理解、描述、提炼重点、给出命名/整理建议和后续处理建议。",
      "2. 不要假装已经具备复杂图片编辑能力；如果用户要更强操作，明确说明当前可做的是分析与组织。",
    ].join("\n"),
    keywords: ["图片", "图像", "分析", "描述", "命名", "整理", "image", "photo", "picture"],
  },
  file: {
    id: BUILTIN_OBJECT_SKILL_IDS.file,
    name: "文件处理技能",
    description: "提供文件理解、整理与处理建议能力，供文件助手使用。",
    toolNames: [],
    promptPatch: [
      "文件处理指南：",
      "1. 当前阶段重点围绕当前文件提供理解、整理、提取与后续处理建议。",
      "2. 不要假装已经完成文件内容解析；必要时明确告诉用户当前更多是占位型工作流入口，等待后续接入更完整的文件处理能力。",
    ].join("\n"),
    keywords: ["文件", "解析", "提取", "整理", "处理", "file", "document", "pdf"],
  },
  pagebuilder: {
    id: BUILTIN_OBJECT_SKILL_IDS.pagebuilder,
    name: "动态交互组件生成技能",
    description:
      "把一句话需求变成可看的交互页面、报告、看板、主页、教程、对比页或计划页。任何 agent 在需要输出可交互可视化消息时按需加载。",
    toolNames: [],
    promptPatch: [
      "动态交互组件生成规则：",
      "你现在的任务是把用户需求变成一个可看的交互页面/报告/看板/主页/教程/对比页/计划页。用户看不到源码，只会看到页面结果。",
      "",
      "绝对规则：",
      "1. 只输出一个 Markdown 代码块，代码块语言必须是 tsx preview。",
      "2. 代码块外不要输出解释、前言、结尾、清单或思考过程。",
      "3. 代码必须定义顶层 function Example()，不要调用 render()，不要 export default。",
      "4. 不要写 import。运行环境已经提供 React、useState、useEffect、useMemo、useCallback、useRef、ReactECharts、react-icons/lu 的图标组件。",
      "5. 所有交互必须在 Example 内用 React state 实现，按钮、Tab、FAQ、步骤切换、筛选都要真的可点击。",
      "6. 为主要区块加 data-artifact-section 属性。",
      "7. 生成结果优先是一页完整可用的页面，不要只做孤立卡片或一个图。",
      "8. 如果用户没有给具体数据，可以生成合理的示例数据，但要保持业务可信。",
      "",
      "各类页面默认结构：",
      "- 信息展示类（主页、产品介绍、服务页、作品集、活动页）：首屏定位、服务/能力卡片、代表成果卡片、可信背书、联系或行动按钮。",
      "- 数据分析类（日报、周报、看板、质检、销售漏斗、反馈分析）：顶部摘要、核心指标、趋势图、明细表格或异常列表、下一步建议。",
      "- 流程说明类（教程、SOP、onboarding、操作指南、课程步骤）：学习目标、步骤卡片、示例/练习、检查清单或下一步按钮。",
      "- 决策比较类（方案对比、产品选型、竞品分析、采购建议）：对比维度表格、优缺点卡片、评分或适配度、推荐结论。",
      "- 计划排布类（项目计划、学习计划、内容日历、发布节奏）：阶段目标、任务列表、优先级、里程碑卡片、风险提醒。",
      "- 混合汇报类（融资页、项目概览、复杂汇报）：至少包含 MetricCard、Chart、Table 和 Section，不要只做单一列表。",
      "- 教程/步骤/FAQ/Tab/筛选/页面内跳转必须做成真实可点击交互。",
      "",
      "代码风格：",
      "1. 使用内联 style 或组件内 <style>，不要依赖 Tailwind 或外部 CSS。",
      "2. 页面宽度、间距、字号要适合消息内预览；不要用过大的落地页 hero。",
      "3. 颜色要克制，有层次；避免整页单一蓝紫渐变。",
      "4. 表格、图表、卡片、按钮都要有 hover/active/focus 的细节。",
      "5. 必要时使用 ReactECharts 画图；简单柱状图也可以用 div 实现，保证稳定。",
      "6. 代码尽量短而完整，默认 150-260 行以内。",
      "",
      "输出格式示例：",
      "```tsx preview",
      "function Example() {",
      "  const [tab, setTab] = useState('overview');",
      "  return <main><section data-artifact-section>...</section></main>;",
      "}",
      "```",
    ].join("\n"),
    keywords: [
      "页面", "报表", "看板", "日报", "周报", "主页", "教程", "对比页", "计划页",
      "可视化", "交互页面", "仪表盘", "dashboard", "report", "page", "landing",
    ],
  },
};

function buildSkillConfig(kind: BuiltinObjectSkillKind): SkillDocConfig {
  const def = SKILL_DEFS[kind];
  return {
    version: "0.1",
    kind: "skill",
    id: def.id,
    name: def.name,
    description: def.description,
    triggerMode: "explicit",
    toolNames: def.toolNames,
    promptPatch: def.promptPatch,
    discover: { keywords: def.keywords },
  };
}

export function buildBuiltinObjectSkillDbKey(
  kind: BuiltinObjectSkillKind,
  userId: string,
): string {
  return createKey(DataType.DOC, userId, BUILTIN_OBJECT_SKILL_IDS[kind]);
}

export function buildBuiltinObjectSkillReference(
  kind: BuiltinObjectSkillKind,
  userId: string,
): ReferenceItem {
  return {
    dbKey: buildBuiltinObjectSkillDbKey(kind, userId),
    title: SKILL_DEFS[kind].name,
    type: "instruction",
  };
}

/** 生成内置 skill page 的 content（含 skill-config 协议块），供落库与测试共用。 */
export function buildBuiltinObjectSkillPageContent(
  kind: BuiltinObjectSkillKind,
): string {
  const def = SKILL_DEFS[kind];
  return buildSkillDocMarkdown({
    body: `# ${def.name}\n\n${def.description}`,
    skillConfig: buildSkillConfig(kind),
  });
}

/**
 * Ensure builtin object skill pages exist for the given userId.
 * Returns a thunk suitable for dispatch.
 */
export function ensureBuiltinObjectSkills(
  userId: string,
): (dispatch: any) => Promise<void> {
  return async (dispatch: any) => {
    const { readAndWait, write } = await import("../../database/dbSlice");

    const now = Date.now();
    const skills = (Object.keys(SKILL_DEFS) as BuiltinObjectSkillKind[]).map(
      (kind) => ({
        kind,
        dbKey: buildBuiltinObjectSkillDbKey(kind, userId),
        title: SKILL_DEFS[kind].name,
        content: buildBuiltinObjectSkillPageContent(kind),
      }),
    );

    for (const skill of skills) {
      try {
        const existing = await dispatch(readAndWait(skill.dbKey))
          .unwrap()
          .catch(() => null);
        if (!existing) {
          await dispatch(
            write({
              data: {
                id: BUILTIN_OBJECT_SKILL_IDS[skill.kind],
                dbKey: skill.dbKey,
                type: DataType.DOC,
                userId,
                title: skill.title,
                content: skill.content,
                created: new Date(now).toISOString(),
                createdAt: now,
                updatedAt: String(now),
              },
              customKey: skill.dbKey,
            }),
          ).unwrap();
        }
      } catch {
        // best-effort; caller handles errors
      }
    }
  };
}
