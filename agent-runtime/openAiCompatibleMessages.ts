/**
 * Pure chat-message shaping for OpenAI-compatible request bodies.
 *
 * Locality: one seam for "runtime chat message → completions message" so
 * openAiCompatibleProvider and platformChatProvider cannot drift on optional
 * tool_call_id / tool_calls / reasoning_content passthrough.
 */
import type { AgentRuntimeChatMessage } from "./types";

export type OpenAiCompatibleRequestMessage = {
  role: AgentRuntimeChatMessage["role"];
  content: NonNullable<AgentRuntimeChatMessage["content"]> | "";
  tool_call_id?: string;
  tool_calls?: AgentRuntimeChatMessage["tool_calls"];
  reasoning_content?: string;
};

export function toOpenAiCompatibleMessages(
  messages: AgentRuntimeChatMessage[],
): OpenAiCompatibleRequestMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content ?? "",
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
    ...(message.reasoning_content
      ? { reasoning_content: message.reasoning_content }
      : {}),
  }));
}
