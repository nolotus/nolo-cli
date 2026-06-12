import type { Agent } from "../../../app/types";
import type { FormData as AgentFormData } from "../../agent/createAgentSchema";
import {
  type AgentUpdateField,
  AGENT_UPDATE_FIELD_NAMES,
} from "../../policy/selfUpdateFields";
import { ToolResultError } from "../../tools/toolResultError";

type ReasoningEffort = "low" | "medium" | "high";

export type ReferenceArg = {
  dbKey: string;
  title?: string;
  type?: "knowledge" | "instruction" | "page";
};

export type GreetingMenuItemArg = {
  id: string;
  label: string;
  userMessage?: string;
};

export type GreetingConfigArg = {
  text?: string;
  menu?: GreetingMenuItemArg[];
};

export type AgentUpdateArgsShape = {
  __confirmedSelfEvolution?: boolean;
  name?: string;
  model?: string;
  provider?: string;
  prompt?: string;
  introduction?: string;
  greeting?: string | GreetingConfigArg;
  isPublic?: boolean;
  tags?: string[] | string;
  tools?: string[];
  references?: ReferenceArg[];
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  max_tokens?: number;
  reasoning_effort?: ReasoningEffort;
};

export type UpdateAgentToolArgs = AgentUpdateArgsShape & {
  agentId: string;
};

export type UpdateSelfToolArgs = AgentUpdateArgsShape;

export const agentUpdateFieldSchemaProperties = {
  name: { type: "string", description: "Agent 的新名称。" },
  model: { type: "string", description: "模型名称，例如 'gpt-4o-mini'。" },
  provider: { type: "string", description: "模型提供方，例如 'openai'。若不确定可留空。" },
  prompt: { type: "string", description: "系统提示词，描述 Agent 的角色和行为。" },
  introduction: { type: "string", description: "面向终端用户的简介文案。" },
  greeting: {
    description: "欢迎配置：纯文本字符串，或包含欢迎语 + 菜单的对象。",
    anyOf: [
      { type: "string", description: "纯文本欢迎语。" },
      {
        type: "object",
        description: "结构化欢迎配置。",
        properties: {
          text: { type: "string", description: "欢迎语文本。" },
          menu: {
            type: "array",
            description: "快捷菜单项。",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "菜单项唯一标识。" },
                label: { type: "string", description: "按钮显示文案。" },
                userMessage: { type: "string", description: "点击后发送给 Agent 的消息。" },
              },
              required: ["id", "label"],
            },
          },
        },
      },
    ],
  },
  isPublic: { type: "boolean", description: "是否公开到应用市场。" },
  tags: {
    type: "array",
    items: { type: "string" },
    description: "标签列表；传空数组 [] 表示清空。",
  },
  tools: {
    type: "array",
    items: { type: "string" },
    description: "允许调用的工具名称数组。",
  },
  references: {
    type: "array",
    description: "引用集合；传空数组 [] 表示清空。",
    items: {
      type: "object",
      properties: {
        dbKey: { type: "string", description: "引用条目的数据库键。" },
        title: { type: "string", description: "引用在 UI 中展示的标题。" },
        type: {
          type: "string",
          enum: ["knowledge", "instruction", "page"],
          description: "引用类型。",
        },
      },
      required: ["dbKey"],
    },
  },
  temperature: { type: "number", description: "采样温度，0~2。" },
  top_p: { type: "number", description: "nucleus sampling，0~1。" },
  frequency_penalty: { type: "number", description: "重复惩罚，-2~2。" },
  presence_penalty: { type: "number", description: "新话题激励，-2~2。" },
  max_tokens: { type: "number", description: "单次回答最大 token 数。" },
  reasoning_effort: {
    type: "string",
    enum: ["low", "medium", "high"],
    description: "推理强度。",
  },
} as const;

type AgentPatch = Partial<AgentFormData> & {
  greeting?: string | GreetingConfigArg;
  tags?: string[] | string;
  references?: ReferenceArg[];
};

export const validateUpdateArgs = (
  userId: string | undefined,
  options?: { requireAgentId?: boolean; agentId?: string },
): void => {
  if (!userId) throw new Error("更新 Agent 失败：当前未登录或缺少 userId。");
  if (options?.requireAgentId && !options?.agentId?.trim()) {
    throw new Error("更新 Agent 失败：必须提供非空的 agentId。");
  }
};

export const fetchAgentByDbKey = async (
  dbKey: string,
  db: any,
): Promise<Agent | undefined> => {
  if (!db) return undefined;
  return db.get(dbKey).catch(() => undefined);
};

export const extractAgentId = (dbKey: string): string => {
  const parts = dbKey.trim().split("-");
  return parts.length >= 3 ? parts[parts.length - 1] : dbKey.trim();
};

