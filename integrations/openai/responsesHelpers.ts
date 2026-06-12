import type { Message } from "../../app/types";

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

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseFunctionCall
  | ResponseFunctionCallOutput;

export type AssistantToolCall = ToolCall;

const RESPONSES_TOP_LEVEL_SCHEMA_KEYS = ["anyOf", "oneOf", "allOf", "enum", "not"] as const;

const sanitizeResponsesParameters = (parameters: any): any => {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
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

  return tools
    .map((tool) => {
      const fn = tool?.function;
      if (!fn?.name) return null;
      return {
        type: "function",
        name: fn.name,
        description: fn.description,
        parameters: sanitizeResponsesParameters(fn.parameters),
        strict: fn.strict,
      };
    })
    .filter(Boolean);
};

export const convertMessagesToResponsesInput = (
  messages: Array<Pick<Message, "role" | "content" | "tool_calls" | "tool_call_id">>
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
          (part) =>
            part?.type === "image_url" &&
            typeof part.image_url?.url === "string" &&
            part.image_url.url
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

const toDataUrl = (base64Data: string, mimeType?: string | null): string => {
  const normalizedMimeType =
    typeof mimeType === "string" && mimeType.trim()
      ? mimeType.trim()
      : "image/png";
  return `data:${normalizedMimeType};base64,${base64Data}`;
};

export const extractImagePartsFromResponseOutput = (
  response: any
): Array<{ type: "image_url"; image_url: { url: string } }> => {
  const images: Array<{ type: "image_url"; image_url: { url: string } }> = [];

  for (const item of response?.output ?? []) {
    if (item?.type === "image_generation_call") {
      if (typeof item.result === "string" && item.result.trim()) {
        images.push({
          type: "image_url",
          image_url: {
            url: toDataUrl(
              item.result.trim(),
              typeof item.output_format === "string" && item.output_format.trim()
                ? `image/${item.output_format.trim()}`
                : undefined
            ),
          },
        });
      }
      continue;
    }

    if (item?.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (
        content?.type === "output_image" &&
        typeof content.result === "string" &&
        content.result.trim()
      ) {
        images.push({
          type: "image_url",
          image_url: {
            url: toDataUrl(
              content.result.trim(),
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
