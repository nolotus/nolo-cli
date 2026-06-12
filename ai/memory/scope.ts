import type {
  MemoryOwnerType,
  MemorySubjectType,
  MemoryVisibility,
} from "./types";

export type MemoryScope = "auto" | "user" | "space";

export interface MemoryScopeTarget {
  ownerType: MemoryOwnerType;
  ownerId: string;
  visibility: MemoryVisibility;
  subjectType: MemorySubjectType;
  subjectId: string;
}

export const buildUserMemoryTarget = (userId: string): MemoryScopeTarget => ({
  ownerType: "user",
  ownerId: userId,
  visibility: "private",
  subjectType: "user",
  subjectId: userId,
});

export const buildSpaceMemoryTarget = (spaceId: string): MemoryScopeTarget => ({
  ownerType: "space",
  ownerId: spaceId,
  visibility: "shared",
  subjectType: "space",
  subjectId: spaceId,
});

export const resolveUserOrSpaceMemoryTarget = (input: {
  userId?: string | null;
  spaceId?: string | null;
}): MemoryScopeTarget | null => {
  if (input.userId) return buildUserMemoryTarget(input.userId);
  if (input.spaceId) return buildSpaceMemoryTarget(input.spaceId);
  return null;
};

export const resolveScopedMemoryTargets = (input: {
  userId?: string | null;
  spaceId?: string | null;
  scope?: MemoryScope;
  fallbackToUserForMissingSpace?: boolean;
}): MemoryScopeTarget[] => {
  const scope = input.scope ?? "auto";
  if (scope === "user") {
    if (!input.userId) throw new Error("memory scope requires userId");
    return [buildUserMemoryTarget(input.userId)];
  }

  if (scope === "space") {
    if (input.spaceId) return [buildSpaceMemoryTarget(input.spaceId)];
    if (input.fallbackToUserForMissingSpace && input.userId) {
      return [buildUserMemoryTarget(input.userId)];
    }
    throw new Error("memory space scope requires spaceId");
  }

  const target = resolveUserOrSpaceMemoryTarget(input);
  return target ? [target] : [];
};

export const buildAgentSubjectTarget = (
  target: Pick<MemoryScopeTarget, "ownerType" | "ownerId" | "visibility">,
  agentKey: string
) => ({
  owner: { ownerType: target.ownerType, ownerId: target.ownerId },
  visibility: target.visibility,
  subjectType: "agent" as const,
  subjectId: agentKey,
});
