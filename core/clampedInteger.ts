/**
 * Shared pure bounded integer coercer for query/body limit and count fields.
 *
 * Billing/admin report handlers, provider-call recent lists, email list/scan
 * budgets, and similar readers coerce unknown limit values the same way:
 * non-finite → `fallback`, otherwise truncate toward zero and clamp into
 * `[min, max]`. Keep one definition so floor/trunc and empty-input handling
 * cannot drift across auth and server handlers.
 *
 * Note: `Number(null)` / `Number("")` are `0` (finite), so missing query
 * params clamp to `min` rather than `fallback` — matching the historical
 * local `parseLimit` clones. Use an explicit empty check at the callsite if
 * missing must mean `fallback`.
 *
 * Dependency-free so pure unit tests do not pull auth/server modules.
 */
export function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}
