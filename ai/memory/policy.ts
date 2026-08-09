import type { MemorySubjectRef } from "./types";

export type MemoryOwnerFallback = "onSubjectMiss" | "always";

export type AgentMemoryPolicy = {
  includeUserSubject: boolean;
  ownerFallback: MemoryOwnerFallback;
  allowDynamicGreetingMemory: boolean;
};

export function isPublicAgentKey(agentKey?: string | null): boolean {
  return typeof agentKey === "string" && /^agent-pub-/i.test(agentKey.trim());
}

export function resolveAgentMemoryPolicy(input: {
  agentKey?: string | null;
  isPublicAgent?: boolean | null;
}): AgentMemoryPolicy {
  const publicAgent = input.isPublicAgent === true || isPublicAgentKey(input.agentKey);
  if (publicAgent) {
    return {
      includeUserSubject: false,
      ownerFallback: "onSubjectMiss",
      allowDynamicGreetingMemory: false,
    };
  }

  return {
    includeUserSubject: true,
    ownerFallback: "always",
    allowDynamicGreetingMemory: true,
  };
}

export function buildMemorySubjectsForAgent(input: {
  userId?: string | null;
  spaceId?: string | null;
  agentKey: string;
  memorySubjectId?: string | null;
  policy?: AgentMemoryPolicy;
}): MemorySubjectRef[] {
  const policy = input.policy ?? resolveAgentMemoryPolicy({ agentKey: input.agentKey });
  const result: MemorySubjectRef[] = [];
  const agentSubject = input.memorySubjectId?.trim();
  if (agentSubject) {
    result.push({ subjectType: "agent", subjectId: agentSubject });
  }
  if (policy.includeUserSubject && input.userId) {
    result.push({ subjectType: "user", subjectId: input.userId });
  }
  if (input.spaceId) {
    result.push({ subjectType: "space", subjectId: input.spaceId });
  }
  return result;
}