export const buildPatch = (args: AgentUpdateArgsShape): AgentPatch => {
  const patch: AgentPatch = {};
  const {
    name,
    model,
    provider,
    prompt,
    introduction,
    greeting,
    isPublic,
    tags,
    tools,
    references,
    temperature,
    top_p,
    frequency_penalty,
    presence_penalty,
    max_tokens,
    reasoning_effort,
  } = args;

  if (name !== undefined) patch.name = String(name).trim();
  if (model !== undefined) patch.model = String(model).trim();
  if (provider !== undefined) patch.provider = String(provider).trim();
  if (prompt !== undefined) patch.prompt = prompt;
  if (introduction !== undefined) patch.introduction = introduction;
  if (greeting !== undefined) patch.greeting = greeting;
  if (isPublic !== undefined) patch.isPublic = isPublic;
  if (tags !== undefined) patch.tags = tags as any;
  if (tools !== undefined) patch.tools = tools ?? [];
  if (references !== undefined) patch.references = references as any;
  if (temperature !== undefined) patch.temperature = temperature;
  if (top_p !== undefined) patch.top_p = top_p;
  if (frequency_penalty !== undefined) patch.frequency_penalty = frequency_penalty;
  if (presence_penalty !== undefined) patch.presence_penalty = presence_penalty;
  if (max_tokens !== undefined) patch.max_tokens = max_tokens;
  if (reasoning_effort !== undefined) patch.reasoning_effort = reasoning_effort;

  return patch;
};

const AGENT_UPDATE_FIELD_NAME_SET = new Set<string>(AGENT_UPDATE_FIELD_NAMES);

export const listRequestedFields = (
  args: Record<string, unknown>,
): AgentUpdateField[] =>
  Object.keys(args).filter(
    (key): key is AgentUpdateField =>
      key !== "agentId" &&
      key !== "__confirmedSelfEvolution" &&
      AGENT_UPDATE_FIELD_NAME_SET.has(key) &&
      args[key] !== undefined,
  );

export const assertAgentUpdateConfirmation = ({
  scope,
  requestedFields,
  confirmed,
  autoApprovedFields = [],
}: {
  scope: "self" | "generic";
  requestedFields: AgentUpdateField[];
  confirmed?: boolean;
  autoApprovedFields?: AgentUpdateField[];
}): void => {
  if (requestedFields.length === 0 || confirmed) return;

  const allowedFields =
    scope === "self"
      ? requestedFields.filter((field) => autoApprovedFields.includes(field))
      : [];
  const blockedFields =
    scope === "self"
      ? requestedFields.filter((field) => !autoApprovedFields.includes(field))
      : requestedFields;

  if (blockedFields.length === 0) return;

  const displayPrefix = scope === "self" ? "updateSelf" : "updateAgent";
  throw new ToolResultError(
    scope === "self"
      ? `当前自我更新字段需要先确认：${blockedFields.join(", ")}`
      : `当前通用 Agent 更新需要先确认：${blockedFields.join(", ")}`,
    {
      code: "agent_update_requires_confirmation",
      retryable: false,
      displayData: `${displayPrefix} 需要先确认：${blockedFields.join(", ")}`,
      rawData: {
        error: "agent_update_requires_confirmation",
        message:
          scope === "self"
            ? "当前自我更新包含需要用户确认的字段。"
            : "当前通用 Agent 更新默认要求用户确认。",
        policy: {
          capability: scope === "self" ? "self_update" : "agent_update",
          scope,
          decision: "ask",
          requestedFields,
          allowedFields,
          blockedFields,
          autoApprovedFields,
        },
      },
    },
  );
};

export const buildRawDataWithUpdateInfo = (
  agent: Agent,
  previousAgent: Agent,
  requestedFields: AgentUpdateField[],
) => {
  const changes: Record<string, { o: any; n: any }> = {};
  for (const key of requestedFields) {
    const newVal = (agent as any)[key];
    const oldVal = (previousAgent as any)[key];
    if (JSON.stringify(newVal) !== JSON.stringify(oldVal)) {
      changes[key] = { o: oldVal, n: newVal };
    }
  }

  return {
    ...agent,
    _isUpdate: true,
    _changes: Object.keys(changes).length > 0 ? changes : undefined,
  };
};

export const formatUpdatedAgentOutput = (agent: Agent): string =>
  [
    `✅ 已更新 Agent：${agent.name ?? "(名称未变)"}`,
    `- ID: ${agent.id}`,
    `- 是否公开: ${agent.isPublic ? "是" : "否"}`,
    agent.model && `- 模型: ${agent.model}`,
    (agent as any).provider && `- Provider: ${(agent as any).provider}`,
    agent.tags?.length && `- 标签: ${agent.tags.join(", ")}`,
    typeof agent.temperature === "number" && `- temperature: ${agent.temperature}`,
  ]
    .filter(Boolean)
    .join("\n");

export const buildUpdateThunkPreviousAgent = (
  previousAgent: Agent,
  userId: string,
): Agent => {
  const ownerUserId = String(previousAgent.userId ?? "").trim();
  if (previousAgent.isPublic && ownerUserId !== userId) {
    return {
      ...previousAgent,
      isPublic: false,
    };
  }
  return previousAgent;
};

// TODO: Persist lightweight audit events for updateSelf/updateAgent so version history
// and future rollback can inspect who changed what without rebuilding it from dialogs.
