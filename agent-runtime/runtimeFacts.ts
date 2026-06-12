import type {
  AgentRuntimeDecisionInput,
  AgentRuntimeHost,
  AgentRuntimeRequestedMode,
} from "./types";

export type AgentRuntimeCapabilityFacts = {
  host: AgentRuntimeHost;
  requestedMode?: AgentRuntimeRequestedMode;
  syncRequested?: boolean;
  capabilities: string[];
  requiresServer?: boolean;
  serverFallbackAvailable: boolean;
};

export function buildAgentRuntimeDecisionInput(
  facts: AgentRuntimeCapabilityFacts
): AgentRuntimeDecisionInput {
  const capabilities = new Set(facts.capabilities);
  const hasLocalAgentConfig = capabilities.has("leveldb-agent-config") || capabilities.has("agent-config");
  const hasLocalProvider = capabilities.has("local-provider") || capabilities.has("provider");
  const hasLocalPersistence = capabilities.has("leveldb-persistence") || capabilities.has("persistence");
  const missingLocalCapabilities = [
    ...(hasLocalAgentConfig ? [] : ["agent-config"]),
    ...(hasLocalProvider ? [] : ["provider"]),
    ...(hasLocalPersistence ? [] : ["persistence"]),
  ];

  return {
    host: facts.host,
    ...(facts.requestedMode ? { requestedMode: facts.requestedMode } : {}),
    syncRequested: Boolean(facts.syncRequested),
    hasLocalAgentConfig,
    hasLocalProvider,
    hasLocalPersistence,
    missingLocalCapabilities,
    requiresServer: Boolean(facts.requiresServer),
    serverFallbackAvailable: facts.serverFallbackAvailable,
  };
}
