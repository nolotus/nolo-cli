import type { ApiKeyRefResolver } from "../agent-runtime/providerResolution";
import {
  createOAuthTokenStore,
  isTokenExpired,
  resolveFreshAccessToken,
} from "./token-store";
import { refreshAntigravityOAuthToken } from "./flows/antigravity";
import { refreshOpenAiCodexToken } from "./flows/openai-codex";
import { refreshXaiOAuthToken } from "./flows/xai";
import type { OAuthProvider, OAuthRefreshFn } from "./types";

const REFRESH_BY_PROVIDER: Partial<Record<OAuthProvider, OAuthRefreshFn>> = {
  chatgpt: refreshOpenAiCodexToken,
  // Previously only chatgpt was wired; expired antigravity/xai tokens then
  // surfaced as "OAuth credential not found" even when ~/.nolo/credentials
  // still held a valid refresh_token.
  antigravity: refreshAntigravityOAuthToken,
  xai: refreshXaiOAuthToken,
};

function isOAuthProvider(value: string): value is OAuthProvider {
  return value === "chatgpt" || value === "xai" || value === "antigravity";
}

export type CreateOAuthApiKeyRefResolverOptions = {
  homeDir?: string;
};

export function createOAuthApiKeyRefResolver(
  options: CreateOAuthApiKeyRefResolverOptions = {}
): ApiKeyRefResolver {
  return async (ref) => {
    const provider = ref.trim();
    if (!isOAuthProvider(provider)) return null;
    const refresh = REFRESH_BY_PROVIDER[provider];
    const token = await resolveFreshAccessToken({
      provider,
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      ...(refresh ? { refresh } : {}),
    });
    if (token) return token;

    // Prefer a precise error over "not found" when the file exists but is stale.
    const store = createOAuthTokenStore(options.homeDir);
    const credential = store.read(provider);
    if (credential && isTokenExpired(credential)) {
      throw new Error(
        `OAuth credential for "${provider}" is expired and could not be refreshed. Run \`nolo auth ${provider}\` (or \`nolo auth ${provider} --sync-to-server\` for server-side runs).`
      );
    }
    return null;
  };
}
