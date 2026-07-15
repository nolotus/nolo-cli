/**
 * Shared pure positive-integer coercer with fallback.
 *
 * Crypto USDC Base / USDT Tron deposit scanners, dialog `--limit` readers, and
 * similar env/string/query readers coerce unknown values the same way:
 * `Number(...)` then keep integers strictly greater than zero, else return
 * `fallback` (including missing, blank, floats, zero, negatives, NaN /
 * ±Infinity). Keep one definition so zero / float handling cannot drift.
 *
 * Distinct from `asOptionalPositiveInteger` (typed number in → `undefined` out,
 * no `Number()` coercion), `clampInteger` (truncates into a range and may keep
 * zero), and throw-on-invalid CLI option parsers.
 *
 * Dependency-free so pure unit tests do not pull server/crypto modules.
 */
export function parsePositiveIntegerOrFallback(
  value: unknown,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
