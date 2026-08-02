/**
 * Shared abortable sleep.
 *
 * Retry loops across CLI/AI/agent transports wait between attempts the same
 * way: setTimeout with an AbortSignal listener that rejects on abort. Keeping
 * one implementation prevents the listener-cleanup pattern from drifting
 * (missed removeEventListener = leaked listeners; wrong abort shape = hangs).
 *
 * Dependency-free so pure unit tests do not pull CLI/AI modules.
 */

/**
 * Resolve after `ms`, or reject with a DOMException("AbortError") when
 * `signal` aborts first. Rejects immediately if already aborted.
 */
export function waitForAbortableDelay(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  const delayMs = Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : 0;

  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
