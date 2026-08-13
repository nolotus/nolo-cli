import {
  toOpenAiCompatibleMessages,
  shouldStripReasoningContentForOutbound,
} from "../../../agent-runtime/openAiCompatibleMessages";
import { updateTotalUsage } from "../updateTotalUsage";
import type { ChatWireAdapter, ChatWireAdapterBuildArgs } from "./types";

export const completionsAdapter: ChatWireAdapter = {
  wire: "completions",
  buildRequest(args: ChatWireAdapterBuildArgs): Record<string, unknown> {
    const provider = args.agent?.provider;
    const model = args.agent?.model;
    const stripReasoningContent = shouldStripReasoningContentForOutbound(provider, model);
    const rawMessages = Array.isArray(args.messages) ? args.messages : [];
    const messages = toOpenAiCompatibleMessages(rawMessages, { stripReasoningContent });
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: args.options?.stream ?? true,
    };
    if (args.tools && args.tools.length > 0) {
      body.tools = args.tools;
    }
    return body;
  },
  normalizeUsage(raw: unknown): any | null {
    if (!raw) return null;
    const usageChunk = (raw as any)?.usage ?? raw;
    return updateTotalUsage(null, usageChunk as any);
  },
};
