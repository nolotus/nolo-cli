import type { AgentRuntimeChatMessage } from "./types";

type DialogMessageRecord = Record<string, any>;

export function dialogMessageRecordToAgentRuntimeMessage(
  record: DialogMessageRecord
): AgentRuntimeChatMessage | null {
  if (!record || typeof record !== "object") return null;
  if (record.role !== "user" && record.role !== "assistant" && record.role !== "tool") return null;
  return {
    role: record.role,
    content: record.content ?? "",
    ...(record.contextReference !== undefined
      ? { context_reference: record.contextReference }
      : {}),
    ...(typeof record.reasoning_content === "string"
      ? { reasoning_content: record.reasoning_content }
      : {}),
    ...(typeof record.toolCallId === "string" ? { tool_call_id: record.toolCallId } : {}),
    ...(Array.isArray(record.tool_calls) ? { tool_calls: record.tool_calls } : {}),
    ...(typeof record.toolName === "string" ? { toolName: record.toolName } : {}),
    ...(() => {
      const raw = record.createdAt;
      const ms =
        typeof raw === "number"
          ? raw
          : typeof raw === "string"
            ? Date.parse(raw)
            : NaN;
      return Number.isFinite(ms) ? { createdAt: ms } : {};
    })(),
  };
}
