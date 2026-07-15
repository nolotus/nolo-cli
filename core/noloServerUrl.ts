/**
 * Shared pure nolo.chat server-URL canonicalizer.
 *
 * CLI profile storage and server-side tool executors coerce cluster bases the
 * same way: trim, strip trailing slashes, and upgrade bare `http://` to
 * `https://` for `nolo.chat` / `*.nolo.chat` so auth cookies and Bearer
 * headers survive mixed-content / redirect paths. Keep one definition so the
 * host allowlist and protocol upgrade cannot drift across CLI and server.
 *
 * Dependency-free so pure unit tests do not pull CLI/server modules.
 */

/** True for apex `nolo.chat` and any `*.nolo.chat` subdomain (case-insensitive). */
export function isNoloChatHostname(hostname: unknown): boolean {
  if (typeof hostname !== "string") return false;
  const host = hostname.trim().toLowerCase();
  if (!host) return false;
  return host === "nolo.chat" || host.endsWith(".nolo.chat");
}

/**
 * Canonicalize a nolo cluster / profile server base URL.
 *
 * - Trims and strips trailing `/`
 * - Upgrades `http://` → `https://` only for nolo.chat hosts
 * - Leaves loopback, LAN, and non-nolo hosts unchanged
 * - Invalid / non-URL input returns the trimmed-and-stripped string
 */
export function canonicalizeNoloServerUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) return normalized;
  try {
    const url = new URL(normalized);
    if (url.protocol === "http:" && isNoloChatHostname(url.hostname)) {
      url.protocol = "https:";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    return normalized;
  }
  return normalized;
}
