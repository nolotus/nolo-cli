import { isHiddenOrchestratorToolMessage } from "../toolPresentation";

export const isAssistantToolStub = (msg: any) =>
  msg?.role === "assistant" &&
  (msg.content == null ||
    (typeof msg.content === "string" && msg.content.trim().length === 0) ||
    (Array.isArray(msg.content) && msg.content.length === 0)) &&
  Array.isArray(msg?.tool_calls) &&
  msg.tool_calls.length > 0;

/**
 * Intermediate assistant progress in a tool loop — short narration that is
 * either still binding tool_calls, or is immediately followed by tools.
 * These rows should not offer MessageActions (copy/save/branch); only the
 * real final answer needs them.
 */
export function isIntermediateAssistantProgress(
  entries: Array<{ type: string; message?: any }>,
  index: number
): boolean {
  const entry = entries[index];
  if (!entry || entry.type !== "single" || !entry.message) return false;
  const msg = entry.message;
  if (msg.role !== "assistant") return false;

  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    return true;
  }

  for (let j = index + 1; j < entries.length; j += 1) {
    const next = entries[j];
    if (next.type === "tool-group") return true;
    if (next.type !== "single" || !next.message) continue;
    const role = next.message.role;
    if (role === "tool") return true;
    if (role === "user" || role === "assistant") return false;
  }

  return false;
}

/**
 * True while the agent loop is running and the user has not yet received a
 * visible assistant row (hidden tool stubs do not count as a visible reply).
 */
export function isAwaitingVisibleAssistantReply(
  messages: any[],
  isRunning: boolean
): boolean {
  if (!isRunning || messages.length === 0) return false;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg) continue;
    if (isHiddenOrchestratorToolMessage(msg)) continue;

    if (msg.role === "user") return true;

    if (isAssistantToolStub(msg)) continue;

    return false;
  }

  return false;
}

function hasVisibleAssistantContent(msg: any): boolean {
  if (!msg || msg.role !== "assistant") return false;
  if (isAssistantToolStub(msg)) return false;
  if (isHiddenOrchestratorToolMessage(msg)) return false;
  if (typeof msg.content === "string") return msg.content.trim().length > 0;
  if (Array.isArray(msg.content)) return msg.content.length > 0;
  return false;
}

export type ToolGroupCollapseEntry =
  | { type: "tool-group" }
  | { type: "single"; message: any }
  | { type: string; message?: any };

/**
 * When to auto-collapse a tool group:
 * - Always when a **newer user turn** follows (historical), even if a later
 *   turn is still running — do not re-spin/re-open old batches.
 * - After a **completed** final assistant reply following this group.
 * - Stay open while the final answer after this group is still streaming.
 * - Stay open while this is still the active trailing batch
 *   (`isRunning` / streaming) and nothing after ends the turn.
 * - When the dialog is **idle** with no final reply after tools, collapse so
 *   the UI settles (avoids permanent "running" chrome on stuck turns).
 */
export function shouldAutoCollapseToolGroup(args: {
  entries: ToolGroupCollapseEntry[];
  groupIndex: number;
  isRunning: boolean;
  hasStreamingMessage: boolean;
}): boolean {
  for (let j = args.groupIndex + 1; j < args.entries.length; j += 1) {
    const entry = args.entries[j];
    if (entry.type === "tool-group") {
      // Later tool batch — keep scanning for a user turn or final reply after it.
      continue;
    }
    if (entry.type !== "single" || !entry.message) continue;
    const msg = entry.message;
    if (msg.role === "user") {
      // A newer user turn started; this group is historical.
      return true;
    }
    if (!hasVisibleAssistantContent(msg)) continue;
    // Final answer still streaming — keep tools open.
    if (msg.isStreaming) return false;
    return true;
  }

  // No user / completed final reply after this group yet.
  if (args.isRunning || args.hasStreamingMessage) return false;

  // Turn idle (or stuck without a final answer): fold so status chrome can settle.
  return true;
}
