/**
 * Canonical internal context-block representation shared by every runtime
 * surface (local loop, TUI/CLI, HTTP/server, desktop).
 *
 * A `ContextBlockScope` pairs a context block string with a `cacheScope` that
 * tells the runtime whether the block belongs in the stable prefix
 * (`session`) or the dynamic suffix (`turn`) of the system message.
 *
 * Migration contract (phase 3, item 1):
 * - When scoped blocks are defined, they are authoritative — legacy plain
 *   `contextBlocks` are ignored so the same content is never duplicated.
 * - When scoped blocks are absent, legacy plain blocks are converted once to
 *   turn-scope blocks; they are never silently dropped.
 */

export type ContextBlockCacheScope = "session" | "turn";

export interface ContextBlockScope {
  content: string;
  cacheScope: ContextBlockCacheScope;
}

const isContextBlockScope = (value: unknown): value is ContextBlockScope => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { content?: unknown; cacheScope?: unknown };
  return (
    typeof candidate.content === "string" &&
    (candidate.cacheScope === "session" || candidate.cacheScope === "turn")
  );
};

/**
 * Normalize the two boundary inputs into a single canonical `ContextBlockScope`
 * array.
 *
 * Precedence:
 * 1. `scopes` is authoritative when it contains at least one non-empty block.
 *    `legacyBlocks` is ignored entirely (one-way compatibility input).
 * 2. When `scopes` is absent or empty, `legacyBlocks` is converted once into
 *    turn-scope blocks so callers that only supply plain strings still get
 *    their content into the prompt.
 * 3. Empty/whitespace-only entries are filtered out of either path.
 */
export const normalizeContextBlockScopes = (
  legacyBlocks: ReadonlyArray<string> | undefined = undefined,
  scopes: ReadonlyArray<ContextBlockScope> | undefined = undefined,
): ContextBlockScope[] => {
  const trimmedScopes = (Array.isArray(scopes) ? scopes : [])
    .filter(isContextBlockScope)
    .map((scope) => ({ content: scope.content.trim(), cacheScope: scope.cacheScope }))
    .filter((scope) => scope.content.length > 0);

  if (trimmedScopes.length > 0) {
    return trimmedScopes;
  }

  return (Array.isArray(legacyBlocks) ? legacyBlocks : [])
    .filter((block): block is string => typeof block === "string")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => ({ content: block, cacheScope: "turn" as const }));
};
