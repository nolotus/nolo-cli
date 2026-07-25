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
  finalContent: string;
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
  const finalMetadata = inferred
    ? { ...(persistedMetadata ?? {}), ...inferred }
    : persistedMetadata;
  return { finalMetadata };
}