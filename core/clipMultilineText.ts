/**
 * Shared pure multi-line text clip for agent context / search snippets.
 *
 * Agent context builders (inherited dialog refs, dialog message search,
 * reference context), agentRun upstream tool compaction, token-replay
 * benchmarks, and connector patch previews trim then truncate with the same
 * trailing `\n...[truncated N chars]` suffix so length math and suffix shape
 * cannot drift.
 * Distinct from `clipCompactText`, which collapses whitespace to a single line
 * and uses a short ellipsis.
 *
 * Dependency-free so pure unit tests do not pull AI/server modules.
 */
export function clipMultilineText(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n...[truncated ${trimmed.length - max} chars]`;
}
