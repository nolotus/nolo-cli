/**
 * Shared pure whitespace normalizer for single-line previews and logs.
 *
 * Tool-argument clips, audit input previews, debug context, and similar
 * surfaces collapse runs of whitespace (spaces, tabs, newlines) into one
 * space and trim ends so preview length limits measure readable text the same
 * way. Keep one definition so clip/preview length cannot drift across
 * agent-runtime and server modules.
 *
 * Dependency-free so pure unit tests do not pull runtime/server modules.
 */
export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
