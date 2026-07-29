import { randomUUID } from "node:crypto";

import type { AgentRuntimeAgentConfig } from "./hostAdapter";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_API_VERSION = "2023-06-01";
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

type JsonRecord = Record<string, unknown>;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toAnthropicContent(content: unknown): JsonRecord[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: JsonRecord[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as JsonRecord;
    if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type !== "image_url") continue;
    const imageUrl =
      typeof part.image_url === "string"
        ? part.image_url
        : stringValue((part.image_url as JsonRecord | undefined)?.url);
    if (!imageUrl) continue;
    const dataMatch = imageUrl.match(/^data:([^;,]+);base64,(.+)$/s);
    blocks.push({
      type: "image",
      source: dataMatch
        ? { type: "base64", media_type: dataMatch[1], data: dataMatch[2] }
        : { type: "url", url: imageUrl },
    });
  }
  return blocks;
}

function pushMessage(
  messages: JsonRecord[],
  role: "user" | "assistant",
  content: JsonRecord[],
): void {
  if (content.length === 0) return;
  const previous = messages.at(-1);
  if (previous?.role === role && Array.isArray(previous.content)) {
    (previous.content as JsonRecord[]).push(...content);
    return;
  }
  messages.push({ role, content });
}

export function buildAnthropicMessagesBody(args: {
  agentConfig: AgentRuntimeAgentConfig;
  openAiBody: JsonRecord;
}): JsonRecord {
  const rawMessages = Array.isArray(args.openAiBody.messages)
    ? args.openAiBody.messages
    : [];
  const system: JsonRecord[] = [];
  if (args.agentConfig.prompt?.trim()) {
    system.push({ type: "text", text: args.agentConfig.prompt.trim() });
  }
  const messages: JsonRecord[] = [];

  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as JsonRecord;
    const role = String(message.role ?? "");
    if (role === "system" || role === "developer") {
      system.push(...toAnthropicContent(message.content));
      continue;
    }
    if (role === "tool") {
      const toolUseId = stringValue(message.tool_call_id);
      if (toolUseId) {
        pushMessage(messages, "user", [{
          type: "tool_result",
          tool_use_id: toolUseId,
          content: typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content ?? ""),
        }]);
      }
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const blocks = toAnthropicContent(message.content);
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const rawCall of message.tool_calls) {
        if (!rawCall || typeof rawCall !== "object") continue;
        const call = rawCall as JsonRecord;
        const fn = call.function as JsonRecord | undefined;
        const name = stringValue(fn?.name);
        if (!name) continue;
        let input: unknown = {};
        try {
          input = typeof fn?.arguments === "string" ? JSON.parse(fn.arguments) : fn?.arguments ?? {};
        } catch {
          input = { value: fn?.arguments };
        }
        blocks.push({
          type: "tool_use",
          id: stringValue(call.id) ?? `toolu_${randomUUID()}`,
          name,
          input,
        });
      }
    }
    pushMessage(messages, role, blocks);
  }

  const tools = Array.isArray(args.openAiBody.tools)
    ? args.openAiBody.tools.flatMap((raw): JsonRecord[] => {
        if (!raw || typeof raw !== "object") return [];
        const fn = (raw as JsonRecord).function as JsonRecord | undefined;
        const name = stringValue(fn?.name);
        if (!name) return [];
        return [{
          name,
          ...(stringValue(fn?.description) ? { description: fn?.description } : {}),
          input_schema:
            fn?.parameters && typeof fn.parameters === "object"
              ? fn.parameters
              : { type: "object", properties: {} },
        }];
      })
    : [];
  const model =
    stringValue(args.openAiBody.model) ?? args.agentConfig.model ?? "claude-sonnet-5";
  const maxTokensRaw =
    args.openAiBody.max_completion_tokens ??
    args.openAiBody.max_tokens ??
    args.agentConfig.max_tokens;
  const maxTokens =
    typeof maxTokensRaw === "number" && Number.isFinite(maxTokensRaw)
      ? Math.max(1, Math.floor(maxTokensRaw))
      : 8192;

  return {
    model,
    messages,
    max_tokens: maxTokens,
    stream: false,
    ...(system.length > 0 ? { system } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(typeof args.openAiBody.temperature === "number"
      ? { temperature: args.openAiBody.temperature }
      : typeof args.agentConfig.temperature === "number"
        ? { temperature: args.agentConfig.temperature }
        : {}),
    ...(typeof args.openAiBody.top_p === "number" ? { top_p: args.openAiBody.top_p } : {}),
  };
}

export function mapAnthropicMessageToOpenAi(payload: JsonRecord): JsonRecord {
  const content = Array.isArray(payload.content) ? payload.content : [];
  let text = "";
  let reasoning = "";
  const toolCalls: JsonRecord[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as JsonRecord;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    if (block.type === "thinking" && typeof block.thinking === "string") reasoning += block.thinking;
    if (block.type === "tool_use" && typeof block.name === "string") {
      toolCalls.push({
        id: stringValue(block.id) ?? `toolu_${randomUUID()}`,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const usage = (payload.usage as JsonRecord | undefined) ?? {};
  const inputTokens =
    (typeof usage.input_tokens === "number" ? usage.input_tokens : 0) +
    (typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0) +
    (typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0);
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const stopReason = String(payload.stop_reason ?? "");
  const message: JsonRecord = { role: "assistant", content: text || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: stringValue(payload.id) ?? `chatcmpl_${randomUUID()}`,
    object: "chat.completion",
    model: stringValue(payload.model) ?? "claude",
    choices: [{
      index: 0,
      message,
      finish_reason:
        toolCalls.length > 0 || stopReason === "tool_use"
          ? "tool_calls"
          : stopReason === "max_tokens"
            ? "length"
            : "stop",
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

export async function fetchAnthropicMessagesCompletion(args: {
  agentConfig: AgentRuntimeAgentConfig;
  accessToken: string;
  openAiBody: JsonRecord;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ status: number; body: JsonRecord }> {
  const response = await (args.fetchImpl ?? fetch)(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "anthropic-version": ANTHROPIC_API_VERSION,
      "anthropic-beta": ANTHROPIC_OAUTH_BETA,
      "User-Agent": "nolo-cli",
    },
    body: JSON.stringify(buildAnthropicMessagesBody(args)),
    signal: args.signal,
  });
  const payload = (await response.json().catch(async () => ({
    error: { message: await response.text().catch(() => response.statusText) },
  }))) as JsonRecord;
  if (!response.ok) return { status: response.status, body: payload };
  return { status: 200, body: mapAnthropicMessageToOpenAi(payload) };
}

export function isAnthropicOAuthAgent(
  agent: Pick<AgentRuntimeAgentConfig, "apiKeyRef">,
): boolean {
  return agent.apiKeyRef?.trim().toLowerCase() === "claude";
}
