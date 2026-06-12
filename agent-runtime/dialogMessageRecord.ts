import type { AgentRuntimeChatMessage } from "./types";

type DialogMessageRecord = Record<string, any>;

export function dialogMessageRecordToAgentRuntimeMessage(
  record: DialogMessageRecord
): AgentRuntimeChatMessage | null {
  if (!record || typeof record !== "object") return null;
  if (record.role !== "user" && record.role !== "assistant" && record.role !== "tool") return null;
  return {
    role: record.role,
    content: record.content ?? null,
    ...(typeof record.toolCallId === "string" ? { tool_call_id: record.toolCallId } : {}),
    ...(Array.isArray(record.tool_calls) ? { tool_calls: record.tool_calls } : {}),
  };
}
