/**
 * TUI summary LLM caller — builds a function that calls the Nolo platform
 * chat proxy to generate dialog compression summaries.
 *
 * Mirrors the pattern from `generateLocalDialogTitle` (dialogTitleLlm.ts):
 * resolve platform chat provider config → build request → fetch → parse.
 * Uses BUILTIN_SUMMARY_LLM_CONFIG (deepseek-v4-flash) as the summary model.
 *
 * Returns null on any failure (no auth, network error, parse error) so
 * `compactDialog` can degrade to fork-only behavior.
 */

import {
  resolvePlatformChatProviderConfig,
  buildPlatformChatCompletionRequest,
  parsePlatformChatCompletionResponse,
  canUsePlatformChatProvider,
} from "../agent-runtime/platformChatProvider";
import { COMPACTION_SUMMARY_SYSTEM_PROMPT } from "../ai/context/compactionShared";
import { BUILTIN_SUMMARY_LLM_CONFIG } from "../chat/dialog/actions/builtinDialogLlm";
import type { AgentRuntimeChatMessage, EnvLike } from "../agent-runtime/types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Create a summary LLM caller for TUI /compact.
 *
 * Production: uses global fetch + env-based provider config resolution.
 * Tests: inject fetchImpl and mock dependencies.
 */
export function createTuiSummaryLlmCaller(
  env: EnvLike,
  options?: {
    fetchImpl?: FetchLike;
    apiKeyRefResolver?: any;
    credentialBroker?: any;
    timeoutMs?: number;
  }
): (content: string) => Promise<string | null> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 30_000;

  return async (content: string): Promise<string | null> => {
    if (!canUsePlatformChatProvider(env)) {
      return null;
    }

    try {
      const providerConfig = await resolvePlatformChatProviderConfig({
        agentConfig: { ...BUILTIN_SUMMARY_LLM_CONFIG, key: BUILTIN_SUMMARY_LLM_CONFIG.id },
        env,
        apiKeyRefResolver: options?.apiKeyRefResolver,
        credentialBroker: options?.credentialBroker,
      });

      if (!providerConfig?.authToken) {
        return null;
      }

      const messages: AgentRuntimeChatMessage[] = [
        { role: "system", content: COMPACTION_SUMMARY_SYSTEM_PROMPT },
        { role: "user", content },
      ];

      const request = buildPlatformChatCompletionRequest({
        providerConfig,
        messages,
        stream: false,
      });

      const response = await fetchImpl(request.url, {
        ...request.init,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        return null;
      }

      const raw = await response.text().catch(() => "");
      const data = safeParseJson(raw);
      if (!data) return null;

      const parsed = parsePlatformChatCompletionResponse({
        providerConfig,
        data,
        trace: [],
      });

      return parsed?.content?.trim() || null;
    } catch {
      return null;
    }
  };
}

function safeParseJson(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
