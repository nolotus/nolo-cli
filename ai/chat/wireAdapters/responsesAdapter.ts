import {
  convertMessagesToResponsesInput,
  toResponsesTools,
} from "../../../integrations/openai/responsesHelpers";
import { updateTotalUsage } from "../updateTotalUsage";
import type { ChatWireAdapter, ChatWireAdapterBuildArgs } from "./types";

export const responsesAdapter: ChatWireAdapter = {
  wire: "responses",
  buildRequest(args: ChatWireAdapterBuildArgs): Record<string, unknown> {
    const rawMessages = Array.isArray(args.messages) ? args.messages : [];
    const input = convertMessagesToResponsesInput(rawMessages);
    const body: Record<string, unknown> = {
      model: args.agent?.model,
      input,
      stream: args.options?.stream ?? true,
    };
    if (args.tools && args.tools.length > 0) {
      const tools = toResponsesTools(args.tools);
      if (tools && tools.length > 0) {
        body.tools = tools;
      }
    }
    return body;
  },
  normalizeUsage(raw: unknown): any | null {
    if (!raw) return null;
    const usageChunk = (raw as any)?.usage ?? raw;
    return updateTotalUsage(null, usageChunk as any);
  },
};
