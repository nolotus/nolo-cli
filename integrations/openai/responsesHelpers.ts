import type { Message } from "../../app/types";
import { isRecord } from "../../core/isRecord";
import { asOptionalTrimmedString } from "../../core/optionalString";

type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ResponseInputTextPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string };
type ResponseInputImagePart = {
  type: "input_image";
  image_url: string;
  detail?: "low" | "high" | "auto";
};

type ResponseInputMessage = {
  type: "message";
  role: "system" | "developer" | "user" | "assistant";
  content: Array<ResponseInputTextPart | ResponseInputImagePart>;
};

type ResponseFunctionCall = {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
};

type ResponseFunctionCallOutput = {
  type: "function_call_output";
  call_id: string;
  output: string;
};
type ResponseReasoning = {
  type: "reasoning";
  content: Array<{ type: "reasoning_text"; text: string }>;
};

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseFunctionCall
  | ResponseFunctionCallOutput
  | ResponseReasoning;

export type AssistantToolCall = ToolCall;

const RESPONSES_TOP_LEVEL_SCHEMA_KEYS = ["anyOf", "oneOf", "allOf", "enum", "not"] as const;

const sanitizeResponsesParameters = (parameters: any): any => {
  if (!isRecord(parameters)) {
    return parameters;
  }

  const next = { ...parameters };
  for (const key of RESPONSES_TOP_LEVEL_SCHEMA_KEYS) {
    delete next[key];
  }
  return next;
};

const appendTextPart = (
  parts: Array<ResponseInputTextPart | ResponseInputImagePart>,
  text: string,
  role: "system" | "developer" | "user" | "assistant"
) => {
  if (!text) return;
  const last = parts.at(-1);
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (last?.type === textType) {
    last.text += text;
    return;
  }
  parts.push({ type: textType, text });
};

const normalizeMessageParts = (
  content: Message["content"],
  role: "system" | "developer" | "user" | "assistant"
): Array<ResponseInputTextPart | ResponseInputImagePart> => {
  if (typeof content === "string") {
    if (!content) return [];
    return [
      {
        type: role === "assistant" ? "output_text" : "input_text",
        text: content,
      },
    ];
  }

  const parts: Array<ResponseInputTextPart | ResponseInputImagePart> = [];
  for (const part of content ?? []) {
    const typedPart = part as MessageContentPart;
    if (typedPart?.type === "text" && typeof typedPart.text === "string") {
      appendTextPart(parts, typedPart.text, role);
      continue;
    }

    if (
      typedPart?.type === "image_url" &&
      typeof typedPart.image_url?.url === "string" &&
      typedPart.image_url.url
    ) {
      if (role === "assistant") continue;
      parts.push({
        type: "input_image",
        image_url: typedPart.image_url.url,
        detail: typedPart.image_url.detail,
      });
    }
  }

  return parts;
};

const normalizeToolOutput = (content: Message["content"]): string => {
  if (typeof content === "string") return content;
  return JSON.stringify(content ?? "");
};

export const toResponsesTools = (tools: any[] | undefined): any[] | undefined => {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  const normalized = tools
    .map((tool) => {
      // Accept both OpenAI Chat Completions tools and already-normalized
      // Responses tools. The chat proxy may receive either shape depending on
      // whether the caller has already selected its target wire.
      const fn = tool?.function;
      const name = fn?.name ?? tool?.name;
      if (!name) return null;
      const parameters = fn?.parameters ?? tool?.parameters;
      return {
        type: "function",
        name,
        ...(typeof (fn?.description ?? tool?.description) === "string"
          ? { description: fn?.description ?? tool?.description }
          : {}),
        parameters: sanitizeResponsesParameters(parameters),
        ...(fn?.strict !== undefined || tool?.strict !== undefined
          ? { strict: fn?.strict ?? tool?.strict }
          : {}),
      };
    })
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
};

