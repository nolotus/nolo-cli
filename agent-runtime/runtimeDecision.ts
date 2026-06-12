import type {
  AgentRuntimeDecision,
  AgentRuntimeDecisionInput,
} from "./types";

function uniqueCapabilities(capabilities: string[]) {
  return [...new Set(capabilities.filter(Boolean))];
}

function localMissingCapabilities(input: AgentRuntimeDecisionInput) {
  const missing = [...(input.missingLocalCapabilities ?? [])];
  if (!input.hasLocalAgentConfig) missing.push("agent-config");
  if (!input.hasLocalProvider) missing.push("provider");
  if (!input.hasLocalPersistence) missing.push("persistence");
  if (input.requiresServer) missing.push("server-required");
  if (input.host === "web") missing.push("local-host-adapter");
  return uniqueCapabilities(missing);
}

export function resolveAgentRuntimeDecision(
  input: AgentRuntimeDecisionInput
): AgentRuntimeDecision {
  const requestedMode = input.requestedMode ?? "auto";
  const missingLocalCapabilities = localMissingCapabilities(input);
  const localRunnable = missingLocalCapabilities.length === 0;

  if (requestedMode === "server") {
    return {
      mode: "server",
      runnable: input.serverFallbackAvailable,
      reason: input.serverFallbackAvailable
        ? "server runtime was requested"
        : "server runtime was requested but no server fallback is available",
      missingLocalCapabilities,
      syncAfterRun: false,
    };
  }

  if (requestedMode === "local") {
    return {
      mode: "local",
      runnable: localRunnable,
      reason: localRunnable
        ? "local runtime was requested and all local capabilities are available"
        : "local runtime was requested but local capabilities are missing",
      missingLocalCapabilities,
      syncAfterRun: localRunnable && Boolean(input.syncRequested),
    };
  }

  if (localRunnable) {
    return {
      mode: "local",
      runnable: true,
      reason: "local runtime capabilities are available",
      missingLocalCapabilities,
      syncAfterRun: Boolean(input.syncRequested),
    };
  }

  return {
    mode: "server",
    runnable: input.serverFallbackAvailable,
    reason: input.serverFallbackAvailable
      ? "local runtime capabilities are missing; using server fallback"
      : "local runtime capabilities are missing and no server fallback is available",
    missingLocalCapabilities,
    syncAfterRun: false,
  };
}
