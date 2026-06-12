import serverDb from "../../database/server/db";
import { resolveScopedMemoryTargets, type MemoryScope } from "./scope";
import { createMemoryItem, writeMemoryItemWithIndexesToDb } from "./store";
import type {
  MemoryItem,
  MemoryKind,
  MemoryOwnerType,
  MemorySubjectType,
  MemoryVisibility,
} from "./types";

export type RememberMemoryScope = MemoryScope;

export interface RememberMemoryInput {
  db?: any;
  userId?: string | null;
  spaceId?: string | null;
  dialogId?: string | null;
  content: string;
  scope?: RememberMemoryScope;
  kind?: MemoryKind;
}

export interface RememberMemoryResult {
  success: true;
  content: string;
  requestedScope: RememberMemoryScope;
  savedItems: MemoryItem[];
  resolvedScopes: Array<{
    ownerType: MemoryOwnerType;
    ownerId: string;
    subjectType: MemorySubjectType;
    subjectId: string;
    visibility: MemoryVisibility;
  }>;
}

const MEMORY_KINDS = new Set<MemoryKind>(["episodic", "semantic", "procedural"]);

export const rememberMemory = async (
  input: RememberMemoryInput
): Promise<RememberMemoryResult> => {
  const content = input.content.trim();
  if (!content) {
    throw new Error("rememberMemory: content is required");
  }

  const scope = input.scope ?? "auto";
  let targets: ReturnType<typeof resolveScopedMemoryTargets>;
  try {
    targets = resolveScopedMemoryTargets({
      userId: input.userId,
      spaceId: input.spaceId,
      scope,
      fallbackToUserForMissingSpace: true,
    });
  } catch (error) {
    if (scope === "user") {
      throw new Error("rememberMemory: user scope requires userId");
    }
    if (scope === "space") {
      throw new Error("rememberMemory: space scope requires spaceId");
    }
    throw error;
  }
  if (targets.length === 0) {
    throw new Error("rememberMemory: no valid owner scope found");
  }

  const db = input.db ?? serverDb;
  const kind = input.kind ?? "episodic";
  if (!MEMORY_KINDS.has(kind)) {
    throw new Error("rememberMemory: kind must be episodic, semantic, or procedural");
  }
  const savedItems: MemoryItem[] = [];
  for (const target of targets) {
    const item = createMemoryItem({
      ownerType: target.ownerType,
      ownerId: target.ownerId,
      visibility: target.visibility,
      subjectType: target.subjectType,
      subjectId: target.subjectId,
      kind,
      content,
      importance: kind === "procedural" ? 0.88 : target.ownerType === "user" ? 0.82 : 0.76,
      confidence: kind === "procedural" ? 0.78 : 0.72,
      tags:
        target.ownerType === "user"
          ? ["agent-remembered", ...(kind === "procedural" ? ["procedural-memory"] : [])]
          : ["agent-remembered", "space-context", ...(kind === "procedural" ? ["procedural-memory"] : [])],
      patternKey: kind === "procedural" ? "procedural-runbook" : "agent-remember",
      sourceDialogId: input.dialogId ?? undefined,
    });
    await writeMemoryItemWithIndexesToDb(db, item);
    savedItems.push(item);
  }

  return {
    success: true,
    content,
    requestedScope: scope,
    savedItems,
    resolvedScopes: targets.map((target) => ({
      ownerType: target.ownerType,
      ownerId: target.ownerId,
      subjectType: target.subjectType,
      subjectId: target.subjectId,
      visibility: target.visibility,
    })),
  };
};
