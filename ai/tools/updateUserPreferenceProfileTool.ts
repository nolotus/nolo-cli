import type {
  KnowledgeCaptureLevel,
  SpaceContextLevel,
  TonePreset,
} from "../policy/types";
import {
  normalizeAgentUpdateFieldList,
  type AgentUpdateField,
} from "../policy/selfUpdateFields";
import { asOptionalTrimmedString } from "../../core/optionalString";

async function dispatchSetSettings(thunkApi: any, changes: Record<string, unknown>) {
  const injectedSetSettings = thunkApi?.extra?.setSettings;
  const setSettings =
    typeof injectedSetSettings === "function"
      ? injectedSetSettings
      : (await import("../../app/settings/settingSlice")).setSettings;
  await thunkApi.dispatch(setSettings(changes as any)).unwrap();
}

export interface UpdateUserPreferenceProfileArgs {
  userTonePreset?: TonePreset;
  knowledgeCaptureLevel?: KnowledgeCaptureLevel;
  spaceContextLevel?: SpaceContextLevel;
  autoApproveSelfUpdateFields?: AgentUpdateField[];
  globalPrompt?: string;
  defaultAgentId?: string;
  summary?: string;
}

export const updateUserPreferenceProfileFunctionSchema = {
  name: "updateUserPreferenceProfile",
  description: [
    "当你已经明确收集到用户的个性化偏好时，使用本工具把这些偏好保存到用户设置里。",
    "适用于保存 tone、knowledge capture、space context，以及用户的 global prompt / 自我介绍摘要。",
    "只有在用户已经明确表达或确认后才调用；不要在信息不充分时猜测。",
    "调用后，你应当用自然语言简要总结已保存的设置，并说明用户之后可以继续调整。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      userTonePreset: {
        type: "string",
        enum: ["default", "direct", "pragmatic", "friendly", "professional"],
        description: "用户偏好的交流语气。",
      },
      knowledgeCaptureLevel: {
        type: "integer",
        enum: [1, 2, 3, 4],
        description: "知识沉淀级别：1 不主动创建；2 先问再创建；3 回答后建议；4 高价值结果可自动创建。",
      },
      spaceContextLevel: {
        type: "integer",
        enum: [1, 2, 3, 4],
        description: "空间上下文级别：1 不自动读取；2 只看结构和标题；3 轻量读取；4 自适应读取。",
      },
      autoApproveSelfUpdateFields: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "name",
            "model",
            "provider",
            "prompt",
            "introduction",
            "greeting",
            "isPublic",
            "tags",
            "tools",
            "references",
            "temperature",
            "top_p",
            "frequency_penalty",
            "presence_penalty",
            "max_tokens",
            "reasoning_effort",
          ],
        },
        description: "哪些 updateSelf 字段以后不再询问用户，直接自动通过。",
      },
      globalPrompt: {
        type: "string",
        description: "可选：用户希望长期保留的一小段通用偏好说明。未明确确认时不要写。",
      },
      defaultAgentId: {
        type: "string",
        description: "可选：用户明确要求切换首页默认 agent 时才填写。",
      },
      summary: {
        type: "string",
        description: "给开发和日志看的简短总结，不会影响设置本身。",
      },
    },
  } as const,
};

export async function updateUserPreferenceProfileFunc(
  args: UpdateUserPreferenceProfileArgs,
  thunkApi: any
): Promise<{ rawData: unknown; displayData: string }> {
  const changes: Record<string, unknown> = {};

  if (args.userTonePreset) {
    changes.userTonePreset = args.userTonePreset;
  }
  if (typeof args.knowledgeCaptureLevel === "number") {
    changes.knowledgeCaptureLevel = args.knowledgeCaptureLevel;
  }
  if (typeof args.spaceContextLevel === "number") {
    changes.spaceContextLevel = args.spaceContextLevel;
    changes.enableReadCurrentSpace = args.spaceContextLevel > 1;
  }
  if (Array.isArray(args.autoApproveSelfUpdateFields)) {
    changes.autoApproveSelfUpdateFields = normalizeAgentUpdateFieldList(
      args.autoApproveSelfUpdateFields,
      []
    );
  }
  const globalPrompt = asOptionalTrimmedString(args.globalPrompt);
  if (globalPrompt) {
    changes.globalPrompt = globalPrompt;
  }
  const defaultAgentId = asOptionalTrimmedString(args.defaultAgentId);
  if (defaultAgentId) {
    changes.defaultAgentId = defaultAgentId;
  }

  if (Object.keys(changes).length === 0) {
    throw new Error("没有可保存的用户偏好设置。");
  }

  await dispatchSetSettings(thunkApi, changes);

  const rawData = {
    success: true,
    updated: changes,
    summary: asOptionalTrimmedString(args.summary) ?? null,
  };

  const labels: string[] = [];
  if (changes.userTonePreset) labels.push(`语气=${changes.userTonePreset}`);
  if (changes.knowledgeCaptureLevel)
    labels.push(`知识沉淀=${changes.knowledgeCaptureLevel}`);
  if (changes.spaceContextLevel)
    labels.push(`空间读取=${changes.spaceContextLevel}`);
  if (changes.autoApproveSelfUpdateFields)
    labels.push("自我更新免询问字段已更新");
  if (changes.defaultAgentId) labels.push("默认助手已更新");
  if (changes.globalPrompt) labels.push("通用提示词已更新");

  return {
    rawData,
    displayData: `已保存用户偏好：${labels.join("，")}`,
  };
}
