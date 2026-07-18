import { asOptionalTrimmedString } from "../core/optionalString";
import { asTrimmedLowercaseString } from "../core/trimmedLowercaseString";

import type { AgentRuntimeAgentConfig } from "./hostAdapter";
import { trimTrailingSlash } from "./providerResolution";

/**
 * Cloud Code Assist base URL used by Antigravity OAuth direct chat.
 *
 * Must be the Antigravity production host `daily-cloudcode-pa`, NOT the generic
 * `cloudcode-pa`. The Antigravity subscription quota is served on
 * `daily-cloudcode-pa`; the generic host meters requests against the small
 * per-project individual quota and 429s with "upgrade your subscription" even
 * for paid users. (Matches oh-my-pi's ANTIGRAVITY_DAILY_ENDPOINT.)
 */
export const ANTIGRAVITY_CLOUD_CODE_BASE_URL =
  "https://daily-cloudcode-pa.googleapis.com";

/** Generic legacy host; kept for detection (daily host contains it as substring). */
const ANTIGRAVITY_CLOUD_CODE_HOST = "cloudcode-pa.googleapis.com";
/** Exact generic host to upgrade to the production Antigravity host. */
const ANTIGRAVITY_LEGACY_GENERIC_BASE_RE =
  /^https?:\/\/cloudcode-pa\.googleapis\.com$/i;

export function getAntigravityUserAgent(): string {
  const version = process.env.NOLO_ANTIGRAVITY_VERSION || "2.1.4";
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch =
    process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch;
  return `antigravity/hub/${version} ${os}/${arch}`;
}

export function resolveAntigravityCloudCodeBaseUrl(
  customProviderUrl?: string | null
): string {
  const raw = (customProviderUrl ?? "").trim();
  if (!raw) return ANTIGRAVITY_CLOUD_CODE_BASE_URL;
  const trimmed = trimTrailingSlash(raw);
  if (trimmed.includes(ANTIGRAVITY_CLOUD_CODE_HOST)) {
    const base = trimmed.replace(/\/v1internal:.*$/i, "").replace(/\/$/, "");
    // Upgrade legacy agent records pinned to the generic host so paid users
    // hit the Antigravity subscription quota instead of 429ing on the generic
    // per-project individual quota.
    if (ANTIGRAVITY_LEGACY_GENERIC_BASE_RE.test(base)) {
      return ANTIGRAVITY_CLOUD_CODE_BASE_URL;
    }
    return base;
  }
  return ANTIGRAVITY_CLOUD_CODE_BASE_URL;
}

export function isAntigravityOAuthAgent(agentConfig: AgentRuntimeAgentConfig | null | undefined): boolean {
  if (!agentConfig) return false;
  const apiKeyRef = asTrimmedLowercaseString(agentConfig.apiKeyRef);
  const provider = asTrimmedLowercaseString(agentConfig.provider);
  const url = asTrimmedLowercaseString(agentConfig.customProviderUrl);
  return (
    apiKeyRef === "antigravity" ||
    provider === "google-antigravity" ||
    url.includes(ANTIGRAVITY_CLOUD_CODE_HOST)
  );
}

export function readAntigravityProjectId(
  metadata: Record<string, unknown> | undefined | null
): string | undefined {
  return asOptionalTrimmedString(metadata?.projectId);
}