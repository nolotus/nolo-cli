/**
 * Provider-level transient-failure retry for the CLI local runtime.
 *
 * Why this exists: `fetchWithTransientRetry` only covers the fetch exchange up
 * to the response headers. When the upstream dies MID-STREAM (SSE body read
 * via readPlatformChatSseCompletion, or `res.text()` on non-streaming
 * paths), the error is thrown from provider code AFTER the retry wrapper has
 * already returned — one transient socket kill therefore failed the whole
 * agent turn with "The socket connection was closed unexpectedly". This
 * wrapper moves the retry boundary up to the whole `provider.complete` call
 * so stream-stage deaths self-heal too. Reproduced live in
 * providerStreamRetry.test.ts (real HTTP server, socket.destroy() mid-SSE).
 *
 * Display contract (agentRunOutput): streamed assistant text is append-only
 * and `finish()` renders the full content only when NO text was ever
 * streamed. Therefore:
 * - failed attempt forwarded 0 deltas → silent retry; the successful attempt
 *   streams normally and finish() keeps working on `everStreamedAnyText`.
 * - failed attempt forwarded >0 deltas → emit one bracketed marker through
 *   onTextDelta, then retry with normal delta forwarding. The visible
 *   transcript shows partial + marker + full regenerated text: complete
 *   content, bounded duplication, explicitly explained.
 *
 * Retry policy (deliberate tradeoffs):
 * - ONE retry only. A retry is a fresh provider call, so the failed
 *   attempt's partial generation can be billed upstream (the server records
 *   it with status=failed via wrapUpstreamWithCancelFlush). This matches the
 *   product call that a self-healing turn is worth one bounded regeneration
 *   — same posture as fetchWithTransientRetry, whose retries re-issue the
 *   whole request too.
 * - NO retry once the failed attempt emitted a mid-stream tool event
 *   (onToolEvent): those are real side effects (Cursor's inline exec) and
 *   replaying them would duplicate tool execution/cards. Text-only
 *   duplication is bounded by the marker; tool duplication is not bounded.
 * - NO retry after caller abort: options.signal (threaded from the turn's
 *   abortSignal by localLoop) takes precedence over transient classification.
 */
import type {
  AgentRuntimeChatMessage,
  AgentRuntimeCompleteOptions,
  AgentRuntimeProvider,
  AgentRuntimeResult,
} from "../../agent-runtime";
import { toErrorMessage } from "../../core/errorMessage";
import { isTransientFetchError } from "./localRuntimeFetchRetry";

const PROVIDER_STREAM_RETRY_MAX_ATTEMPTS = 2;

/**
 * Emitted through onTextDelta when a failed attempt had already streamed
 * visible text. Bracketed like other `[nolo]` runtime notes so users can tell
 * regeneration apart from model output. Exported for tests.
 */
export const STREAM_RETRY_MARKER =
  "\n\n[nolo] 上游流中断，自动重试（以下为该轮重新生成的内容）\n\n";

/**
 * The server chat proxy converts upstream mid-stream failures into a clean
 * SSE error frame with this code instead of tearing the TCP connection
 * (chatHandler wrapUpstreamWithCancelFlush). Match it here so those
 * structured failures retry exactly like raw socket deaths.
 */
const UPSTREAM_STREAM_INTERRUPTED_RE = /UPSTREAM_STREAM_INTERRUPTED/i;

export function isRetryableProviderStreamError(error: unknown): boolean {
  const message = toErrorMessage(error);
  return (
    UPSTREAM_STREAM_INTERRUPTED_RE.test(message) ||
    isTransientFetchError(message)
  );
}

export function withProviderStreamRetry(
  provider: AgentRuntimeProvider,
  deps: {
    activityReporter?: (label: string | null) => void;
  },
): AgentRuntimeProvider {
  return {
    model: provider.model,
    complete: async (
      messages: AgentRuntimeChatMessage[],
      options?: AgentRuntimeCompleteOptions,
    ): Promise<AgentRuntimeResult> => {
      let streamedChars = 0;
      let sawToolEvent = false;
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await provider.complete(messages, {
            ...options,
            ...(options?.onTextDelta
              ? {
                  onTextDelta: (chunk: string) => {
                    streamedChars += chunk.length;
                    options.onTextDelta!(chunk);
                  },
                }
              : {}),
            ...(options?.onToolEvent
              ? {
                  onToolEvent: (event: Parameters<
                    NonNullable<AgentRuntimeCompleteOptions["onToolEvent"]>
                  >[0]) => {
                    sawToolEvent = true;
                    options.onToolEvent!(event);
                  },
                }
              : {}),
          });
        } catch (error) {
          // User-initiated aborts must not be retried.
          if (options?.signal?.aborted) throw error;
          if (attempt >= PROVIDER_STREAM_RETRY_MAX_ATTEMPTS) throw error;
          if (!isRetryableProviderStreamError(error)) throw error;
          // Providers that emit mid-stream tool events (e.g. Cursor's inline
          // exec channel) have already executed/displayed a side effect; a
          // retry would replay that tool event (duplicate execution or
          // duplicated tool cards). Retry only when the failed attempt is
          // text-only, where the visible marker bounds the duplication.
          if (sawToolEvent) throw error;
          if (streamedChars > 0 && options?.onTextDelta) {
            options.onTextDelta(STREAM_RETRY_MARKER);
          }
          deps.activityReporter?.("上游流中断 · 自动重试");
        }
      }
    },
  };
}
