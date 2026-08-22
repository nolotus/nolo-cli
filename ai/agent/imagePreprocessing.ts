// packages/ai/agent/imagePreprocessing.ts
//
// 纯文本模型收到图片时的图像输入兜底：模型不支持图片输入时，直接剥离 image_url
// part（替换为占位文本），防止上游 400。
//
// 此前这里是「用 Qwen 3.7 Flash 把图片描述成文字」的 vision 预处理管道；默认模型
// 切到 deepseek flash vision（原生支持图片）后，该预处理已不再需要，仅保留剥离兜底。

import type { AgentRuntimeChatMessage, AgentRuntimeMessageContent } from "../../agent-runtime/types";
import { resolveAgentImageInputSupport } from "../llm/agentCapabilities";

/**
 * 从消息数组中提取所有 image_url 的 url。
 */
export function extractImageUrlsFromMessages(messages: AgentRuntimeChatMessage[]): string[] {
  const urls: string[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (
        part &&
        typeof part === "object" &&
        part.type === "image_url" &&
        part.image_url &&
        typeof part.image_url.url === "string" &&
        part.image_url.url.trim()
      ) {
        urls.push(part.image_url.url);
      }
    }
  }
  return urls;
}

/**
 * 判断消息数组中是否包含 image_url part。
 */
export function hasImageInRuntimeMessages(messages: AgentRuntimeChatMessage[]): boolean {
  return extractImageUrlsFromMessages(messages).length > 0;
}

/**
 * 剥离单条消息 content 里的 image_url parts。模型不支持图片输入时，发上去会 400
 * "this model does not support image input"。对 local runtime 而言，这会把本可成功的轮
 * 判成失败、fallback 到 server——而 server 端没有 local code 工具，agent 报 blocker。
 * 过滤后如果为空则返回占位文本（不是 ""），因为主流 Provider API 要求 user 消息
 * content 非空，空串会触发 400 "content is required and must be non-empty"。
 */
export const IMAGE_OMITTED_PLACEHOLDER =
  "[Image content omitted: model does not support image input]";

export function stripImagePartsFromContent(
  content: AgentRuntimeMessageContent,
): AgentRuntimeMessageContent {
  if (!Array.isArray(content)) return content;
  const filtered = content.filter((part) => part?.type !== "image_url");
  if (filtered.length === 0) return IMAGE_OMITTED_PLACEHOLDER;
  return filtered as AgentRuntimeMessageContent;
}

export function stripImagePartsFromMessages<T extends { content: unknown }>(
  messages: T[],
): T[] {
  return messages.map((msg) => ({
    ...msg,
    content: stripImagePartsFromContent(msg.content as AgentRuntimeMessageContent),
  }));
}

/**
 * Web / Desktop / RN stream 路径的图片输入兜底。
 *
 * 用于 streamAgentChatTurn.ts 中 Responses API 和 chat.completions 两条路径，
 * 泛型 T 携带消息的额外字段（id / dbKey 等），本函数只操作 content，
 * 不触碰其他字段。
 *
 * 行为：
 * - 模型支持 vision 或无图片：原样返回
 * - 模型不支持 vision 且有图片：剥离 image_url part 并替换为占位文本，
 *   绝不报错中断用户的会话。
 */
export async function stripImagePartsForTextOnlyAgent<T extends { id?: unknown; content: unknown }>(
  messages: T[],
  agentConfig: unknown,
): Promise<{ messages: T[] }> {
  const supportsVision = resolveAgentImageInputSupport(agentConfig as any);
  const hasImages = hasImageInRuntimeMessages(messages as unknown as AgentRuntimeChatMessage[]);
  return { messages: !supportsVision && hasImages ? stripImagePartsFromMessages(messages) : messages };
}
