import type { AgentRuntimeAgentConfig } from "./hostAdapter";
import type {
  AgentRuntimeChatMessage,
  AgentRuntimeResult,
} from "./types";
import {
  buildProviderExecutionPlan,
  canUsePlatformChatProvider as canUsePlatformChatProviderFromEnv,
  hasDirectOpenAiCompatibleProvider as hasDirectOpenAiCompatibleProviderFromEnv,
  resolveAgentRuntimeLocation,
  resolvePlatformAuthToken,
  resolvePlatformServerUrl,
  resolveProviderTransportDecision,
} from "./providerResolution";

type EnvLike = Record<string, string | undefined>;

const CHAT_PROXY_PATH = "/api/v1/chat";

export type PlatformChatProviderConfig = {
  serverUrl: string;
  authToken: string;
  agentKey: string;
  model: string;
  provider: string;
  endpoint: string;
  requestOptions: Record<string, number | string>;
  apiKey?: string;
  apiKeyHeader?: string;
  apiSource?: string;
};

type PlatformChatTool = Record<string, unknown>;

function shouldDisableThinking(providerConfig: PlatformChatProviderConfig) {
  return (
    providerConfig.provider.toLowerCase() === "mimo" ||
    /xiaomimimo\.com/i.test(providerConfig.endpoint)
  );
}

function toOpenAiCompatibleMessages(messages: AgentRuntimeChatMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content ?? "",
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
    ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
  }));
}

export function resolvePlatformChatProviderConfig(args: {
  agentConfig: AgentRuntimeAgentConfig;
  env: EnvLike;
}): PlatformChatProviderConfig {
  const plan = buildProviderExecutionPlan({
    agentConfig: args.agentConfig,
    env: args.env,
    runtimeKind: "local",
  });
  if (plan.mode === "cli") {
    throw new Error("Platform chat provider does not support cli agents.");
  }
  if (plan.transport === "direct") {
    return {
      serverUrl: resolvePlatformServerUrl(args.env),
      authToken: resolvePlatformAuthToken(args.env),
      agentKey: args.agentConfig.key,
      model: plan.model,
      provider: plan.provider,
      endpoint: plan.endpoint,
      requestOptions: plan.requestOptions,
      ...(plan.apiKey ? { apiKey: plan.apiKey } : {}),
      ...(plan.apiKeyHeader ? { apiKeyHeader: plan.apiKeyHeader } : {}),
      ...(args.agentConfig.apiSource ? { apiSource: args.agentConfig.apiSource } : {}),
    };
  }
  return {
    serverUrl: plan.serverUrl,
    authToken: plan.authToken,
    agentKey: plan.agentKey,
    model: plan.model,
    provider: plan.provider,
    endpoint: plan.endpoint,
    requestOptions: plan.requestOptions,
    ...(plan.apiKey ? { apiKey: plan.apiKey } : {}),
    ...(plan.apiKeyHeader ? { apiKeyHeader: plan.apiKeyHeader } : {}),
    ...(plan.apiSource ? { apiSource: plan.apiSource } : {}),
  };
}

export function buildPlatformChatCompletionRequest(args: {
  providerConfig: PlatformChatProviderConfig;
  messages: AgentRuntimeChatMessage[];
  tools?: PlatformChatTool[];
}) {
  const body = {
    model: args.providerConfig.model,
    messages: toOpenAiCompatibleMessages(args.messages),
    stream: false,
    ...args.providerConfig.requestOptions,
    ...(args.tools && args.tools.length > 0 ? { tools: args.tools, tool_choice: "auto" } : {}),
    ...(shouldDisableThinking(args.providerConfig) ? { thinking: { type: "disabled" } } : {}),
    url: args.providerConfig.endpoint,
    provider: args.providerConfig.provider,
    agentKey: args.providerConfig.agentKey,
    ...(args.providerConfig.apiSource ? { apiSource: args.providerConfig.apiSource } : {}),
    ...(args.providerConfig.apiKey ? { KEY: args.providerConfig.apiKey } : {}),
    ...(args.providerConfig.apiKeyHeader ? { apiKeyHeader: args.providerConfig.apiKeyHeader } : {}),
  };

  return {
    url: `${args.providerConfig.serverUrl}${CHAT_PROXY_PATH}`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.providerConfig.authToken}`,
      },
      body: JSON.stringify(body),
    },
  };
}

function tryParseJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractJsonObjects(raw: string) {
  const objects: any[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== "}" || depth === 0) continue;

    depth -= 1;
    if (depth === 0 && start >= 0) {
      const parsed = tryParseJson(raw.slice(start, index + 1));
      if (parsed) objects.push(parsed);
      start = -1;
    }
  }

  return objects;
}

export function parsePlatformChatCompletionData(raw: string) {
  const direct = tryParseJson(raw.trim());
  if (direct) return direct;

  const objects = extractJsonObjects(raw);
  return objects.find((object) => Array.isArray(object?.choices)) ?? objects[0] ?? {};
}

export function parsePlatformChatCompletionResponse(args: {
  providerConfig: PlatformChatProviderConfig;
  data: any;
  trace: AgentRuntimeChatMessage[];
}): AgentRuntimeResult {
  const choiceMessage = args.data?.choices?.[0]?.message ?? {};
  return {
    content: String(choiceMessage?.content ?? ""),
    model: args.providerConfig.model,
    provider: args.providerConfig.provider,
    ...(Array.isArray(choiceMessage?.tool_calls) ? { tool_calls: choiceMessage.tool_calls } : {}),
    ...(typeof choiceMessage?.reasoning_content === "string" && choiceMessage.reasoning_content
      ? { reasoning_content: choiceMessage.reasoning_content }
      : {}),
    usage: args.data?.usage,
    trace: args.trace,
  };
}

export function canUsePlatformChatProvider(env: EnvLike) {
  return canUsePlatformChatProviderFromEnv(env);
}

export function hasDirectOpenAiCompatibleProvider(env: EnvLike) {
  return hasDirectOpenAiCompatibleProviderFromEnv(env);
}

export function shouldUsePlatformChatProvider(
  env: EnvLike,
  agentConfig?: AgentRuntimeAgentConfig
) {
  if (!agentConfig) {
    return resolveProviderTransportDecision({
      agentConfig: { key: "default-platform" },
      env,
      runtimeLocation: "local-host",
    }).transport === "proxy";
  }
  return resolveProviderTransportDecision({
    agentConfig,
    env,
    runtimeLocation: resolveAgentRuntimeLocation({
      agentConfig,
      runtimeKind: "local",
    }),
  }).transport === "proxy";
}
