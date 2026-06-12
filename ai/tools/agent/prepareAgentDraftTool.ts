import { DEFAULT_MODEL } from "../../llm/providers";
import {
  GUIDED_AGENT_CAPABILITIES,
  mapCapabilityIdsToToolIds,
} from "../../agent/guidedCreation/capabilities";
import type {
  GuidedAgentCapabilityId,
  GuidedAgentDraft,
  GuidedAgentReferenceChoice,
} from "../../agent/guidedCreation/types";

export type PrepareAgentDraftToolArgs = Partial<GuidedAgentDraft>;

const capabilityIds = new Set(Object.keys(GUIDED_AGENT_CAPABILITIES));

const trim = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((item) => trim(item)).filter(Boolean)
    : [];

const guidedCapabilityArray = (value: unknown): GuidedAgentCapabilityId[] =>
  stringArray(value).filter((id): id is GuidedAgentCapabilityId =>
    capabilityIds.has(id)
  );

const referencesArray = (value: unknown): GuidedAgentReferenceChoice[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is Record<string, unknown> =>
          !!item && typeof item === "object" && !Array.isArray(item)
        )
        .map((item) => ({
          dbKey: trim(item.dbKey),
          title: trim(item.title),
          type: item.type === "instruction" ? "instruction" : "knowledge",
          selected: item.selected === true,
          ...(trim(item.reason) ? { reason: trim(item.reason) } : {}),
        }))
        .filter((item) => item.dbKey)
    : [];

const buildPrompt = (args: PrepareAgentDraftToolArgs) => {
  const prompt = trim(args.prompt);
  if (prompt) return prompt;
  const name = trim(args.name) || "用户的专属 AI";
  const summary = trim(args.promptSummary) || trim(args.introduction);
  return [
    `你是${name}。`,
    summary || "你需要理解用户目标，并给出清晰、可执行、有边界的帮助。",
    "如果信息不足，先提出必要澄清问题；不要编造用户没有确认的资料来源。",
  ].join("\n");
};

export const buildPreparedAgentDraft = (
  args: PrepareAgentDraftToolArgs
): GuidedAgentDraft => {
  const selectedCapabilities = guidedCapabilityArray(args.capabilityIds);
  const providedToolIds = stringArray(args.toolIds);
  const mappedToolIds = mapCapabilityIdsToToolIds(selectedCapabilities);
  return {
    name: trim(args.name),
    introduction: trim(args.introduction),
    prompt: buildPrompt(args),
    promptSummary: trim(args.promptSummary),
    provider: trim(args.provider) || DEFAULT_MODEL.provider,
    model: trim(args.model) || DEFAULT_MODEL.name,
    isPublic: args.isPublic === true,
    capabilityIds: selectedCapabilities,
    toolIds: Array.from(new Set([...providedToolIds, ...mappedToolIds])),
    references: referencesArray(args.references),
    tags: stringArray(args.tags),
    unresolved: stringArray(args.unresolved),
  };
};

export const prepareAgentDraftToolFunctionSchema = {
  name: "prepareAgentDraft",
  description:
    "整理一个可预览的 Agent 创建草稿。只生成草稿，不创建真实 Agent 记录。",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "建议的 Agent 名称。" },
      introduction: { type: "string", description: "面向用户展示的简介。" },
      prompt: { type: "string", description: "完整系统 prompt 草稿。" },
      promptSummary: { type: "string", description: "prompt 的简短摘要。" },
      provider: { type: "string", description: "建议 provider。" },
      model: { type: "string", description: "建议模型名称。" },
      isPublic: { type: "boolean", description: "是否建议公开。" },
      capabilityIds: {
        type: "array",
        items: {
          type: "string",
          enum: Object.keys(GUIDED_AGENT_CAPABILITIES),
        },
        description: "已确认或高度确定的能力标签。",
      },
      toolIds: {
        type: "array",
        items: { type: "string" },
        description: "可选的底层工具名；通常由 capabilityIds 推导。",
      },
      references: {
        type: "array",
        items: {
          type: "object",
          properties: {
            dbKey: { type: "string" },
            title: { type: "string" },
            type: { type: "string", enum: ["knowledge", "instruction"] },
            selected: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["dbKey"],
        },
        description: "建议挂载的知识引用，默认等待用户确认。",
      },
      tags: {
        type: "array",
        items: { type: "string" },
      },
      unresolved: {
        type: "array",
        items: { type: "string" },
        description: "仍需确认的字段或问题。",
      },
    },
    required: ["name", "introduction", "promptSummary"],
  },
};

export async function prepareAgentDraftToolFunc(
  args: PrepareAgentDraftToolArgs
): Promise<{
  rawData: { draft: GuidedAgentDraft; createUrl: string };
  displayData: string;
}> {
  const draft = buildPreparedAgentDraft(args);
  const missing = draft.unresolved.length
    ? `\n- 待确认: ${draft.unresolved.join(", ")}`
    : "";
  return {
    rawData: {
      draft,
      createUrl: "/create/agent",
    },
    displayData: [
      `Agent 草稿: ${draft.name || "未命名 AI"}`,
      draft.promptSummary ? `- 摘要: ${draft.promptSummary}` : "",
      draft.capabilityIds.length
        ? `- 能力: ${draft.capabilityIds.join(", ")}`
        : "",
      missing,
    ].filter(Boolean).join("\n"),
  };
}
