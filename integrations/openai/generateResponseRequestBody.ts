// /integrations/openai/generateResponseRequestBody.ts
import { Agent, Message } from "../../app/types";
import { generatePrompt } from "../../ai/agent/generatePrompt";
import { getUsageRequestOptions } from "../../ai/llm/usageRequestOptions";
import { Contexts } from "../../ai/types";
import { resolveOpenAIRequestTarget } from "./flexTier";
import { convertMessagesToResponsesInput } from "./responsesHelpers";

/**
 * 生成新版 Response API 请求体
 * Responses API (/v1/responses) 天然在流结束时返回 usage，
 * 不需要也不支持 Chat Completions 的 stream_options.include_usage。
 * @param agentConfig Agent 配置
 * @param msgs 历史消息列表（数组里每项为 { role, content, name?, tool_calls?, tool_call_id? }）
 * @param contexts 可选上下文
 */
export function generateResponseRequestBody(
  agentConfig: Agent,
  msgs: Message[],
  contexts?: Contexts,
  prependSystemPrompt = true
) {
  const language =
    typeof navigator !== "undefined" && navigator.language
      ? navigator.language
      : "zh-CN";
  const input = convertMessagesToResponsesInput(msgs);
  const requestTarget = resolveOpenAIRequestTarget({
    providerName: agentConfig.provider,
    model: agentConfig.model,
  });
  const body: Record<string, any> = {
    model: requestTarget.model ?? agentConfig.model,
    input,
    stream: true,
    ...getUsageRequestOptions(agentConfig.provider, { api: "responses" }),
  };

  if (prependSystemPrompt) {
    const promptContent = generatePrompt({
      agentConfig,
      language,
      contexts,
    });
    body.instructions = promptContent;
  }

  if (requestTarget.serviceTier) {
    body.service_tier = requestTarget.serviceTier;
  }

  // 3. 按需添加可选字段

  if (agentConfig.temperature !== undefined) {
    body.temperature = agentConfig.temperature;
  }
  if (agentConfig.top_p !== undefined) {
    body.top_p = agentConfig.top_p;
  }
  if (agentConfig.max_tokens !== undefined) {
    body.max_output_tokens = agentConfig.max_tokens;
  }
  if (agentConfig.max_tool_calls !== undefined) {
    body.max_tool_calls = agentConfig.max_tool_calls;
  }
  if (agentConfig.user !== undefined) {
    body.user = agentConfig.user;
  }
  if (agentConfig.include !== undefined) {
    body.include = agentConfig.include;
  }
  if (agentConfig.metadata !== undefined) {
    body.metadata = agentConfig.metadata;
  }

  return body;
}
