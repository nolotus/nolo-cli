import type { AgentRuntimeAgentConfig } from "./hostAdapter";
import { pickAgentRuntimeInferenceOptions } from "./agentConfigOptions";
import { getModelConfig } from "../ai/llm/providers";
import type { CredentialBroker } from "./credentialBroker";
import { resolveFreshAccessToken } from "./oauthTokenStore";
import { OAUTH_PROVIDER_REFRESH } from "./oauthProviders";

type EnvLike = Record<string, string | undefined>;

const PROVIDER_ENDPOINTS: Record<string, string> = {
  deepinfra: "https://api.deepinfra.com/v1/openai/chat/completions",
  deepseek: "https://api.deepseek.com/chat/completions",
  fireworks: "https://api.fireworks.ai/inference/v1/chat/completions",
  google: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  mistral: "https://api.mistral.ai/v1/chat/completions",
  mimo: "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  nolo: "https://ollama.com/v1/chat/completions",
  "ollama-cloud": "https://ollama.com/v1/chat/completions",
  vultr: "https://api.vultrinference.com/v1/chat/completions",
};

function isOpenAiResponsesModel(args: {
  provider?: string;
  model?: string;
  endpointKey?: string;
}) {
  if ((args.provider ?? "").trim().toLowerCase() !== "openai") return false;
  if (args.endpointKey === "responses") return true;
  if (!args.model) return false;
  try {
    return getModelConfig("openai", args.model).endpointKey === "responses";
  } catch {
    return false;
  }
}

function resolvePlatformProviderEndpoint(agentConfig: AgentRuntimeAgentConfig) {
  const customProviderUrl = agentConfig.customProviderUrl?.trim();
  if (customProviderUrl) return resolveChatCompletionsEndpoint(customProviderUrl);

  const provider = (agentConfig.provider ?? agentConfig.apiSource ?? "openai").toString().trim().toLowerCase();
  if (!provider) {
    throw new Error("Platform chat provider requires agentConfig.provider.");
  }
  if (isOpenAiResponsesModel({
    provider,
    model: agentConfig.model,
    endpointKey: (agentConfig as any).endpointKey,
  })) {
    return "https://api.openai.com/v1/responses";
  }
  const endpoint = PROVIDER_ENDPOINTS[provider];
  if (!endpoint) {
    throw new Error(`Platform chat provider does not support provider "${provider}".`);
  }
  return endpoint;
}

export type AgentProviderMode = "cli" | "platform" | "custom";
export type ProviderExecutionTransport = "direct" | "proxy";
export type AgentRuntimeLocation = "server" | "bound-machine" | "local-host";

/**
 * Resolves an `apiKeyRef` (e.g. "chatgpt") into a fresh OAuth access token.
 * Injected by the caller so agent-runtime stays free of provider-specific OAuth
 * wiring (which lives in packages/cli/oauth).
 */
export type ApiKeyRefResolver = (ref: string) => Promise<string | null>;

/**
 * Load a secret from the local credential broker by explicit ref.
 * Prefer this for metered API keys stored under ~/.nolo/credentials/keys/.
 */
