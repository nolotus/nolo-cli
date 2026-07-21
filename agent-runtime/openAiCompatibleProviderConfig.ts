import type { AgentRuntimeAgentConfig } from "./hostAdapter";
import type { CredentialBroker } from "./credentialBroker";
import type { OpenAiCompatibleProviderConfig } from "./openAiCompatibleProvider";
import { buildProviderExecutionPlan, type ApiKeyRefResolver } from "./providerResolution";

type EnvLike = Record<string, string | undefined>;

export async function resolveOpenAiCompatibleProviderConfig(args: {
  agentConfig: AgentRuntimeAgentConfig;
  env: EnvLike;
  apiKeyRefResolver?: ApiKeyRefResolver;
  /** Local-first OS credential broker (API keys). Prefer over raw agent.apiKey. */
  credentialBroker?: CredentialBroker;
  syncFetcher?: (credentialRef: string) => Promise<string | null>;
}): Promise<OpenAiCompatibleProviderConfig> {
  const plan = await buildProviderExecutionPlan({
    agentConfig: args.agentConfig,
    env: args.env,
    runtimeKind: "local",
    ...(args.apiKeyRefResolver ? { apiKeyRefResolver: args.apiKeyRefResolver } : {}),
    ...(args.credentialBroker ? { credentialBroker: args.credentialBroker } : {}),
    ...(args.syncFetcher ? { syncFetcher: args.syncFetcher } : {}),
  });
  if (plan.mode === "cli" || plan.transport !== "direct") {
    throw new Error("OpenAI-compatible provider config requires a direct provider execution plan.");
  }
  return {
    model: plan.model,
    endpoint: plan.endpoint,
    apiKey: plan.apiKey,
    ...(plan.apiKeyHeader ? { apiKeyHeader: plan.apiKeyHeader } : {}),
    provider: plan.provider,
    requestOptions: plan.requestOptions,
  };
}
