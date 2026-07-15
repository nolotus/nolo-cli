/**
 * Shared LevelDB lock / busy detector.
 *
 * When another process holds the LevelDB LOCK, surfaces commonly include:
 * - `error.code === "LEVEL_LOCKED"`
 * - message text matching LEVEL_LOCKED, "Resource temporarily unavailable",
 *   path-like `/LOCK`, or `LOCK:` prefixes
 *
 * Pure single-node check (no cause / AggregateError walking). Callers that need
 * cause walking compose that at the callsite (see isServerDbLockError).
 *
 * Dependency-free so pure unit tests do not pull server db modules.
 */
export function isLevelLockError(error: unknown): boolean {
  if (error == null) return false;
  const text =
    typeof error === "object"
      ? `${(error as { code?: unknown }).code ?? ""} ${(error as { message?: unknown }).message ?? error}`
      : String(error);
  return /LEVEL_LOCKED|Resource temporarily unavailable|\/LOCK|LOCK:/.test(text);
}