export async function resolveCredentialFromBroker(
  broker: CredentialBroker,
  ref: string,
): Promise<string | null> {
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  if (!trimmed) return null;
  try {
    if (!(await broker.has(trimmed))) return null;
    const secret = await broker.get(trimmed);
    if (typeof secret !== "string") return null;
    const value = secret.trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Build an ApiKeyRefResolver that reads from a CredentialBroker first.
 * Callers may compose with OAuth resolvers (try broker, then OAuth).
 */
export function createBrokerApiKeyRefResolver(broker: CredentialBroker): ApiKeyRefResolver {
  return (ref) => resolveCredentialFromBroker(broker, ref);
}

export type ProviderTransportDecision = {
  mode: AgentProviderMode;
  transport: ProviderExecutionTransport;
  reason:
    | "cli-provider"
    | "custom-provider"
    | "custom-server-proxy"
    | "platform-agent"
    | "forced-platform-env"
    | "forced-direct-env"
    | "direct-provider-env"
    | "platform-proxy-fallback";
};

type ProviderExecutionPlanBase = {
  mode: AgentProviderMode;
  transport: ProviderExecutionTransport;
  model: string;
  provider: string;
  requestOptions: Record<string, number | string>;
};

export type CliProviderExecutionPlan = ProviderExecutionPlanBase & {
  mode: "cli";
  transport: "direct";
  cliProvider: string;
};

export type DirectProviderExecutionPlan = ProviderExecutionPlanBase & {
  mode: "platform" | "custom";
  transport: "direct";
  endpoint: string;
  apiKey: string;
  apiKeyHeader?: string;
};

export type ProxyProviderExecutionPlan = ProviderExecutionPlanBase & {
  mode: "platform" | "custom";
  transport: "proxy";
  endpoint: string;
  serverUrl: string;
  authToken: string;
  agentKey: string;
  apiSource?: string;
  apiKey?: string;
  apiKeyHeader?: string;
};

export type ProviderExecutionPlan =
  | CliProviderExecutionPlan
  | DirectProviderExecutionPlan
  | ProxyProviderExecutionPlan;

export function trimTrailingSlash(value: string) {
  return value.trim().replace(/\/+$/, "");
}

export function resolveChatCompletionsEndpoint(value: string) {
  const trimmed = trimTrailingSlash(value);
  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
}

export function resolveOpenAiCompatibleBaseUrl(env: EnvLike) {
  return env.NOLO_LOCAL_OPENAI_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1";
}

export function resolveOpenAiCompatibleApiKey(env: EnvLike) {
  return env.OPENAI_API_KEY || env.NOLO_LOCAL_OPENAI_API_KEY || "";
}

export function resolvePlatformServerUrl(env: EnvLike) {
  return trimTrailingSlash(env.NOLO_SERVER || env.BASE_URL || "https://nolo.chat");
}

export function resolvePlatformAuthToken(env: EnvLike) {
  return env.AUTH_TOKEN || env.AUTH || env.BENCHMARK_AUTH_TOKEN || "";
}

export function canUsePlatformChatProvider(env: EnvLike) {
  return Boolean(resolvePlatformAuthToken(env));
}

export function hasDirectOpenAiCompatibleProvider(env: EnvLike) {
  return Boolean(
    env.NOLO_LOCAL_OPENAI_API_KEY ||
      env.OPENAI_API_KEY ||
      env.NOLO_LOCAL_OPENAI_BASE_URL ||
      env.OPENAI_BASE_URL ||
      env.OLLAMA_BASE_URL
  );
}

export function resolveAgentProviderMode(agentConfig: AgentRuntimeAgentConfig): AgentProviderMode {
  if (agentConfig.apiSource === "cli" || agentConfig.provider === "cli" || agentConfig.cliProvider) {
    return "cli";
  }
  if (agentConfig.apiSource === "custom" || agentConfig.customProviderUrl) {
    return "custom";
  }
  return "platform";
}

export function resolveAgentRuntimeLocation(args: {
  agentConfig: AgentRuntimeAgentConfig;
  runtimeKind: "local" | "desktop" | "server";
}): AgentRuntimeLocation {
  const runtimeBinding = args.agentConfig.runtimeBinding;
  const machineId = typeof runtimeBinding?.machineId === "string"
    ? runtimeBinding.machineId.trim()
    : "";
  if (machineId) return "bound-machine";
  if (args.runtimeKind === "server") return "server";
  return "local-host";
}

export function resolveProviderTransportDecision(args: {
  agentConfig: AgentRuntimeAgentConfig;
  env: EnvLike;
  runtimeLocation: AgentRuntimeLocation;
}): ProviderTransportDecision {
  const mode = resolveAgentProviderMode(args.agentConfig);
  if (mode === "cli") {
    return { mode, transport: "direct", reason: "cli-provider" };
  }
  if (mode === "custom") {
    if (args.runtimeLocation === "server" && args.agentConfig.useServerProxy === true) {
      return { mode, transport: "proxy", reason: "custom-server-proxy" };
    }
    return { mode, transport: "direct", reason: "custom-provider" };
  }
  if (args.agentConfig.apiSource === "platform" || args.agentConfig.useServerProxy === true) {
    return { mode, transport: "proxy", reason: "platform-agent" };
  }
  if (args.env.NOLO_LOCAL_LLM === "platform") {
    return { mode, transport: "proxy", reason: "forced-platform-env" };
  }
  if (args.env.NOLO_LOCAL_LLM === "direct") {
    return { mode, transport: "direct", reason: "forced-direct-env" };
  }
  if (hasDirectOpenAiCompatibleProvider(args.env)) {
    return { mode, transport: "direct", reason: "direct-provider-env" };
  }
  if (canUsePlatformChatProvider(args.env)) {
    return { mode, transport: "proxy", reason: "platform-proxy-fallback" };
  }
  return { mode, transport: "direct", reason: "direct-provider-env" };
}

export function resolveProviderAuthHeaderName(args: {
  endpoint: string;
  apiKeyHeader?: string;
}) {
  const explicitHeader = args.apiKeyHeader?.trim();
  if (explicitHeader) return explicitHeader;
  if (/xiaomimimo\.com/i.test(args.endpoint)) return "api-key";
  return "Authorization";
}

export function buildProviderAuthHeaders(args: {
  endpoint: string;
  apiKey: string;
  apiKeyHeader?: string;
}): Record<string, string> {
  if (!args.apiKey) return {};
  const headerName = resolveProviderAuthHeaderName(args);
  return headerName.toLowerCase() === "authorization"
    ? { Authorization: `Bearer ${args.apiKey}` }
    : { [headerName]: args.apiKey };
}

export async function buildProviderExecutionPlan(args: {
  agentConfig: AgentRuntimeAgentConfig;
  env: EnvLike;
  runtimeKind: "local" | "desktop" | "server";
  apiKeyRefResolver?: ApiKeyRefResolver;
  /** Local-first OS credential broker (API keys). Prefer over raw agent.apiKey. */
  credentialBroker?: CredentialBroker;
}): Promise<ProviderExecutionPlan> {
  const { agentConfig, env } = args;
  const mode = resolveAgentProviderMode(agentConfig);
  const runtimeLocation = resolveAgentRuntimeLocation({
    agentConfig,
    runtimeKind: args.runtimeKind,
  });
  const transportDecision = resolveProviderTransportDecision({
    agentConfig,
    env,
    runtimeLocation,
  });
  const model = agentConfig.model || "gpt-4.1-mini";
  const requestOptions = pickAgentRuntimeInferenceOptions(agentConfig);

  if (mode === "cli") {
    return {
      mode,
      transport: "direct",
      cliProvider: agentConfig.cliProvider || agentConfig.provider || "codex",
      model,
      provider: agentConfig.provider || "cli",
      requestOptions,
    };
  }

  if (mode === "custom") {
    const endpoint = resolveChatCompletionsEndpoint(agentConfig.customProviderUrl || resolveOpenAiCompatibleBaseUrl(env));
    let apiKey = "";
    const credentialRef = agentConfig.credentialRef?.trim();
    const apiKeyRef = agentConfig.apiKeyRef?.trim();

    // Prefer local broker (migrated API keys) before raw record fields / OAuth resolver.
    if (args.credentialBroker) {
      const brokerRefs = [credentialRef, apiKeyRef].filter(
        (ref): ref is string => Boolean(ref),
      );
      for (const ref of brokerRefs) {
        const fromBroker = await resolveCredentialFromBroker(args.credentialBroker, ref);
        if (fromBroker) {
          apiKey = fromBroker;
          break;
        }
      }
    }

    if (!apiKey && apiKeyRef && args.apiKeyRefResolver) {
      const resolved = await args.apiKeyRefResolver(apiKeyRef);
      if (resolved) {
        apiKey = resolved;
      } else if (!agentConfig.apiKey?.trim() && !agentConfig.apiKeyFromAgentKey?.trim()) {
        throw new Error(
          `OAuth credential for "${apiKeyRef}" not found locally. Run \`nolo auth ${apiKeyRef}\` (and \`--sync-to-server\` for server-side agent runs).`,
        );
      }
    }

    if (!apiKey) {
      apiKey = agentConfig.apiKey?.trim() || agentConfig.apiKeyFromAgentKey?.trim() || "";
    }

    const apiKeyHeader = resolveProviderAuthHeaderName({
      endpoint,
      apiKeyHeader: agentConfig.apiKeyHeader,
    });
    if (transportDecision.transport === "proxy") {
      return {
        mode,
        transport: "proxy",
        model,
        provider: agentConfig.provider || "custom",
        endpoint,
        requestOptions,
        serverUrl: resolvePlatformServerUrl(env),
        authToken: resolvePlatformAuthToken(env),
        agentKey: agentConfig.key,
        ...(agentConfig.apiSource ? { apiSource: agentConfig.apiSource } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(apiKeyHeader ? { apiKeyHeader } : {}),
      };
    }
    return {
      mode,
      transport: "direct",
      model,
      provider: agentConfig.provider || "custom",
      endpoint,
      requestOptions,
      apiKey,
      ...(apiKeyHeader ? { apiKeyHeader } : {}),
    };
  }

  const provider = agentConfig.provider || agentConfig.apiSource || "openai";
  const endpoint = transportDecision.transport === "proxy"
    ? resolvePlatformProviderEndpoint(agentConfig)
    : resolveChatCompletionsEndpoint(resolveOpenAiCompatibleBaseUrl(env));
  if (transportDecision.transport === "proxy") {
    return {
      mode,
      transport: "proxy",
      model,
      provider,
      endpoint,
      requestOptions,
      serverUrl: resolvePlatformServerUrl(env),
      authToken: resolvePlatformAuthToken(env),
      agentKey: agentConfig.key,
      ...(agentConfig.apiSource ? { apiSource: agentConfig.apiSource } : {}),
      ...(agentConfig.apiKey?.trim() ? { apiKey: agentConfig.apiKey.trim() } : {}),
      ...(agentConfig.apiKeyHeader?.trim() ? { apiKeyHeader: agentConfig.apiKeyHeader.trim() } : {}),
    };
  }
  // Platform direct: prefer brokered credentialRef (migrated keys) before env.
  let apiKey = "";
  const credentialRef = agentConfig.credentialRef?.trim();
  if (args.credentialBroker && credentialRef) {
    const fromBroker = await resolveCredentialFromBroker(args.credentialBroker, credentialRef);
    if (fromBroker) {
      apiKey = fromBroker;
    }
  }
  if (!apiKey) {
    apiKey = resolveOpenAiCompatibleApiKey(env);
  }

  return {
    mode,
    transport: "direct",
    model,
    provider: agentConfig.provider || "openai-compatible",
    endpoint,
    requestOptions,
    apiKey,
  };
}
