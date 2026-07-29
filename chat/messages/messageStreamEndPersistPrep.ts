// Wave20 — pure pre-persist preparation for messageStreamEnd (Redux-free).
//
// Extracted from the `messageStreamEnd` thunk in messageSlice (the inline block
// ~885–918). This function only derives the values that downstream
// `resolveStreamEndFinalMetadata` / `assembleFinalAssistantMessage` consume:
//   - `finalUsageData`        : trimmed usage record (completion_tokens only)
//   - `agentName`             : trimmed agent display name or undefined
//   - `persistedMetadata`     : the inner `metadata` object (or undefined when
//                                the `metadata` key was absent)
//   - `otherPersistedMessageMetadata` : everything else, with the transient
//                                `imageGenerationState` already stripped
//
// It does NOT touch normalize / write / post-write policy / billing / activity
// inference — those remain in their own Wave11/17/18 cores or the thunk.
//
// The thunk still keeps a separate `rawAgentName = asTrimmedString(...)` for
// normalize's upload agentName; that is intentionally a different call site so
// normalize input behavior is unchanged. Here we compute agentName again for
// `assemble`, equivalent to the former second `asTrimmedString(agentConfig?.name)`.

import type { Message } from "./types";
import { asTrimmedString } from "../../core/trimmedString";

export interface PrepareStreamEndPersistInputsInput {
  // Desktop local runtime reports `output_tokens` (mergeTurnUsage in
  // agent-runtime/localLoop.ts normalizes to input_tokens/output_tokens), while
  // the web path forwards the raw OpenAI shape with `completion_tokens`. Accept
  // both or desktop turns persist `usage: null`.
  totalUsage?: {
    completion_tokens?: number | null;
    output_tokens?: number | null;
    // Callers pass whole provider usage records (prompt_tokens, input_tokens,
    // cached tokens, …); only the two fields above are read here.
    [key: string]: unknown;
  } | null;
  agentConfig?: { name?: string | null } | null;
  messageMetadata?: Record<string, unknown> | null;
}

export interface PrepareStreamEndPersistInputsResult {
  finalUsageData: { completion_tokens: number } | undefined;
  agentName: string | undefined;
  persistedMetadata: Record<string, unknown> | undefined;
  otherPersistedMessageMetadata: Partial<Message>;
}

/**
 * Derive the persist inputs for the terminal assistant message at stream end.
 *
 * Rules (verbatim from the former inline thunk logic):
 *   1. `finalUsageData` is `{ completion_tokens }` only when `totalUsage` carries
 *      a non-null `completion_tokens` (web shape) or `output_tokens` (desktop
 *      local-runtime shape); otherwise undefined.
 *   2. `agentName` is `asTrimmedString(agentConfig?.name) || undefined`.
 *   3. From `messageMetadata` (defaulting to `{}`), strip the transient
 *      `imageGenerationState` key.
 *   4. Then split the remainder: the `metadata` key → `persistedMetadata`, and
 *      everything else → `otherPersistedMessageMetadata`.
 *   5. `persistedMetadata` is `undefined` (not an empty object) when the
 *      `metadata` key was not present on the metadata record.
 */
export function prepareStreamEndPersistInputs(
  input: PrepareStreamEndPersistInputsInput,
): PrepareStreamEndPersistInputsResult {
  const { totalUsage, agentConfig, messageMetadata } = input;

  const completionTokens =
    totalUsage?.completion_tokens ?? totalUsage?.output_tokens;
  const finalUsageData =
    totalUsage && completionTokens != null
      ? { completion_tokens: completionTokens }
      : undefined;

  const agentName = asTrimmedString(agentConfig?.name) || undefined;

  const {
    imageGenerationState: _transientImageGenerationState,
    ...persistedMessageMetadata
  } = messageMetadata ?? {};
  const {
    metadata: persistedMetadata,
    ...otherPersistedMessageMetadata
  } = persistedMessageMetadata as Record<string, unknown> & {
    // 从 Record<string, unknown> 解构出来的值类型是 unknown；这里声明 metadata
    // 这一键的实际形状（调用方传的是嵌套 metadata 对象或不传）。
    metadata?: Record<string, unknown>;
  };

  return {
    finalUsageData,
    agentName,
    persistedMetadata,
    otherPersistedMessageMetadata:
      otherPersistedMessageMetadata as Partial<Message>,
  };
}