export const convertMessagesToResponsesInput = (
  messages: Array<Pick<Message, "role" | "content" | "tool_calls" | "tool_call_id"> & { reasoning_content?: unknown }>,
  options?: { stripReasoningContent?: boolean },
): ResponseInputItem[] => {
  const input: ResponseInputItem[] = [];

  for (const message of messages) {
    if (!message?.role) continue;

    if (message.role === "tool") {
      if (!message.tool_call_id) continue;
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: normalizeToolOutput(message.content),
      });
      continue;
    }

    const role = message.role as ResponseInputMessage["role"];
    if (
      role === "assistant" &&
      !options?.stripReasoningContent &&
      typeof message.reasoning_content === "string" &&
      message.reasoning_content
    ) {
      // 数组 content（reasoning_text parts）是 OpenAI 官方与 DeepSeek 官方
      // Responses API 都接受的格式；字符串 content 会被 DeepSeek 拒绝
      // （serde "expected a sequence"，实测 400）。
      input.push({
        type: "reasoning",
        content: [
          { type: "reasoning_text", text: message.reasoning_content },
        ],
      });
    }
    const contentParts = normalizeMessageParts(message.content, role);
    if (contentParts.length > 0) {
      input.push({
        type: "message",
        role,
        content: contentParts,
      });
    }

    if (role === "assistant" && Array.isArray(message.content)) {
      const replayImages = message.content
        .map((part) => part as MessageContentPart)
        .filter(
          (part): part is Extract<MessageContentPart, { type: "image_url" }> =>
            part?.type === "image_url" &&
            typeof part.image_url?.url === "string" &&
            Boolean(part.image_url.url)
        )
        .map((part) => ({
          type: "input_image" as const,
          image_url: part.image_url.url,
          detail: part.image_url.detail,
        }));

      if (replayImages.length > 0) {
        input.push({
          type: "message",
          role: "user",
          content: replayImages,
        });
      }
    }

    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls as ToolCall[]) {
        if (!toolCall?.id || !toolCall.function?.name) continue;
        input.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments:
            typeof toolCall.function.arguments === "string"
              ? toolCall.function.arguments
              : JSON.stringify(toolCall.function.arguments ?? {}),
        });
      }
    }
  }

  return input;
};

export const extractTextFromResponseOutput = (response: any): string => {
  const parts: string[] = [];
  for (const item of response?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("");
};

export const extractReasoningFromResponseOutput = (response: any): string => {
  const parts: string[] = [];
  for (const item of response?.output ?? []) {
    if (item?.type !== "reasoning") continue;
    if (typeof item.content === "string") {
      parts.push(item.content);
      continue;
    }
    for (const content of item.content ?? []) {
      if (typeof content === "string") parts.push(content);
      else if (typeof content?.text === "string") parts.push(content.text);
    }
  }
  return parts.join("");
};

const toDataUrl = (base64Data: string, mimeType?: string | null): string => {
  const normalizedMimeType = asOptionalTrimmedString(mimeType) ?? "image/png";
  return `data:${normalizedMimeType};base64,${base64Data}`;
};

export const extractImagePartsFromResponseOutput = (
  response: any
): Array<{ type: "image_url"; image_url: { url: string } }> => {
  const images: Array<{ type: "image_url"; image_url: { url: string } }> = [];

  for (const item of response?.output ?? []) {
    if (item?.type === "image_generation_call") {
      const result = asOptionalTrimmedString(item.result);
      if (result) {
        const outputFormat = asOptionalTrimmedString(item.output_format);
        images.push({
          type: "image_url",
          image_url: {
            url: toDataUrl(
              result,
              outputFormat ? `image/${outputFormat}` : undefined
            ),
          },
        });
      }
      continue;
    }

    if (item?.type !== "message") continue;
    for (const content of item.content ?? []) {
      const result = asOptionalTrimmedString(content?.result);
      if (content?.type === "output_image" && result) {
        images.push({
          type: "image_url",
          image_url: {
            url: toDataUrl(
              result,
              content.mime_type ?? content.mimeType ?? null
            ),
          },
        });
      }
    }
  }

  return images;
};

export const extractToolCallsFromResponseOutput = (
  response: any
): AssistantToolCall[] => {
  const calls: AssistantToolCall[] = [];
  for (const item of response?.output ?? []) {
    if (item?.type !== "function_call") continue;
    if (!item.call_id || !item.name) continue;
    calls.push({
      id: item.call_id,
      type: "function",
      function: {
        name: item.name,
        arguments:
          typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments ?? {}),
      },
    });
  }
  return calls;
};

