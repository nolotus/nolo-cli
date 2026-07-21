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
  apiSource?: string | null;
  customProviderUrl?: string | null;
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
 * - custom apiSource with a remote endpoint (browser CORS blocks direct
 *   calls to most provider APIs; only dashscope allows `*` origin). Local
 *   endpoints (127.0.0.1/localhost/::1) stay direct. Desktop runtime and RN
 *   do not reach this seam (host fetch / native fetch have no CORS).
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

  // Custom apiSource with a remote endpoint: browsers cannot CORS most provider
  // APIs, so route via server proxy. Local endpoints (Ollama/LM Studio) stay direct.
  // Only apiSource === "custom" counts — platform providers (e.g. mimo with a url)
  // use server-held platform keys, not custom-key CORS bypass.
  if (agentConfig.apiSource === "custom" && isRemoteCustomEndpoint(agentConfig.customProviderUrl)) {
    return true;
  }


  return !!agentConfig.useServerProxy;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

function isRemoteCustomEndpoint(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !LOCAL_HOSTS.has(host);
  } catch {
    return false;
  }
}
