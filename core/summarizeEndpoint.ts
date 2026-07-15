/**
 * Shared pure endpoint URL summarizer for diagnostic / log fields.
 *
 * Local runtime adapters, machine-WS dispatch, and server-side machine
 * connector diagnostics redact provider URLs the same way: keep protocol +
 * host + pathname only (drop query/hash/credentials), treat blank input as
 * absent, and map unparseable values to `"invalid-url"`. Keep one definition
 * so log field shapes cannot drift across CLI and server callers.
 *
 * Dependency-free so pure unit tests do not pull CLI/server modules.
 */
export function summarizeEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}
