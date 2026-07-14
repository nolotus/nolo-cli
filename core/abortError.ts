/**
 * Shared pure AbortError detector.
 *
 * Fetch aborts and AbortController cancellations surface as:
 * - `DOMException` with `name === "AbortError"`
 * - `Error` with `name === "AbortError"`
 * - plain objects with `name === "AbortError"` (serialized / rethrown shapes)
 *
 * Keep one definition so retry, space resolution, and async swallow helpers
 * cannot drift. Callers that also treat `signal.aborted` as cancelled compose
 * that check at the callsite.
 *
 * Dependency-free so pure unit tests do not pull app/create modules.
 */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { name?: unknown }).name === "AbortError";
}
