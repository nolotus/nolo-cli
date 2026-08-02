/**
 * Single source of truth for "is this hostname internal?".
 *
 * Two callers ask this question for different reasons:
 *
 * - `packages/server/handlers/fetchWebpageHandler.ts` — a security boundary.
 *   The server must refuse to fetch internal addresses, or an authenticated
 *   user can read its loopback services through the response body.
 * - `packages/cli/client/fetchWebpageContent.ts` — a routing decision. When the
 *   CLI runs on the user's own machine, an internal address means *their* box,
 *   so the fetch stays in-process instead of bridging to the server.
 *
 * They previously each carried their own copy of the same regex, and the copies
 * had already drifted: the CLI stripped IPv6 brackets, the server did not, so
 * `http://[::1]:6379/` passed the server's guard. Divergence in a predicate one
 * side uses for security is the whole reason this lives in one place.
 *
 * Scope: this answers a question about the hostname *as written*. It does not
 * resolve DNS, so a public name with an A/AAAA record pointing inward still
 * reads as external. Callers that need resolve-then-validate must do that
 * themselves.
 */

/** Strip the brackets WHATWG `URL.hostname` keeps around IPv6 literals. */
function unwrapIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Loopback, private, link-local and "this network" IPv4 ranges, plus `localhost`.
 * `0.` covers all of 0.0.0.0/8, not just the literal 0.0.0.0 — the older regex
 * matched only the literal, so 0.0.0.1 read as public.
 */
const INTERNAL_IPV4_OR_NAME_RE =
  /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.)/;

/**
 * Loopback and unspecified, matched whole. These must NOT be prefix matches:
 * an unanchored `^::` also swallows every `::ffff:<public v4>`, which would
 * make the server refuse legitimate public addresses and, worse, hide the
 * IPv4-mapped logic below behind a branch that always won first.
 */
const INTERNAL_IPV6_EXACT = new Set(["::1", "::", "0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:0"]);

/** Unique-local `fc00::/7` (fc/fd) and link-local `fe80::/10` (fe8–feb). */
const INTERNAL_IPV6_PREFIX_RE = /^(f[cd][0-9a-f]{0,2}:|fe[89ab][0-9a-f]:)/;

/**
 * IPv4-mapped IPv6 (`::ffff:0:0/96`). Note the host may already be normalized
 * to hex groups — Bun renders `::ffff:127.0.0.1` as `::ffff:7f00:1` — so both
 * the dotted and the hex form have to be recognized.
 */
function isIpv4MappedInternal(host: string): boolean {
  const mapped = host.match(/^::ffff:(.+)$/);
  if (!mapped?.[1]) return false;
  const rest = mapped[1];
  if (INTERNAL_IPV4_OR_NAME_RE.test(rest)) return true;
  // Hex form: ::ffff:7f00:1 → 127.0.0.1. Expand the first group to octets.
  const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return false;
  const high = Number.parseInt(hex[1] ?? "", 16);
  if (!Number.isFinite(high)) return false;
  const firstOctet = (high >> 8) & 0xff;
  const secondOctet = high & 0xff;
  if (firstOctet === 127 || firstOctet === 10 || firstOctet === 0) return true;
  if (firstOctet === 192 && secondOctet === 168) return true;
  if (firstOctet === 169 && secondOctet === 254) return true;
  if (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) return true;
  return false;
}

/**
 * Bare-decimal and octal IPv4 (`http://2130706433/` is 127.0.0.1). WHATWG URL
 * normalizes these for http(s), but not every caller parses through URL, so
 * recognize them rather than trust normalization.
 */
function isNumericInternalIpv4(host: string): boolean {
  if (!/^\d+$/.test(host)) return false;
  const value = Number(host);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return false;
  const firstOctet = (value >>> 24) & 0xff;
  const secondOctet = (value >>> 16) & 0xff;
  if (firstOctet === 127 || firstOctet === 10 || firstOctet === 0) return true;
  if (firstOctet === 192 && secondOctet === 168) return true;
  if (firstOctet === 169 && secondOctet === 254) return true;
  if (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) return true;
  return false;
}

/**
 * True when the hostname names a loopback, private, link-local or unspecified
 * address — i.e. something only reachable from inside the machine or network
 * doing the fetching.
 */
export function isInternalHostname(hostname: string): boolean {
  const host = unwrapIpv6Brackets(hostname.trim().toLowerCase()).replace(/\.$/, "");
  if (!host) return true;
  if (INTERNAL_IPV4_OR_NAME_RE.test(host)) return true;
  if (INTERNAL_IPV6_EXACT.has(host)) return true;
  if (INTERNAL_IPV6_PREFIX_RE.test(host)) return true;
  if (isIpv4MappedInternal(host)) return true;
  if (isNumericInternalIpv4(host)) return true;
  return false;
}
