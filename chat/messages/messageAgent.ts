import type { Message } from "./types";

export function resolveMessageAgentKey(
  message: Partial<Message> | null | undefined
): string | undefined {
  if (!message) return undefined;
  return message.agentKey || message.cybotKey;
}
