/**
 * Shared pure optional positive finite-number normalizer.
 *
 * Token usage billing, product purchase amount validation, revenue-share
 * cost/pay-map readers, and similar credit-amount gates coerce unknown field
 * values the same way: keep finite numbers strictly greater than zero, drop
 * everything else as `undefined` (including 0, negatives, NaN / ±Infinity,
 * and non-numbers).
 *
 * Distinct from `asOptionalPositiveInteger` (integers only) and
 * `asOptionalFiniteNumber` (allows zero / negatives). Keep one definition so
 * zero / float / non-finite handling cannot drift across auth billing modules.
 *
 * Dependency-free so pure unit tests do not pull auth/server modules.
 */
export function asOptionalPositiveFiniteNumber(
  value: unknown,
): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
