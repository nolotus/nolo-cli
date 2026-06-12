import { createDoc } from "../../render/page/docSlice";
import { selectCurrentSpaceId } from "../../create/space/spaceSlice";
import type { RootState } from "../../app/store";
import {
  buildSkillDocFromArgs,
  type CreateSkillDocArgs,
} from "../skills/skillDocBuilder";
import { buildSkillFollowupResult } from "./skillFollowup";

export interface CreateSkillDocToolArgs extends CreateSkillDocArgs {
  spaceId?: string;
  categoryId?: string;
}

export const createSkillDocFunctionSchema = {
  name: "createSkillDoc",
  description: [
    "创建一个本地 skill 文档，并自动写入隐藏的 skill-config / eval-config 协议块。",
    "适合把某个能力流程沉淀成可被 agent 引用的 skill，而不是手写协议注释。",
    "创建成功后，如果用户还没说明下一步，优先调用 ui_ask_choice 继续询问：仅保存、挂到现有 Agent，还是新建一个 Agent 来使用它。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "可选：文档标题。未提供时回退到 name。",
      },
      name: {
        type: "string",
        description: "可选：skill 名称。未提供时回退到 title。",
      },
      description: {
        type: "string",
        description: "必填：skill 的用途说明。",
      },
      body: {
        type: "string",
        description: "可选：skill 的正文说明、步骤、注意事项等 Markdown 内容。",
      },
      spaceId: {
        type: "string",
        description: '可选：目标 spaceId；不传则优先使用当前 space。可传空字符串 ""。',
      },
      categoryId: {
        type: "string",
        description: '可选：目标分类 categoryId；不传时传空字符串 ""。',
      },
      toolNames: {
        type: "array",
        items: { type: "string" },
        description: "可选：该 skill 绑定的工具名列表。",
      },
      requiredSkills: {
        type: "array",
        items: { type: "string" },
        description: "可选：硬依赖的 skill key/page key 列表。",
      },
      recommendedSkills: {
        type: "array",
        items: { type: "string" },
        description: "可选：推荐但不强制的 skill key/page key 列表。",
      },
      promptPatch: {
        type: "string",
        description: "可选：附加到 system prompt 的技能提示。",
      },
      budgetTier: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "可选：该 skill 的预算等级。",
      },
      dispatchPreferred: {
        type: "boolean",
        description: "可选：是否建议优先走 agent dispatch 而不是直接本 agent 执行。",
      },
      modalities: {
        type: "array",
        items: { type: "string", enum: ["text", "image", "video", "audio", "3d"] },
        description: "可选：该 skill 涉及的模态。",
      },
      preferredAgents: {
        type: "array",
        items: { type: "string" },
        description: "可选：更适合执行该 skill 的 agent 名称或 key。",
      },
      discoverKeywords: {
        type: "array",
        items: { type: "string" },
        description: "可选：触发/发现关键字。",
      },
      discoverExamples: {
        type: "array",
        items: { type: "string" },
        description: "可选：示例任务或问法。",
      },
      evalCases: {
        type: "array",
        items: {
          type: "object",
          properties: {
            input: { type: "string" },
            expectedTools: {
              type: "array",
              items: { type: "string" },
            },
            expectedSignals: {
              type: "array",
              items: { type: "string" },
            },
            forbiddenSignals: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["input"],
        },
        description: "可选：skill 的评估用例，写入 eval-config。",
      },
    },
    required: ["description"],
  } as const,
};

export async function createSkillDocFunc(
  args: CreateSkillDocToolArgs,
  thunkApi: any
): Promise<{ rawData: unknown; displayData: string }> {
  const { dispatch, getState } = thunkApi;
  const state = getState() as RootState;
  const { title, content, skillConfig, evalConfig } = buildSkillDocFromArgs(args);

  const explicitSpaceId = (args.spaceId ?? "").trim() || undefined;
  const currentSpaceId = selectCurrentSpaceId(state) || undefined;
  const spaceId = explicitSpaceId ?? currentSpaceId;
  const categoryId = (args.categoryId ?? "").trim() || undefined;

  const id = await (dispatch as any)(
    (createDoc as any)({
      title,
      spaceId,
      categoryId,
      content,
    })
  ).unwrap();

  return buildSkillFollowupResult({
    dbKey: id,
    title,
    skillId: skillConfig.id,
    spaceId: spaceId ?? null,
    toolNames: skillConfig.toolNames ?? [],
    hasEvalConfig: !!evalConfig,
  });
}
