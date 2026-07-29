// Wave18 — pure final-metadata decision for messageStreamEnd (Redux-free).

import { inferAssistantActivityCompletionMetadata } from "./activityCompletion";

/**
 * Resolve the final assistant message metadata after the terminal write.
 *
 * Rules (extracted verbatim from the messageStreamEnd thunk):
 * - If `persistedMetadata.activity` already exists, do not infer.
 * - If there are tool calls (length > 0), do not infer.
 * - Otherwise call `inferAssistantActivityCompletionMetadata` over the
 *   current message set + final content; when it returns a result, merge it
 *   over the persisted metadata; otherwise keep the persisted metadata.
 */
export function resolveStreamEndFinalMetadata(input: {
  persistedMetadata?: Record<string, unknown> | null;
  toolCalls?: unknown[] | null;
  messages: unknown[];
  /**
   * Message.content 原样转发给 inferAssistantActivityCompletionMetadata，
   * 后者声明 `finalContent: unknown` 并用 serializeMessageContent 归一化
   * （string 直接用、OpenAI 风格数组拼接 text 片段、image_url 换占位符）。
   * 这里以前写死成 string，比真实契约窄——多模态消息的 content 是数组。
   */
  finalContent: unknown;
}): { finalMetadata: Record<string, unknown> | undefined } {
  const { persistedMetadata, toolCalls, messages, finalContent } = input;
  const shouldInfer =
    !(persistedMetadata as Record<string, unknown> | undefined)?.activity &&
    (!toolCalls || toolCalls.length === 0);
  const inferred = shouldInfer
    ? inferAssistantActivityCompletionMetadata({
        messages: messages as any,
        finalContent,
      })
    : undefined;
  // persistedMetadata 允许传 null；对下游 assembleFinalAssistantMessage 而言
  // null 与 undefined 等价（都走 `finalMetadata ? {metadata} : {}` 的假分支），
  // 这里统一收敛成 undefined，让返回类型与实际契约一致。
  const finalMetadata = inferred
    ? { ...(persistedMetadata ?? {}), ...inferred }
    : (persistedMetadata ?? undefined);
  return { finalMetadata };
}