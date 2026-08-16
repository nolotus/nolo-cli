import {
  convertMessagesToResponsesInput,
  toResponsesTools,
} from "../../../integrations/openai/responsesHelpers";
import { sanitizeForOutbound } from "../../../agent-runtime/outboundHistorySanitize";
import { updateTotalUsage } from "../updateTotalUsage";
import type { ChatWireAdapter, ChatWireAdapterBuildArgs } from "./types";

export const responsesAdapter: ChatWireAdapter = {
  wire: "responses",
  buildRequest(args: ChatWireAdapterBuildArgs): Record<string, unknown> {
    const rawMessages = Array.isArray(args.messages) ? args.messages : [];
    // Sanitize history before converting to Responses input — same seam as
    // completionsAdapter. Without this, /switch replay to a Responses-wire
    // provider (deepseek responses API) can send tool_calls/tool results from
    // a prior model that the target gateway rejects, or orphan tool results
    // with no matching tool_call. sanitizeForOutbound is a pure function that
    // downgrades unpaired/unknown tool_calls to readable text and drops orphan
    // tool results, keeping the history structurally valid for the target.
    const sanitized = sanitizeForOutbound(rawMessages, args.tools);
    const input = convertMessagesToResponsesInput(sanitized);
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
