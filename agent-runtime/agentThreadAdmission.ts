/**
 * Default maxConcurrent used when an agent has no admission config.
 * v0 policy: hard-coded to 2 until per-agent config is widely adopted.
 */
export const DEFAULT_AGENT_THREAD_MAX_CONCURRENT = 2;

export type AgentThreadAdmissionConfig = {
  maxConcurrent?: unknown;
};

export type AgentThreadAdmissionAgentConfig = {
  maxConcurrent?: unknown;
  admission?: AgentThreadAdmissionConfig | null;
} | null | undefined;

export type AgentThreadAdmissionDecision =
  | {
      allowed: true;
      activeThreadCount: number;
      maxConcurrent: number;
    }
  | {
      allowed: false;
      reason: "max_concurrent_reached";
      activeThreadCount: number;
      maxConcurrent: number;
    };

export function normalizeAgentThreadMaxConcurrent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

export function resolveAgentThreadMaxConcurrent(
  agentConfig: AgentThreadAdmissionAgentConfig,
): number | null {
  const nestedLimit = normalizeAgentThreadMaxConcurrent(
    agentConfig?.admission?.maxConcurrent,
  );
  if (nestedLimit != null) return nestedLimit;
  return normalizeAgentThreadMaxConcurrent(agentConfig?.maxConcurrent);
}

export function decideAgentThreadAdmission(input: {
  agentConfig: AgentThreadAdmissionAgentConfig;
  activeThreadCount: number;
}): AgentThreadAdmissionDecision {
  const activeThreadCount =
    typeof input.activeThreadCount === "number" &&
    Number.isFinite(input.activeThreadCount) &&
    input.activeThreadCount > 0
      ? Math.floor(input.activeThreadCount)
      : 0;
  const maxConcurrent =
    resolveAgentThreadMaxConcurrent(input.agentConfig) ??
    DEFAULT_AGENT_THREAD_MAX_CONCURRENT;

  if (activeThreadCount < maxConcurrent) {
    return {
      allowed: true,
      activeThreadCount,
      maxConcurrent,
    };
  }

  return {
    allowed: false,
    reason: "max_concurrent_reached",
    activeThreadCount,
    maxConcurrent,
  };
}
