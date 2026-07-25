// Wave16 — pure policy for initMsgs.fulfilled write mode.
// Encodes the leave/re-enter streaming merge rule (hotfix: avoid wiping a live
// reply with a lagging DB snapshot — "从0").

export type InitMsgsWriteMode = "upsert" | "replace";

/**
 * Decide whether fulfilled history should merge into the local bucket (upsert)
 * or replace it entirely (setAll).
 *
 * - New dialogs: merge so optimistic/stream rows already in memory are kept.
 * - Re-enter while streaming: merge so DB snapshot cannot wipe the live turn.
 * - Otherwise: replace from authoritative fetch.
 */
export function resolveInitMsgsFulfilledWriteMode(input: {
  isNew?: boolean;
  hasLocalStreaming: boolean;
}): InitMsgsWriteMode {
  if (input.isNew || input.hasLocalStreaming) return "upsert";
  return "replace";
}

/** Page-size init: more older pages may exist when the page came back full. */
export function resolveInitMsgsHasMoreOlder(input: {
  limit?: number;
  fetchedCount: number;
}): boolean {
  const { limit, fetchedCount } = input;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    return fetchedCount >= limit;
  }
  return false;
}
