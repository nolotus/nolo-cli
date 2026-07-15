/**
 * Shared pure server-origin normalizer for replica lists, hybrid reads, and
 * file content URLs.
 *
 * Share bootstrap, table-replication origin comparisons, database file URL
 * builders, and similar readers coerce unknown origin values the same way:
 * keep non-empty trimmed strings, strip trailing slashes, drop everything
 * else as "". Keep one definition so origin equality and URL joins cannot
 * drift across database/share modules.
 *
 * Dependency-free so pure unit tests do not pull database/share modules.
 * For known-cluster alias remapping, compose with package-local known-origin
 * helpers after this pure shape step.
 */
export function normalizeServerOrigin(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : "";
}
