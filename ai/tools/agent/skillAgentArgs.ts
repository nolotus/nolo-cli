import type { CreateAgentToolArgs } from "./createAgentTool";

export type SkillAgentMode = "creator" | "evaluator" | "creator_evaluator";

export interface CreateSkillAgentToolArgs {
  mode?: SkillAgentMode;
  name?: string;
  model?: string;
  provider?: string;
  isPublic?: boolean;
  references?: CreateAgentToolArgs["references"];
  linkedSpaces?: string[];
}

const DEFAULT_PROVIDER = "openrouter";
const DEFAULT_MODEL = "xiaomi/mimo-v2.5-pro";

const buildPreset = (mode: SkillAgentMode) => {
  const commonTools = [
    "createSkillDoc",
    "importSkill",
    "doctorSkill",
    "evalSkill",
    "readDoc",
    "updateDoc",
  ];

  if (mode === "creator") {
    return {
      defaultName: "Skill Creator",
      tools: commonTools,
      introduction: "帮你设计、创建和完善 skill 文档协议的助手。",
      greeting:
        "你好，我是 Skill Creator。\n\n告诉我你想做什么能力，我会帮你把它整理成可导入、可诊断、可评估的 skill 文档。",
      prompt: `你是一个 skill creator。你的任务是把用户的能力需求沉淀成 skill 文档，而不是泛泛给建议。

核心原则：
- Agent 是第一公民；只有切换 Agent 成本更高时，才优先补 skill
- skill 以普通 doc 为存储底座，使用隐藏的 skill-config / eval-config 协议块
- 优先用 createSkillDoc 创建；已有文档则用 updateDoc 定点补齐协议
- 创建后立刻运行 doctorSkill；必要时再运行 evalSkill
- 默认做最小可用协议，不要过早发明复杂 DSL
- 对外部技能导入，优先保留文本流程，再谨慎映射工具`,
    };
  }

  if (mode === "evaluator") {
    return {
      defaultName: "Skill Evaluator",
      tools: [...commonTools, "runLlm"],
      introduction: "帮你诊断 skill 文档质量、协议完整性与评估结果的助手。",
      greeting:
        "你好，我是 Skill Evaluator。\n\n把一个 skill 文档给我，我会检查协议、工具绑定、评估用例和潜在风险。",
      prompt: `你是一个 skill evaluator。你的任务是审查 skill 是否真的可用，而不是替用户写新功能。

工作顺序：
1. 先 doctorSkill 看协议和明显问题
2. 再 evalSkill 看 eval-config 是否通过
3. 如发现问题，指出最小修复点
4. 除非用户要求，不主动大改 skill

审查重点：
- 工具名是否有效、是否需要 canonicalize
- requiredSkills / recommendedSkills 是否表达准确
- eval-config 是否覆盖关键成功路径
- 是否存在过期命令、环境前提、登录态依赖等隐患`,
    };
  }

  return {
    defaultName: "Skill Builder",
    tools: [...commonTools, "runLlm", "createAgent", "updateAgent"],
    introduction: "既能创建也能评估 skill 文档协议，还能帮助你沉淀 skill 工作流助手。",
    greeting:
      "你好，我是 Skill Builder。\n\n我可以帮你把能力做成 skill、导入外部 skill、诊断质量、补评估，并继续迭代相关 agent。",
    prompt: `你是一个 skill creator + evaluator。

原则：
- 先判断该问题是否更适合换 Agent；只有没必要切 Agent 或切 Agent 成本更高时，才补 skill
- skill 负责动态能力编排；knowledge 负责内容；dispatch 负责任务分派
- 创建或更新 skill 后，必须至少做一次 doctorSkill；如果有 eval-config，再跑 evalSkill
- 不把 recommendedSkills 当硬加载；requiredSkills 才是硬依赖
- 尽量帮助用户形成“创建 -> 诊断 -> 评估 -> 迭代”的闭环`,
  };
};

export const buildCreateSkillAgentArgs = (
  args: CreateSkillAgentToolArgs
): CreateAgentToolArgs => {
  const mode = args.mode ?? "creator_evaluator";
  const preset = buildPreset(mode);
  return {
    name: (args.name ?? "").trim() || preset.defaultName,
    model: (args.model ?? "").trim() || DEFAULT_MODEL,
    provider: (args.provider ?? "").trim() || DEFAULT_PROVIDER,
    introduction: preset.introduction,
    greeting: preset.greeting,
    prompt: preset.prompt,
    isPublic: args.isPublic ?? false,
    tools: preset.tools,
    references: args.references ?? [],
    linkedSpaces: args.linkedSpaces ?? [],
    temperature: 0.3,
    reasoning_effort: "medium",
  };
};
