/**
 * Pure chat-message shaping for OpenAI-compatible request bodies.
 *
 * Locality: one seam for "runtime chat message → completions message" so
 * openAiCompatibleProvider and platformChatProvider cannot drift on optional
 * tool_call_id / tool_calls / reasoning_content passthrough.
 */
import type { AgentRuntimeChatMessage } from "./types";

type AgentStateMessageLike = {
  role?: unknown;
  reasoning_content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  toolCallId?: unknown;
};

export type OpenAiCompatibleRequestMessage = {
  role: AgentRuntimeChatMessage["role"];
  content: NonNullable<AgentRuntimeChatMessage["content"]> | "";
  tool_call_id?: string;
  tool_calls?: AgentRuntimeChatMessage["tool_calls"];
  reasoning_content?: string;
};

/**
 * Copy only provider-visible agent state. Keeping this in one seam prevents
 * the Chat Completions, server loop, and provider adapters from disagreeing
 * about empty reasoning or tool-call identifiers.
 */
export function preserveAgentStateFields<T extends Record<string, any>>(
  source: AgentStateMessageLike,
  target: T,
): T {
  const mutableTarget = target as Record<string, any>;
  if (source.role === "assistant") {
    if (typeof source.reasoning_content === "string") {
      mutableTarget.reasoning_content = source.reasoning_content;
    }
    if (Array.isArray(source.tool_calls)) {
      mutableTarget.tool_calls = source.tool_calls;
    }
  }
  if (source.role === "tool") {
    const toolCallId =
      typeof source.tool_call_id === "string"
        ? source.tool_call_id.trim()
        : typeof source.toolCallId === "string"
          ? source.toolCallId.trim()
          : "";
    if (toolCallId) mutableTarget.tool_call_id = toolCallId;
  }
  return target;
}

export function findAgentStatePairingIssues(
  messages: AgentStateMessageLike[],
): string[] {
  const issues: string[] = [];
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls as Array<Record<string, any>>) {
        const id = typeof call?.id === "string" ? call.id.trim() : "";
        if (!id) {
          issues.push("assistant tool call is missing id");
        } else if (callIds.has(id)) {
          issues.push(`duplicate assistant tool call id: ${id}`);
        } else {
          callIds.add(id);
        }
      }
    }
    if (message.role === "tool") {
      const id = typeof message.tool_call_id === "string"
        ? message.tool_call_id.trim()
        : typeof message.toolCallId === "string"
          ? message.toolCallId.trim()
          : "";
      if (!id) {
        issues.push("tool result is missing tool_call_id");
      } else if (resultIds.has(id)) {
        issues.push(`duplicate tool result id: ${id}`);
      } else {
        resultIds.add(id);
        if (!callIds.has(id)) issues.push(`orphan tool result id: ${id}`);
      }
    }
  }
  for (const id of callIds) {
    if (!resultIds.has(id)) issues.push(`missing tool result id: ${id}`);
  }
  return issues;
}

export function toOpenAiCompatibleMessages(
  messages: AgentRuntimeChatMessage[],
): OpenAiCompatibleRequestMessage[] {
  return messages.map((message) =>
    preserveAgentStateFields(message, {
      role: message.role,
      content: message.content ?? "",
    }),
  );
}
