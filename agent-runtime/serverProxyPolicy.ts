/**
 * Pure server-proxy routing policy.
 *
 * Locality: one seam for "must this agent hit the Nolo server proxy?" so
 * client chat (`shouldUseServerProxy`), agent call-plan transport, and
 * account-sync OAuth apiKeyRef allowlists share one definition and cannot
 * drift on google-family / OAuth subscription routing.
 */

import { asTrimmedLowercaseString } from "../core/trimmedLowercaseString";

/** apiKeyRef values whose tokens live server-side (OAuth store), never in the browser. */
export const OAUTH_APIKEY_REFS = new Set([
  "antigravity",
  "xai",
  "chatgpt",
  "claude",
]);

export type ServerProxyAgentConfig = {
  provider?: string | null;
  useServerProxy?: boolean | null;
  apiKeyRef?: string | null;
};

/** Google Gemini / Antigravity OAuth providers (google, google-*). */
export function isGoogleFamilyProvider(provider: string): boolean {
  const normalized = asTrimmedLowercaseString(provider);
  return normalized === "google" || normalized.startsWith("google-");
}

/** True when value is a known provider OAuth subscription apiKeyRef id. */
export function isOAuthApiKeyRef(value: unknown): boolean {
  const ref = asTrimmedLowercaseString(value);
  return ref.length > 0 && OAUTH_APIKEY_REFS.has(ref);
}

/**
 * Whether chat / runtime should route through the server proxy.
 *
 * Forced true for:
 * - google-family providers (CORS + server-held OAuth)
 * - OAuth apiKeyRefs (token never present in the browser)
 *
 * Otherwise respects `useServerProxy`.
 */
export function shouldUseServerProxy(
  agentConfig: ServerProxyAgentConfig,
  requestProvider?: string,
): boolean {
  const effectiveProvider = (
    requestProvider ||
    agentConfig.provider ||
    ""
  ).toLowerCase();

  if (isGoogleFamilyProvider(effectiveProvider)) {
    return true;
  }

  if (isOAuthApiKeyRef(agentConfig.apiKeyRef)) {
    return true;
  }

  return !!agentConfig.useServerProxy;
}
