// 路径: /integrations/openai/generateOpenAIRequestBody.ts
import { Agent, Message } from "../../app/types";

import { isModelSupportReasoningEffort, clampReasoningEffort } from "../../ai/llm/reasoningModels";
import { getUsageRequestOptions } from "../../ai/llm/usageRequestOptions";
import {
  isDeepInfraKimiModel,
  isFireworksKimiModel,
  resolveFireworksKimiModel,
} from "../../ai/llm/kimi";
import { Contexts } from "../../ai/types";
import { generatePrompt, buildSystemPromptContext } from "../../ai/agent/generatePrompt";
import { isLoopbackUrl } from "../../core/localOrigins";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { normalizeChatCompletionsBodyForProvider } from "./providerBodyCompatibility";

// model 理论上不应为空（schema 已强制必填），但防御性处理 undefined
const isClaudeModel = (model: string | undefined): boolean =>
  !!model && (model.includes("claude") || model.includes("anthropic"));

const applyClaudeCache = (
  stableContent: string,
  dynamicContent: string,
): any => {
  // Build a two-part system content array: the stable prefix gets
  // cache_control: ephemeral; the dynamic suffix (summary, time, etc.)
  // does not, so changing it won't invalidate the prefix cache.
  const parts: any[] = [];
  if (stableContent.trim()) {
    parts.push({
      type: "text",
      text: stableContent,
      cache_control: { type: "ephemeral" },
    });
  }
  if (dynamicContent.trim()) {
    parts.push({ type: "text", text: dynamicContent });
  }
  return parts.length > 0 ? parts : stableContent;
};

const prependPromptMessage = (
  messages: Message[],
  agentConfig: Agent,
  resolvedModel: string,
  language: string,
  contexts?: Contexts,
  prependSystemPrompt = true
): Message[] => {
  if (!prependSystemPrompt) return messages;
  if (!contexts && !agentConfig.prompt) return messages;

  // For Claude models, use the structured CompiledContext to split the
  // system prompt into a stable prefix (cache_control: ephemeral) and a
  // dynamic suffix (no cache_control).  Summary changes won't invalidate
  // the prefix cache.
  if (isClaudeModel(resolvedModel)) {
    const compiled = buildSystemPromptContext({ agentConfig, language, contexts });
    if (!compiled.content.trim()) return messages;
    const content = applyClaudeCache(
      compiled.stablePrefixContent,
      compiled.dynamicContent,
    );
    const systemMessage: Message = { role: "system", content };
    return [systemMessage, ...messages];
  }

  // For non-Claude models (DeepSeek, Gemini, etc.), keep a single string
  // system message.  Their prefix cache is automatic and prefix-based —
  // as long as the stable prefix text is identical between turns, the
  // cache hits regardless of what follows.
  const promptContent = generatePrompt({ agentConfig, language, contexts });
  if (!promptContent.trim()) return messages;
  const systemMessage: Message = { role: "system", content: promptContent };
  return [systemMessage, ...messages];
};

interface BuildRequestBodyOptions {
  model: string;
  messages: Message[];
  providerName: string;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  max_tokens?: number;
  reasoning_effort?: string;
}

const shouldInjectLlamaCppThinkingToggle = (agentConfig: Agent): boolean => {
  if (typeof agentConfig.enableThinking !== "boolean") return false;
  if (!isLoopbackUrl(agentConfig.customProviderUrl)) return false;
  return /qwen/i.test(agentConfig.model ?? "");
};

const shouldDisableMiMoThinking = (agentConfig: Agent): boolean => {
  if (agentConfig.enableThinking === true) return false;
  return (
    /xiaomimimo\.com/i.test(agentConfig.customProviderUrl ?? "") ||
    (agentConfig.provider ?? "").toLowerCase() === "mimo"
  );
};

const shouldDisableKimiThinking = (
  agentConfig: Agent,
  providerName: string,
  resolvedModel: string
): boolean => {
  if (agentConfig.enableThinking !== false) return false;
  if (providerName === "deepinfra") return isDeepInfraKimiModel(resolvedModel);
  if (providerName === "fireworks") return isFireworksKimiModel(resolvedModel);
  return false;
};

const normalizeChatCompletionsContent = (
  content: Message["content"] | Record<string, unknown> | null | undefined
): Message["content"] | null => {
  if (typeof content === "string" || Array.isArray(content)) return content;
  if (content == null) return null;
  return JSON.stringify(content);
};

const sanitizeChatCompletionsMessage = (message: Message & Record<string, any>) => {
  const sanitized: Record<string, any> = {
    role: message.role,
    content: normalizeChatCompletionsContent(message.content),
  };

  const name = asOptionalTrimmedString(message.name);
  if (name) sanitized.name = name;

  const toolCallId = asOptionalTrimmedString(message.tool_call_id);
  if (toolCallId) sanitized.tool_call_id = toolCallId;

  if (Array.isArray(message.tool_calls)) {
    sanitized.tool_calls = message.tool_calls;
  }

  if (
    message.role === "assistant" &&
    typeof message.reasoning_content === "string" &&
    message.reasoning_content
  ) {
    sanitized.reasoning_content = message.reasoning_content;
  }

  return sanitized;
};

