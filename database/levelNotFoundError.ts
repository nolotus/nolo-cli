/**
 * Shared Level/MemoryDB "key missing" error detector.
 *
 * Level and our MemoryDB/authority store shims surface not-found as:
 * - `error.notFound === true`
 * - `error.name === "NotFoundError"`
 * - `error.code === "LEVEL_NOT_FOUND"` / `"LEVEL_NOT_FOUND_ERROR"`
 * - `error.message === "NotFound"` (MemoryDB.get missing-key shape)
 *
 * Keep this pure and dependency-free so client, server, and sync paths
 * can share one definition without pulling action/server modules.
 */
export function isLevelNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    notFound?: unknown;
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  return (
    e.notFound === true ||
    e.name === "NotFoundError" ||
    e.code === "LEVEL_NOT_FOUND" ||
    e.code === "LEVEL_NOT_FOUND_ERROR" ||
    e.message === "NotFound"
  );
}
