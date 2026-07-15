/**
 * Shared pure positive finite-number coercer with fallback.
 *
 * Crypto USDC Base / USDT Tron deposit config readers (minCredits,
 * credits-per-token rates) and similar env/string/query readers coerce unknown
 * values the same way: `Number(...)` then keep finite numbers strictly greater
 * than zero, else return `fallback` (including missing, blank, zero,
 * negatives, NaN / ±Infinity). Keep one definition so zero / float handling
 * cannot drift.
 *
 * Distinct from `parsePositiveIntegerOrFallback` (integers only; rejects
 * floats), `asOptionalPositiveFiniteNumber` (typed number in → `undefined` out,
 * no `Number()` coercion), and `parseEnvNumber` (floors and clamps to a min,
 * allowing zero when min is 0).
 *
 * Dependency-free so pure unit tests do not pull server/crypto modules.
 */
export function parsePositiveFiniteNumberOrFallback(
  value: unknown,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
