/**
 * Shared wire-protocol drain reason.
 *
 * During a single-origin deploy the server rejects new stateful admissions with
 * `503 {"error":"Server draining","reason":"core_draining","retryable":true}`.
 * Both sides of the wire must agree on the exact `reason` string:
 * - server producers: `serverDraining.ts` (drain response), `serverProxyRetry.ts`
 *   (503 classification for upstream retry)
 * - client consumers: TUI platform proxy (`localRuntimeFetchRetry.ts`), Web
 *   background run start (`runAgentBackground.ts`)
 *
 * Keep one definition so the drain protocol string cannot drift across
 * packages. Dependency-free so pure unit tests do not pull CLI/AI modules.
 */
export const CORE_DRAIN_REASON = "core_draining";

/** Server-side alias matching the historical `SERVER_DRAIN_REASON` naming. */
export const SERVER_DRAIN_REASON = CORE_DRAIN_REASON;
