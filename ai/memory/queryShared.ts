import {
  createMemoryKey,
  memoryOwnerRange,
  memorySubjectKindRange,
} from "../../database/keys";
import type {
  MemoryItem,
  MemoryKind,
  MemoryOwnerRef,
  MemorySubjectRef,
} from "./types";

export const chooseMemoryOwners = (input: {
  userId?: string | null;
  spaceId?: string | null;
}): MemoryOwnerRef[] => {
  const owners: MemoryOwnerRef[] = [];
  if (input.userId) {
    owners.push({ ownerType: "user", ownerId: input.userId });
  }
  if (input.spaceId) {
    owners.push({ ownerType: "space", ownerId: input.spaceId });
  }
  return owners;
};

export const loadOwnerItemsFromDb = async (
  db: any,
  owner: MemoryOwnerRef,
  limit: number
): Promise<MemoryItem[]> => {
  const range = memoryOwnerRange(owner.ownerType, owner.ownerId);
  const refs: Array<{ memoryId?: string }> = [];
  for await (const [, value] of db.iterator({
    gte: range.start,
    lte: range.end,
    reverse: true,
  })) {
    refs.push(value ?? {});
    if (refs.length >= limit) break;
  }

  const items = await Promise.all(
    refs.map((ref) =>
      typeof ref?.memoryId === "string"
        ? db
            .get(createMemoryKey(owner.ownerType, owner.ownerId, ref.memoryId))
            .catch(() => null)
        : Promise.resolve(null)
    )
  );
  return items.filter((item): item is MemoryItem => !!item);
};

export const loadSubjectKindItemsFromDb = async (
  db: any,
  subject: MemorySubjectRef,
  kind: MemoryKind,
  limit: number
): Promise<MemoryItem[]> => {
  const range = memorySubjectKindRange(subject.subjectType, subject.subjectId, kind);
  const refs: Array<{ memoryKey?: string }> = [];
  for await (const [, value] of db.iterator({
    gte: range.start,
    lte: range.end,
    reverse: true,
  })) {
    refs.push(value ?? {});
    if (refs.length >= limit) break;
  }

  const items = await Promise.all(
    refs.map((ref) =>
      typeof ref?.memoryKey === "string"
        ? db.get(ref.memoryKey).catch(() => null)
        : Promise.resolve(null)
    )
  );
  return items.filter((item): item is MemoryItem => !!item);
};

export const loadMemoryCandidatesFromDb = async (
  db: any,
  input: {
    owners: MemoryOwnerRef[];
    subjects: MemorySubjectRef[];
    kinds?: MemoryKind[];
    ownerLimit?: number;
    ownerFallback?: "onSubjectMiss" | "always";
  }
): Promise<MemoryItem[]> => {
  const kinds = input.kinds ?? ["episodic", "semantic", "procedural"];
  const ownerLimit = input.ownerLimit ?? 12;
  const ownerFallback = input.ownerFallback ?? "onSubjectMiss";
  const ownerKeySet = new Set(
    input.owners
      .filter((owner) => owner.ownerId)
      .map((owner) => `${owner.ownerType}:${owner.ownerId}`)
  );
  const subjects = input.subjects.filter(
    (subject): subject is MemorySubjectRef => !!subject.subjectId
  );

  const subjectResults =
    subjects.length > 0
      ? await Promise.all(
          subjects.flatMap((subject) =>
            kinds.map((kind) =>
              loadSubjectKindItemsFromDb(db, subject, kind, ownerLimit)
            )
          )
        )
      : [];
  const subjectHitCount = subjectResults.reduce((sum, items) => sum + items.length, 0);
  const shouldLoadOwnerFallback =
    subjects.length === 0 || subjectHitCount === 0 || ownerFallback === "always";
  const results = shouldLoadOwnerFallback
    ? await Promise.all(
        [
          ...subjectResults,
          ...input.owners.map((owner) => loadOwnerItemsFromDb(db, owner, ownerLimit)),
        ]
      )
    : subjectResults;

  const kindSet = new Set(kinds);
  const seen = new Set<string>();
  const merged: MemoryItem[] = [];
  for (const items of results) {
    for (const item of items) {
      if (seen.has(item.id)) continue;
      if (!kindSet.has(item.kind)) continue;
      if (
        ownerKeySet.size > 0 &&
        !ownerKeySet.has(`${item.ownerType}:${item.ownerId}`)
      ) {
        continue;
      }
      if (
        !shouldLoadOwnerFallback &&
        subjects.length > 0 &&
        !subjects.some(
          (subject) =>
            subject.subjectType === item.subjectType &&
            subject.subjectId === item.subjectId
        )
      ) {
        continue;
      }
      seen.add(item.id);
      merged.push(item);
    }
  }

  return merged;
};

export const buildDefaultSubjects = (input: {
  userId?: string | null;
  spaceId?: string | null;
  agentKey: string;
}): MemorySubjectRef[] =>
  [
    { subjectType: "agent", subjectId: input.agentKey },
    input.userId ? { subjectType: "user", subjectId: input.userId } : null,
    input.spaceId ? { subjectType: "space", subjectId: input.spaceId } : null,
  ].filter((value): value is MemorySubjectRef => !!value);
