// /integrations/openai/generateResponseRequestBody.ts
import { Agent, Message } from "../../app/types";
import { generatePrompt } from "../../ai/agent/generatePrompt";
import { getUsageRequestOptions } from "../../ai/llm/usageRequestOptions";
import { Contexts } from "../../ai/types";
import { convertMessagesToResponsesInput } from "./responsesHelpers";
import {
    selectResponsesConversationState,
    supportsResponsesConversationState,
} from "../../agent-runtime/responsesConversationState";
import type { ResponsesConversationState } from "../../agent-runtime/types";

const DEFAULT_RESPONSES_COMPACTION_THRESHOLD = 200_000;

function resolveResponsesCompactionThreshold(agentConfig: Agent): number {
  const configured = Number(
    agentConfig.responsesCompactionThreshold ??
      agentConfig.responses_compaction_threshold,
  );
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_RESPONSES_COMPACTION_THRESHOLD;
}

/**
 * With previous_response_id the upstream already owns the prior response
 * items. Only the current user turn or the tool outputs after the latest
 * assistant call belong in the next input array.
 */
export function selectResponsesContinuationMessages(msgs: Message[]): Message[] {
  let lastAssistantIndex = -1;
  for (let index = msgs.length - 1; index >= 0; index -= 1) {
    if (msgs[index]?.role === "assistant") {
      lastAssistantIndex = index;
      break;
    }
  }
  const candidates =
    lastAssistantIndex >= 0 ? msgs.slice(lastAssistantIndex + 1) : msgs;
  return candidates.filter((message) => message.role !== "system");
}

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
  prependSystemPrompt = true,
  responsesState?: ResponsesConversationState | null,
) {
  const language =
    typeof navigator !== "undefined" && navigator.language
      ? navigator.language
      : "zh-CN";
  const state =
    responsesState !== undefined
      ? responsesState
      : selectResponsesConversationState(agentConfig.responsesState, agentConfig);
  const supportsServerState = supportsResponsesConversationState(agentConfig);
  const stateful = supportsServerState && state && agentConfig.store !== false ? state : null;
  const input = convertMessagesToResponsesInput(
    stateful ? selectResponsesContinuationMessages(msgs) : msgs,
  );
  const body: Record<string, any> = {
    model: agentConfig.model,
    input,
    stream: true,
    ...getUsageRequestOptions(agentConfig.provider, { api: "responses" }),
  };

  if (prependSystemPrompt) {
    // Responses API instructions is a single string — no cache_control
    // breakpoints like Chat Completions.  The stable prefix (identity/persona/
    // tools/contracts) naturally stays at the front of buildSystemPrompt's
    // output, letting provider-side automatic prefix cache (DeepSeek/Gemini)
    // hit across turns even when summary/time changes.
    const promptContent = generatePrompt({
      agentConfig,
      language,
      contexts,
    });
    body.instructions = promptContent;
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

  // Stateful continuation is explicitly enabled by a provider/model-bound
  // response state. The compaction shape mirrors the official Responses API
  // contract and is intentionally unreachable from Chat Completions.
  if (stateful) {
    body.previous_response_id = stateful.responseId;
    if (agentConfig.context_management === undefined) {
      body.context_management = [
        {
          type: "compaction",
          compact_threshold: resolveResponsesCompactionThreshold(agentConfig),
        },
      ];
    }
  } else if (
    supportsServerState &&
    responsesState === undefined &&
    agentConfig.previous_response_id !== undefined
  ) {
    // Keep the old explicit seam backwards-compatible for callers that have
    // not migrated to the typed dialog state yet.
    body.previous_response_id = agentConfig.previous_response_id;
  }
  if (supportsServerState && agentConfig.store !== undefined) {
    body.store = agentConfig.store;
  }
  if (supportsServerState && agentConfig.context_management !== undefined) {
    body.context_management = agentConfig.context_management;
  }

  return body;
}
