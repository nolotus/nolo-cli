import { compactWhitespace } from "./compactWhitespace";

/**
 * Shared pure single-line clip for previews and evidence.
 *
 * Collapses whitespace with `compactWhitespace`, then truncates to `max` with
 * an ellipsis so tool-arg clips, CLI tool lines, and wake/delegation evidence
 * previews share one length math (slice reserve equals ellipsis length).
 *
 * Keep one definition so `...` vs bare slice and compact-then-clip order cannot
 * drift across agent-runtime, CLI, and server modules.
 *
 * Only depends on `compactWhitespace` so pure unit tests stay lightweight.
 */
export function clipCompactText(
  value: string,
  max: number,
  ellipsis: string = "...",
): string {
  const compact = compactWhitespace(value);
  if (compact.length <= max) return compact;
  if (max <= ellipsis.length) return compact.slice(0, max);
  return `${compact.slice(0, max - ellipsis.length)}${ellipsis}`;
}
