export const DEFAULT_LOCAL_HOST = "127.0.0.1";
export const DEFAULT_LOCAL_API_PORT = "38123";

export const DEFAULT_LOCAL_API_ORIGIN = `http://${DEFAULT_LOCAL_HOST}:${DEFAULT_LOCAL_API_PORT}`;

/** Hostnames treated as machine-local loopback across CLI, AI schema, and providers. */
export const LOOPBACK_HOSTNAMES = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
]);

export function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * Pure loopback hostname check.
 *
 * Locality: one seam for "is this host the local machine" so agent routing,
 * custom-provider schema, and request-body shaping share one definition.
 * Bun's URL.hostname keeps IPv6 brackets (`[::1]`); those are unwrapped here.
 */
export function isLoopbackHostname(hostname: unknown): boolean {
  if (typeof hostname !== "string") return false;
  let normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  return LOOPBACK_HOSTNAMES.has(normalized);
}

/**
 * Pure loopback URL check. Invalid/empty input is not loopback.
 */
export function isLoopbackUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}
