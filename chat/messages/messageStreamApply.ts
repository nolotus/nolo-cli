// Wave11 — pure core for assembling a streaming-message upsert payload.
//
// This mirrors the legacy `messageStreaming` reducer in messageSlice:
//
//   upsertOneMessage(dialogState, {
//     isStreaming: true,
//     content: "",
//     thinkContent: "",
//     ...messageChunk,
//   })
//
// i.e. start from the fixed streaming defaults (`isStreaming: true`, empty
// content/think), then let the chunk overwrite on top. Entity-adapter
// `upsertOne` is a whole-object REPLACE (not a field merge), so the legacy
// reducer did NOT preserve any fields from the existing record — the new
// object simply replaced it. This helper reproduces that exact behaviour:
// `existing` is accepted in the signature for future use but intentionally
// NOT merged, matching `upsertOneMessage(dialogState, { isStreaming:true,
// content:"", thinkContent:"", ...message })`.
//
// Keeping this logic in a Redux-free core lets non-Redux hosts (TUI / CLI /
// server) build the same streaming message shape without dispatching.

import type { Message } from "./types";

/**
 * Build the streaming-message upsert payload for `messageStreaming`.
 *
 * The chunk is whatever the stream producer emitted (the fields of
 * `DialogScopedStreamingMessage` minus `dialogId`). It is applied on top of
 * the fixed streaming defaults (`isStreaming: true`, empty content/think),
 * so `isStreaming` stays `true` regardless of whether the chunk carries it.
 *
 * @param existing Optional previous message record. The legacy entity-adapter
 *   upsert REPLACED the whole record (no field merge), so existing fields were
 *   dropped on every streaming chunk. This helper intentionally does NOT merge
 *   `existing`; callers that need to preserve prior fields must spread them
 *   into `chunk` themselves. Returning a standalone payload keeps the semantics
 *   identical to the old inline upsert call.
 */
export function applyMessageStreamingUpsert(
  existing: Message | undefined,
  chunk: Partial<Message> & { id: string },
): Message {
  void existing; // entity-adapter upsert = whole-object replace, not merge

  const merged = {
    isStreaming: true,
    content: "",
    thinkContent: "",
    ...chunk,
  } as Message;

  // isStreaming is authoritative for streaming upserts; never let a chunk turn
  // it off mid-stream (the old reducer hard-coded it true).
  merged.isStreaming = true;

  return merged;
}