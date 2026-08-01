// ai/llm/generateRequestBody.ts
import { Agent, Message } from "../../app/types";
import { asTrimmedString } from "../../core/trimmedString";
import { generateOpenAIRequestBody } from "../../integrations/openai/generateOpenAIRequestBody";
import { generateResponseRequestBody } from "../../integrations/openai/generateResponseRequestBody";

import {
  resolveAgentCallPlan,
  resolveClientWire,
} from "../../agent-runtime/agentCallPlan";
import { Contexts } from "../types";
import { getModelConfig } from "./providers";
import type { Model } from "./types";

export interface GenerateRequestBodyArgs {
  agentConfig: Agent;
  messages: Message[]; // 动态历史消息/本轮新增
  userInput: string; // 本次用户输入
  contexts?: Contexts; // 可选上下文
  stableMessages?: Message[]; // 稳定的、已截断的历史快照（用于缓存）
  prependSystemPrompt?: boolean;
}

const IMAGE_OUTPUT_EXECUTION_PROMPT = [
  "When the conversation already includes an input image and the user asks to change any visual attribute such as hairstyle, glasses, outfit, makeup, background, composition, or style, default to returning the edited image in this turn.",
  "When the user asks you to generate, edit, redraw, or return an image, you must return the image in this turn.",
  "Do not answer with only a textual description.",
  "Do not claim that you uploaded, attached, or sent an image unless the response actually includes image output.",
  "Only return text without an image when the user explicitly asks for analysis, recommendations, or explanation without generating an image.",
].join(" ");

type ImageOutputSettings = {
  shouldEnableImage: boolean;
  modelConfig: Model | null;
};

const getImageOutputSettings = (
  agentConfig: Agent,
  provider: string
): ImageOutputSettings => {
  const modelName = agentConfig.model;
  if (!modelName) {
    return { shouldEnableImage: false, modelConfig: null };
  }

  try {
    const modelConfig = getModelConfig(provider as any, modelName);
    const hasImageOutput = !!modelConfig.hasImageOutput;
    const isExplicitlyDisabled = agentConfig.imageConfig?.enabled === false;
    return {
      shouldEnableImage: hasImageOutput && !isExplicitlyDisabled,
      modelConfig,
    };
  } catch {
    return { shouldEnableImage: false, modelConfig: null };
  }
};

const withImageOutputPromptGuard = (
  agentConfig: Agent,
  shouldEnableImage: boolean
): Agent => {
  if (!shouldEnableImage) return agentConfig;

  const basePrompt = asTrimmedString(agentConfig.prompt);
  if (basePrompt.includes(IMAGE_OUTPUT_EXECUTION_PROMPT)) {
    return agentConfig;
  }

  return {
    ...agentConfig,
    prompt: basePrompt
      ? `${basePrompt}\n\n${IMAGE_OUTPUT_EXECUTION_PROMPT}`
      : IMAGE_OUTPUT_EXECUTION_PROMPT,
  };
};

/**
 * 根据模型元数据 + Agent 配置，为 chat/completions 请求体注入
 * - modalities: ["image", "text"]
 * - image_config: { aspect_ratio, image_size }
 */
const applyImageConfigIfNeeded = (
  body: any,
  agentConfig: Agent,
  provider: string
): any => {
  const { shouldEnableImage, modelConfig } = getImageOutputSettings(
    agentConfig,
    provider
  );
  const agentImageCfg = agentConfig.imageConfig;

  if (!shouldEnableImage || !modelConfig) {
    return body;
  }

  // 1) 处理 modalities
  // 优先级：Agent.forceModalities > Model.defaultModalities > requiresImageModalities ? ["image","text"] : 不强制
  const modalities: Array<"text" | "image"> | undefined =
    agentImageCfg?.forceModalities ??
    modelConfig.defaultModalities ??
    (modelConfig.requiresImageModalities
      ? (["image", "text"] as Array<"text" | "image">)
      : undefined);

  if (modalities && !body.modalities) {
    body.modalities = modalities;
  }

  // 2) 处理 image_config（仅在模型声明 supportsImageConfig 时生效）
  if (!modelConfig.supportsImageConfig) {
    return body;
  }

  const aspectRatio = agentImageCfg?.aspectRatio;
  const imageSize = agentImageCfg?.imageSize;

  if (!aspectRatio && !imageSize) {
    // Agent 未指定任何 image_config 参数，则沿用模型默认
    return body;
  }

  body.image_config = {
    ...(body.image_config ?? {}),
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(imageSize ? { image_size: imageSize } : {}),
  };

  return body;
};

export const generateRequestBody = ({
  agentConfig,
  messages,
  contexts,
  stableMessages,
  prependSystemPrompt = true,
}: GenerateRequestBodyArgs) => {
  const provider = (agentConfig.provider || "").toLowerCase();
  const imageSettings = getImageOutputSettings(agentConfig, provider);
  const agentConfigForRequest = withImageOutputPromptGuard(
    agentConfig,
    imageSettings.shouldEnableImage
  );

  // 1) Response API 走新版 /v1/responses。用描述符的 client wire 判定，
  //    而不是 isResponseAPIModel —— 后者只看 provider/model，对 codex
  //    (apiKeyRef:chatgpt) 会误判为 responses 而发 input（F1 bug）。
  const clientWire = resolveClientWire(
    resolveAgentCallPlan(agentConfigForRequest as any, {})
  );
  if (clientWire === "responses") {
    return generateResponseRequestBody(
      agentConfigForRequest,
      [...(stableMessages ?? []), ...messages],
      contexts,
      prependSystemPrompt
    );
  }

  // 2) 其余走老版 chat/completions
  const baseBody = generateOpenAIRequestBody(
    agentConfigForRequest,
    provider,
    messages,
    contexts,
    stableMessages,
    prependSystemPrompt
  );

  // 在基础请求体上注入图像相关配置（如果模型 + Agent 都支持/需要）
  return applyImageConfigIfNeeded(baseBody, agentConfigForRequest, provider);
};
