import type { ApiKeyRefResolver } from "../../agent-runtime/providerResolution";
import { resolveFreshAccessToken } from "./token-store";
import { refreshOpenAiCodexToken } from "./flows/openai-codex";
import type { OAuthProvider, OAuthRefreshFn } from "./types";

const REFRESH_BY_PROVIDER: Partial<Record<OAuthProvider, OAuthRefreshFn>> = {
  chatgpt: refreshOpenAiCodexToken,
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
    return resolveFreshAccessToken({
      provider,
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      ...(refresh ? { refresh } : {}),
    });
  };
}