/**
 * Inverse of {@link convertMessagesToResponsesInput}: turn a Responses-wire
 * `input` array back into chat.completions `messages`.
 *
 * Needed because the *client* picks the wire format from its own model→wire
 * table while the *server* picks the upstream endpoint. When a hosted model
 * switches provider (e.g. DeepSeek V4 Flash: official Responses ↔ DeepInfra
 * chat.completions) the two sides disagree for the duration of the rollout
 * skew, and a client on the Responses wire would otherwise send a body with
 * `input` but no `messages` to a chat.completions upstream — which rejects it
 * (`Field required`, HTTP 422).
 *
 * Mapping (mirror of the forward converter):
 *   message              → { role, content }            (parts flattened to text/image_url)
 *   function_call        → assistant.tool_calls[]       (consecutive calls coalesce)
 *   function_call_output → { role: "tool", tool_call_id }
 *   reasoning            → dropped (not representable on the completions wire)
 */
export const convertResponsesInputToMessages = (
  input: readonly any[],
): Array<Record<string, any>> => {
  const messages: Array<Record<string, any>> = [];

  for (const item of input ?? []) {
    if (!isRecord(item)) continue;

    if (item.type === "function_call_output") {
      const callId = asOptionalTrimmedString(item.call_id);
      if (!callId) continue;
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
      continue;
    }

    if (item.type === "function_call") {
      const callId = asOptionalTrimmedString(item.call_id);
      const name = asOptionalTrimmedString(item.name);
      if (!callId || !name) continue;
      const toolCall = {
        id: callId,
        type: "function" as const,
        function: {
          name,
          arguments:
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
        },
      };
      // Coalesce runs of function_call items onto one assistant message, the
      // shape the completions wire expects.
      const last = messages.at(-1);
      if (last?.role === "assistant" && Array.isArray(last.tool_calls)) {
        last.tool_calls.push(toolCall);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      }
      continue;
    }

    // `reasoning` has no completions-wire equivalent: dropping it is what the
    // forward path already does when stripReasoningContent is set.
    if (item.type === "reasoning") continue;

    if (item.type !== "message" && item.role === undefined) continue;

    const role = asOptionalTrimmedString(item.role);
    if (!role) continue;

    if (typeof item.content === "string") {
      messages.push({ role, content: item.content });
      continue;
    }

    const textChunks: string[] = [];
    const parts: Array<Record<string, any>> = [];
    for (const part of item.content ?? []) {
      if (!isRecord(part)) continue;
      if (part.type === "input_text" || part.type === "output_text") {
        const text = typeof part.text === "string" ? part.text : "";
        if (!text) continue;
        textChunks.push(text);
        parts.push({ type: "text", text });
        continue;
      }
      if (part.type === "input_image") {
        // The Responses wire carries a bare `image_url` string, but tolerate the
        // completions-style `{ image_url: { url } }` nesting so a mismatched
        // client cannot make images vanish silently.
        const rawUrl = isRecord(part.image_url) ? part.image_url.url : part.image_url;
        const url = asOptionalTrimmedString(rawUrl);
        if (!url) continue;
        parts.push({
          type: "image_url",
          image_url: { url, ...(part.detail ? { detail: part.detail } : {}) },
        });
      }
    }

    if (parts.length === 0) continue;
    // Text-only content collapses to a plain string (widest provider support);
    // mixed content keeps the parts array.
    const hasImage = parts.some((part) => part.type === "image_url");
    messages.push({ role, content: hasImage ? parts : textChunks.join("") });
  }

  return messages;
};

/**
 * Inverse of {@link toResponsesTools}: turn Responses-wire tool declarations
 * back into the chat.completions shape.
 *
 * The two wires nest differently:
 *   Responses         { type: "function", name, parameters }
 *   chat.completions  { type: "function", function: { name, parameters } }
 *
 * Sending the flat form to a chat.completions upstream fails its tool union
 * validation — DeepInfra reports `Input should be 'web_search'`, naming an
 * unrelated built-in tool variant, which makes the real cause hard to see.
 *
 * Built-in Responses tools (web_search, file_search, …) have no
 * chat.completions equivalent and are dropped rather than forwarded broken.
 */
export const convertResponsesToolsToChatCompletions = (
  tools: readonly any[],
): Array<Record<string, any>> => {
  const out: Array<Record<string, any>> = [];
  for (const tool of tools ?? []) {
    if (!isRecord(tool)) continue;
    // Already in chat.completions shape — keep as is.
    if (isRecord(tool.function)) {
      out.push(tool as Record<string, any>);
      continue;
    }
    if (tool.type !== "function") continue;
    const name = asOptionalTrimmedString(tool.name);
    if (!name) continue;
    out.push({
      type: "function",
      function: {
        name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
      },
    });
  }
  return out;
};
