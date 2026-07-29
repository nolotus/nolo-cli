// Desktop turn assistant segment management — Redux-free pure helper functions.
//
// Extracted from streamAgentChatTurn desktop local agent runtime processing.
// Provides pure computations to track tool_call IDs on assistant segments,
// resolve full tool_call objects from desktop turnMessages, and select earlier
// finalized segments that require DB persistence.

export interface DesktopAssistantSegment {
  key: string;
  messageId: string;
  content: string;
  finalized: boolean;
  toolCallIds: string[];
}

/**
 * Attaches a tool_call ID to the current (last) assistant segment.
 */
export function attachToolCallIdToSegment(
  segments: DesktopAssistantSegment[],
  callId: string
): void {
  if (!segments || segments.length === 0) return;
  const current = segments[segments.length - 1];
  if (!current.toolCallIds) {
    current.toolCallIds = [];
  }
  current.toolCallIds.push(callId);
}

/**
 * Resolves full tool_call objects from desktop turnMessages for the provided toolCallIds.
 * Returns objects in the order of `toolCallIds`, omitting any that are not found.
 */
export function resolveSegmentToolCalls(
  toolCallIds: string[] | undefined,
  turnMessages?: any[]
): any[] {
  if (
    !toolCallIds ||
    toolCallIds.length === 0 ||
    !Array.isArray(turnMessages) ||
    turnMessages.length === 0
  ) {
    return [];
  }

  const callMap = new Map<string, any>();
  for (const msg of turnMessages) {
    if (Array.isArray(msg?.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc && typeof tc.id === "string") {
          callMap.set(tc.id, tc);
        }
      }
    }
  }

  const resolved: any[] = [];
  for (const id of toolCallIds) {
    const tc = callMap.get(id);
    if (tc) {
      resolved.push(tc);
    }
  }
  return resolved;
}

/**
 * Degraded fallback for stop/error paths that cannot reach the full
 * `streamResult.turnMessages` (the stream broke before `done`, so
 * `desktopTurnMessages` is unavailable). Builds minimal legal tool_call
 * objects from the known callIds plus a callId -> toolName map.
 *
 * `arguments` is `"{}"`, not `""`: the field is a JSON *string* in the OpenAI
 * schema and an empty string does not parse. The real arguments already live
 * in the persisted tool rows; history only needs the owning assistant to
 * declare the ids.
 *
 * The caller MUST pass a map containing only callIds whose tool row is
 * actually being persisted. Ids missing from the map are skipped rather than
 * emitted with a placeholder name — declaring a tool_call whose result row was
 * dropped produces dangling tool_calls, the exact mirror of the orphan-tool
 * bug this path exists to prevent.
 */
export function buildMinimalToolCallsFromIds(
  toolCallIds: string[] | undefined,
  toolNameById: Map<string, string>
): any[] {
  if (!toolCallIds || toolCallIds.length === 0) return [];
  const result: any[] = [];
  for (const id of toolCallIds) {
    // Not in the map = its tool row is not being persisted; declaring it would
    // leave a dangling tool_call.
    if (!toolNameById.has(id)) continue;
    const name = toolNameById.get(id) || "tool";
    result.push({ id, type: "function", function: { name, arguments: "{}" } });
  }
  return result;
}

/**
 * Selects finalized segments that must be persisted to the database.
 * A segment is persistable if it is finalized AND has non-empty content OR
 * tool_calls.
 *
 * Contract: the caller must guarantee the last segment is NOT yet finalized
 * (it is persisted later via messageStreamEnd). This helper returns ALL
 * finalized segments with content or toolCallIds — not only "earlier" ones,
 * despite the historical name.
 */
export function selectPersistableFinalizedSegments(
  segments: DesktopAssistantSegment[]
): DesktopAssistantSegment[] {
  if (!Array.isArray(segments)) return [];
  return segments.filter(
    (segment) =>
      segment.finalized &&
      (segment.content.length > 0 || (segment.toolCallIds && segment.toolCallIds.length > 0))
  );
}
