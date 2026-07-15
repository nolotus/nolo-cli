/**
 * Shared pure HTTP gateway/upstream-unavailable status detector.
 *
 * Agent-run streaming fallback, background run start retry, and connector
 * websocket handshake treat reverse-proxy gateway failures the same way:
 * - `502 Bad Gateway`
 * - `503 Service Unavailable`
 * - `504 Gateway Timeout`
 *
 * Keep one definition so 502/503/504 classification cannot drift across
 * CLI and AI transport callers. Broader email-style retry eligibility
 * (`429` / all 5xx) stays in `isRetryableHttpStatus`.
 *
 * Dependency-free so pure unit tests do not pull CLI/AI modules.
 */
export function isGatewayHttpStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}
