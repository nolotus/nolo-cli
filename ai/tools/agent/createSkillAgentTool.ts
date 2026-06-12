import { createAgentToolFunc } from "./createAgentTool";
import {
  buildCreateSkillAgentArgs,
  type CreateSkillAgentToolArgs,
} from "./skillAgentArgs";

export const createSkillAgentToolFunctionSchema = {
  name: "createSkillAgent",
  description:
    "创建一个专门用于创建/评估 skill 文档协议的 Agent，支持 creator、evaluator 或二合一模式。",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["creator", "evaluator", "creator_evaluator"],
        description: "要创建的 skill agent 类型。",
      },
      name: {
        type: "string",
        description: "可选：Agent 名称。",
      },
      model: {
        type: "string",
        description: "可选：覆盖默认模型。",
      },
      provider: {
        type: "string",
        description: "可选：覆盖默认 provider。",
      },
      isPublic: {
        type: "boolean",
        description: "可选：是否公开。",
      },
      references: {
        type: "array",
        description: "可选：创建后默认挂载的 references。",
        items: {
          type: "object",
          properties: {
            dbKey: { type: "string" },
            title: { type: "string" },
            type: { type: "string", enum: ["knowledge", "instruction", "page"] },
          },
          required: ["dbKey"],
        },
      },
      linkedSpaces: {
        type: "array",
        items: { type: "string" },
        description: "可选：额外挂载的 linked spaces。",
      },
    },
  } as const,
};

export async function createSkillAgentToolFunc(
  args: CreateSkillAgentToolArgs,
  thunkApi: any
): Promise<{ rawData: unknown; displayData: string }> {
  return createAgentToolFunc(buildCreateSkillAgentArgs(args), thunkApi);
}
