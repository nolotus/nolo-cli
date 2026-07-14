/**
 * Shared types and helpers for agent run dispatch — used by both
 * CLI-side (agentRun.ts) and connector-side (machineWsRunDispatch.ts).
 * This is the shared contract seam between the two dispatch paths.
 *
 * Keep this file focused on pure types and pure helpers (no side effects).
 * Side-effectful orchestration stays in agentRun.ts / machineWsRunDispatch.ts.
 */

import { isLoopbackUrl } from "../core/localOrigins";

export type EnvLike = Record<string, string | undefined>;

/**
 * What the dispatch resolver decided should happen for this agent run.
 * runAgentTurn() executes the plan as a thin orchestrator.
 */
export type DispatchPlan = {
  /** Resolved auth token (empty string = none available). */
  authToken: string;
  /** Whether to attempt a local agent turn first. */
  tryLocal: boolean;
  /** Whether HTTP/server fallback is available when local fails or is skipped. */
  tryHttp: boolean;
  /** Whether to refresh a missing local agent config and retry local once. */
  retryLocalOnMissingConfig: boolean;
  /** The resolved agent runtime request mode. */
  requestedMode: "local" | "server" | "auto";
};

export function resolveAuthToken(env: EnvLike) {
  return env.AUTH_TOKEN || env.AUTH || env.BENCHMARK_AUTH_TOKEN || "";
}

/**
 * Check whether an agent config represents a machine-bound localhost
 * custom provider — the agent is bound to a specific machine AND its
 * custom provider URL points to 127.0.0.1 or localhost.
 *
 * Used in both CLI auto-routing and connector dispatch to decide
 * whether local runtime should be skipped on this machine.
 */
export function isMachineBoundLocalhostCustomProvider(agentConfig: any) {
  const machineId =
    agentConfig?.runtimeBinding && typeof agentConfig.runtimeBinding === "object"
      ? String(agentConfig.runtimeBinding.machineId ?? "").trim()
      : "";
  const providerUrl = typeof agentConfig?.customProviderUrl === "string"
    ? agentConfig.customProviderUrl.trim()
    : "";
  if (!machineId || !providerUrl) return false;
  return isLoopbackUrl(providerUrl);
}

/**
 * Resolve the bound machine ID from an agent's runtime binding.
 */
export function resolveBoundMachineId(agentConfig: any) {
  return agentConfig?.runtimeBinding && typeof agentConfig.runtimeBinding === "object"
    ? String(agentConfig.runtimeBinding.machineId ?? "").trim()
    : "";
}

/**
 * Set of recognized CLI provider names.
 */
export const CLI_PROVIDER_NAMES = new Set([
  "agy",
  "claude",
  "codex",
  "copilot",
  "gemini",
  "grok",
  "kimi",
  "opencode",
  "qoder",
]);

/**
 * Check whether the agent config maps to a CLI provider.
 */
export function isCliProviderAgentConfig(agentConfig: any) {
  const cliProvider = typeof agentConfig?.cliProvider === "string"
    ? agentConfig.cliProvider.trim().toLowerCase()
    : "";
  const provider = typeof agentConfig?.provider === "string"
    ? agentConfig.provider.trim().toLowerCase()
    : "";
  return Boolean(cliProvider) || CLI_PROVIDER_NAMES.has(provider);
}

/**
 * Detect the current machine ID from environment or machine info.
 */
export async function detectCurrentMachineId(env: EnvLike): Promise<string | undefined> {
  const fromEnv = (env.NOLO_CURRENT_MACHINE_ID || env.NOLO_MACHINE_ID || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const { detectMachineInfo } = await import("../connector-experimental/machineInfo");
    const machine = await detectMachineInfo({ probeLaunchable: true });
    return typeof machine?.machineId === "string" && machine.machineId.trim()
      ? machine.machineId.trim()
      : undefined;
  } catch {
    return undefined;
  }
}
