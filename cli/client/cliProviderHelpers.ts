/**
 * CLI provider agent helpers.
 *
 * Extracted from localRuntimeAdapter.ts. Functions for detecting CLI-provider
 * agents, resolving provider name, and formatting messages (system/task split,
 * image URL collection) for external CLI agents (codex, agy, etc.).
 *
 * No module state — pure transforms.
 */
import type {
  AgentRuntimeAgentConfig,
  AgentRuntimeChatMessage,
} from "../../agent-runtime";
import { buildCliPrompt } from "../../ai/agent/cliPrompt";
import { asRecordOrEmpty } from "../../core/recordOrEmpty";

/**
 * Build the unified task+input content for delegated agent calls.
 *
 * This is the CLI-side copy. The AI tool layer (ai/tools/agent/agentRunDisplayHelpers.ts)
 * has its own identical copy because importing from packages/cli would create
 * a cross-package circular dependency. To fully dedup, this function should be
 * hoisted to packages/core — tracked as follow-up.
 */
export function buildDelegatedTaskContent(task: string, input?: any): string {
  if (input === undefined || input === null) {
    return task;
  }
  if (typeof input === "string") {
    return `${task}\n\n--- INPUT (text) ---\n${input}`;
  }
  const jsonStr = JSON.stringify(input, null, 2);
  return `${task}\n\n--- INPUT (json) ---\n${jsonStr}`;
}

export function parseJsonObject(raw: string) {
  try {
    return asRecordOrEmpty(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

export function isCliProviderAgent(agentConfig: AgentRuntimeAgentConfig) {
  return Boolean(
    agentConfig.apiSource === "cli" ||
      agentConfig.provider === "cli" ||
      agentConfig.cliProvider,
  );
}

export function resolveCliProviderName(agentConfig: AgentRuntimeAgentConfig) {
  return (
    (agentConfig.cliProvider || agentConfig.provider || "codex").trim() ||
    "codex"
  );
}

export function stringifyRuntimeMessageContent(
  content: AgentRuntimeChatMessage["content"],
) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      let text: string;
      if (typeof part === "string") {
        text = part;
      } else if (part && typeof part === "object" && "text" in part) {
        text = String(part.text ?? "");
      } else {
        text = JSON.stringify(part);
      }
      if (text.trim()) parts.push(text);
    }
    return parts.join("\n");
  }
  return content == null ? "" : String(content);
}

export function buildPromptForCliProvider(messages: AgentRuntimeChatMessage[]) {
  const systemParts: string[] = [];
  const taskParts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      const content = stringifyRuntimeMessageContent(message.content).trim();
      if (content) systemParts.push(content);
    } else {
      const content = stringifyRuntimeMessageContent(message.content).trim();
      if (content) {
        taskParts.push(`[${message.role}]\n${content}`);
      }
    }
  }
  const systemPrompt = systemParts.join("\n\n");
  const taskPrompt = taskParts.join("\n\n");
  return buildCliPrompt(systemPrompt, taskPrompt);
}

export function collectCliProviderImageInputs(messages: AgentRuntimeChatMessage[]) {
  const urls: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        part &&
        typeof part === "object" &&
        (part as any).type === "image_url" &&
        typeof (part as any).image_url?.url === "string" &&
        (part as any).image_url.url.trim()
      ) {
        urls.push((part as any).image_url.url.trim());
      }
    }
  }
  return urls;
}