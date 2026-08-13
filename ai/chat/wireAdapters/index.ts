import type { ChatWire, ChatWireAdapter } from "./types";
import { resolveChatWire, type ResolveChatWireInput } from "./resolveChatWire";
import { responsesAdapter } from "./responsesAdapter";
import { completionsAdapter } from "./completionsAdapter";

// NOTE: anthropicAdapter / codexAdapter are intentionally NOT statically
// imported here. They transitively import `node:crypto`
// (anthropicMessagesProvider.ts / codexResponsesProvider.ts), which breaks
// the browser web build (esbuild "Could not resolve node:crypto"). They are
// registered at runtime by node-side entry points (desktop/server) via
// registerChatWireAdapter.

export * from "./types";
export * from "./resolveChatWire";
export { responsesAdapter } from "./responsesAdapter";
export { completionsAdapter } from "./completionsAdapter";

/** Browser-safe defaults; anthropic/codex must be registered at runtime. */
const registeredAdapters: Partial<Record<ChatWire, ChatWireAdapter>> = {
  responses: responsesAdapter,
  completions: completionsAdapter,
};

/** Live view of the registry (anthropic/codex appear after registration). */
export const chatWireAdapters = registeredAdapters;

/** Node-side entry points register anthropic/codex (they pull node:crypto). */
export function registerChatWireAdapter(
  wire: ChatWire,
  adapter: ChatWireAdapter,
): void {
  if (!adapter || adapter.wire !== wire) {
    throw new Error(
      `registerChatWireAdapter: adapter.wire (${adapter?.wire}) !== wire (${wire})`,
    );
  }
  registeredAdapters[wire] = adapter;
}

export function getChatWireAdapter(wire: ChatWire): ChatWireAdapter {
  const adapter = registeredAdapters[wire];
  if (!adapter) {
    throw new Error(
      `Unknown ChatWire adapter: ${wire}. ` +
        `Register it via registerChatWireAdapter from a node-side entry point.`,
    );
  }
  return adapter;
}

export function resolveChatAdapter(agentOrInput?: ResolveChatWireInput | null): ChatWireAdapter {
  const wire = resolveChatWire(agentOrInput);
  return getChatWireAdapter(wire);
}