const buildRequestBody = (options: BuildRequestBodyOptions): any => {
  const {
    model,
    messages,
    providerName,
    temperature,
    top_p,
    frequency_penalty,
    presence_penalty,
    max_tokens,
    reasoning_effort,
  } = options;

  // 只保留上游协议允许的字段，避免 UI/runtime 元数据泄漏到 chat-completions 请求体。
  const cleanedMessages = messages.map((message) =>
    sanitizeChatCompletionsMessage(message as Message & Record<string, any>)
  );

  const bodyData: any = {
    model,
    messages: cleanedMessages,
    stream: true,
  };
  const usageRequestOptions = getUsageRequestOptions(providerName, {
    api: "chat-completions",
  });
  Object.assign(bodyData, usageRequestOptions);

  // 推理强度（仅部分模型支持，且按 provider 做 clamp）
  if (reasoning_effort && isModelSupportReasoningEffort(model)) {
    const clamped = clampReasoningEffort(reasoning_effort, providerName);
    if (clamped) {
      bodyData.reasoning_effort = clamped;
    }
  }

  if (typeof temperature === "number") bodyData.temperature = temperature;
  if (typeof top_p === "number") bodyData.top_p = top_p;
  if (typeof frequency_penalty === "number")
    bodyData.frequency_penalty = frequency_penalty;
  if (typeof presence_penalty === "number")
    bodyData.presence_penalty = presence_penalty;
  if (typeof max_tokens === "number") bodyData.max_tokens = max_tokens;

  return bodyData;
};

/**
 * 主函数：生成完整的 OpenAI 请求体。
 */
export const generateOpenAIRequestBody = (
  agentConfig: Agent,
  providerName: string,
  messages: Message[],
  contexts?: Contexts,
  stableMessages: Message[] = [],
  prependSystemPrompt = true
) => {
  // 0. 解析最终 model 名：统一用 model 字段，不再有 customModelName
  //    model 在 platform 和 custom 模式下都是同一个字段
  const resolvedModel =
    providerName === "fireworks"
      ? resolveFireworksKimiModel(agentConfig.model)
      : agentConfig.model ?? "";

  // 1. 处理 stableMessages 的缓存点 (仅针对 Claude)
  //    在最后一条 stable message 上打 cache_control，使其之前的内容
  //    （system prompt + 稳定历史消息）命中前缀缓存。
  let processedStable = [...stableMessages];
  if (isClaudeModel(resolvedModel) && processedStable.length > 0) {
    const lastStableIdx = processedStable.length - 1;
    const lastContent = processedStable[lastStableIdx].content;
    // stableMessages 的 content 是 string 或已有的 content parts，
    // 只需在末尾打一个 cache_control 断点。
    if (typeof lastContent === "string") {
      processedStable[lastStableIdx] = {
        ...processedStable[lastStableIdx],
        content: [
          { type: "text", text: lastContent, cache_control: { type: "ephemeral" } },
        ],
      };
    } else if (Array.isArray(lastContent)) {
      const lastPartIdx = lastContent.length - 1;
      processedStable[lastStableIdx] = {
        ...processedStable[lastStableIdx],
        content: lastContent.map((part, idx) =>
          idx === lastPartIdx && typeof part === "object"
            ? { ...part, cache_control: { type: "ephemeral" } }
            : part
        ),
      };
    }
  }

  // 2. 合并 stable + dynamic
  const fullMessages = [...processedStable, ...messages];

  const messagesWithPrompt = prependPromptMessage(
    fullMessages,
    agentConfig,
    resolvedModel,
    typeof navigator !== "undefined" ? (navigator as any).language : "en",
    contexts,
    prependSystemPrompt
  );

  const requestBody = buildRequestBody({
    model: resolvedModel,
    messages: messagesWithPrompt,
    providerName,
    temperature: agentConfig.temperature,
    top_p: agentConfig.top_p,
    frequency_penalty: agentConfig.frequency_penalty,
    presence_penalty: agentConfig.presence_penalty,
    max_tokens: agentConfig.max_tokens,
    reasoning_effort: agentConfig.reasoning_effort,
  });

  if (shouldInjectLlamaCppThinkingToggle(agentConfig)) {
    requestBody.chat_template_kwargs = {
      ...(requestBody.chat_template_kwargs ?? {}),
      enable_thinking: agentConfig.enableThinking,
    };
  }

  if (shouldDisableMiMoThinking(agentConfig)) {
    requestBody.thinking = { type: "disabled" };
  }

  if (shouldDisableKimiThinking(agentConfig, providerName, resolvedModel)) {
    requestBody.thinking = { type: "disabled" };
    requestBody.reasoning_effort = "none";
    requestBody.reasoning = { enabled: false };
  }

  return normalizeChatCompletionsBodyForProvider({
    body: requestBody,
    provider: providerName,
    model: requestBody.model,
  });
};
