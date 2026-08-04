/**
 * Simple sliding-window rate limit for OAuth token refreshes.
 * Coalesce (in-flight dedupe) still applies; this caps distinct refresh starts.
 */

export type OAuthRefreshRateLimitConfig = {
  /** Max refresh starts in the window. Default 8. */
  maxStarts?: number;
  /** Window length in ms. Default 60_000. */
  windowMs?: number;
  now?: () => number;
};

type WindowState = {
  starts: number[];
};

const windows = new Map<string, WindowState>();

export class OAuthRefreshRateLimitedError extends Error {
  readonly code = "OAUTH_REFRESH_RATE_LIMITED";
  readonly retryAfterMs: number;

  constructor(provider: string, retryAfterMs: number) {
    super(
      `OAuth refresh rate limited for "${provider}". Retry in ~${Math.ceil(retryAfterMs / 1000)}s.`,
    );
    this.name = "OAuthRefreshRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

export function resetOAuthRefreshRateLimitForTests(): void {
  windows.clear();
}

/**
 * Record a refresh start. Throws OAuthRefreshRateLimitedError when over cap.
 */
export function assertOAuthRefreshAllowed(
  key: string,
  provider: string,
  config: OAuthRefreshRateLimitConfig = {},
): void {
  const maxStarts = config.maxStarts ?? 8;
  const windowMs = config.windowMs ?? 60_000;
  const nowMs = config.now?.() ?? Date.now();
  const state = windows.get(key) ?? { starts: [] };
  const cutoff = nowMs - windowMs;
  state.starts = state.starts.filter((t) => t > cutoff);

  if (state.starts.length >= maxStarts) {
    const oldest = state.starts[0] ?? nowMs;
    const retryAfterMs = Math.max(0, oldest + windowMs - nowMs);
    windows.set(key, state);
    throw new OAuthRefreshRateLimitedError(provider, retryAfterMs);
  }

  state.starts.push(nowMs);
  windows.set(key, state);
}
