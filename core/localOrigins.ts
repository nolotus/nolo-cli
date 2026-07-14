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

/**
 * Bare http(s) origins that desktop shells cannot route: LAN IPv4,
 * localhost, or nolotus.local mDNS (optional port, no path/query).
 *
 * Locality: one seam for "is this server URL machine-local / LAN-only"
 * so app settings selectors, runtime remote-server selection, and desktop
 * connector profile routing share one definition and cannot drift.
 */
export const LOCAL_SERVER_URL_PATTERN =
  /^https?:\/\/(?:(?:\d{1,3}\.){3}\d{1,3}|localhost|nolotus\.local)(?::\d+)?$/i;

export function isLocalServerUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return LOCAL_SERVER_URL_PATTERN.test(value.trim());
}
