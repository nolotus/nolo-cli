import type { AgentRuntimeAgentConfig } from "./hostAdapter";
import type { OpenAiCompatibleProviderConfig } from "./openAiCompatibleProvider";
import { buildProviderExecutionPlan, type ApiKeyRefResolver } from "./providerResolution";

type EnvLike = Record<string, string | undefined>;

export async function resolveOpenAiCompatibleProviderConfig(args: {
  agentConfig: AgentRuntimeAgentConfig;
  env: EnvLike;
  apiKeyRefResolver?: ApiKeyRefResolver;
}): Promise<OpenAiCompatibleProviderConfig> {
  const plan = await buildProviderExecutionPlan({
    agentConfig: args.agentConfig,
    env: args.env,
    runtimeKind: "local",
    ...(args.apiKeyRefResolver ? { apiKeyRefResolver: args.apiKeyRefResolver } : {}),
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
