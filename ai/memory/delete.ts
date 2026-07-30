import { asTrimmedNonEmptyStringArray } from "../../core/stringArray";
import { asTrimmedString } from "../../core/trimmedString";
import {
  createMemoryKey,
  createMemoryOwnerIndexKey,
  createMemorySubjectKindIndexKey,
  memoryOwnerRange,
} from "../../database/keys";
import type {
  MemoryFacet,
  MemoryItem,
  MemoryKind,
  MemoryOwnerRef,
  MemorySubjectType,
} from "./types";

interface DeleteMemoryFilters {
  ids?: string[];
  kinds?: MemoryKind[];
  facets?: MemoryFacet[];
  subjectType?: MemorySubjectType;
  subjectId?: string;
  patternKeyPrefix?: string;
  sourceDialogId?: string;
  tags?: string[];
  limit?: number;
}

export interface DeleteMemoryResult {
  deletedCount: number;
  deletedIds: string[];
  matchedItems: MemoryItem[];
}

const normalizeSet = (values?: string[]): Set<string> | null => {
  if (!Array.isArray(values) || values.length === 0) return null;
  const normalized = asTrimmedNonEmptyStringArray(values);
  return normalized.length > 0 ? new Set(normalized) : null;
};

const matchesFilters = (item: MemoryItem, filters: DeleteMemoryFilters): boolean => {
  const idSet = normalizeSet(filters.ids);
  if (idSet && !idSet.has(item.id)) return false;

  const kindSet = normalizeSet(filters.kinds);
  if (kindSet && !kindSet.has(item.kind)) return false;

  const facetSet = normalizeSet(filters.facets);
  if (facetSet && (!item.facet || !facetSet.has(item.facet))) return false;

  if (filters.subjectType && item.subjectType !== filters.subjectType) return false;
  if (filters.subjectId && item.subjectId !== filters.subjectId) return false;

  const prefix = asTrimmedString(filters.patternKeyPrefix);
  if (prefix && !(item.patternKey ?? "").startsWith(prefix)) return false;

  if (filters.sourceDialogId && item.sourceDialogId !== filters.sourceDialogId) {
    return false;
  }

  const tagSet = normalizeSet(filters.tags);
  if (tagSet) {
    const itemTags = new Set(asTrimmedNonEmptyStringArray(item.tags));
    for (const tag of tagSet) {
      if (!itemTags.has(tag)) return false;
    }
  }

  return true;
};

const deleteMemoryItemWithIndexesInBatch = (
  batch: any,
  item: MemoryItem
) => {
  batch.del(createMemoryKey(item.ownerType, item.ownerId, item.id));
  batch.del(
    createMemoryOwnerIndexKey(
      item.ownerType,
      item.ownerId,
      item.createdAt,
      item.id
    )
  );
  batch.del(
    createMemorySubjectKindIndexKey(
      item.subjectType,
      item.subjectId,
      item.kind,
      item.createdAt,
      item.id
    )
  );
};

export const deleteMemoriesForOwnerFromDb = async (
  db: any,
  owner: MemoryOwnerRef,
  filters: DeleteMemoryFilters = {}
): Promise<DeleteMemoryResult> => {
  const range = memoryOwnerRange(owner.ownerType, owner.ownerId);
  const matchedItems: MemoryItem[] = [];
  const limit = typeof filters.limit === "number" && filters.limit > 0
    ? filters.limit
    : Number.POSITIVE_INFINITY;

  for await (const [, value] of db.iterator({
    gte: range.start,
    lte: range.end,
    reverse: true,
  })) {
    const memoryId = typeof value?.memoryId === "string" ? value.memoryId : "";
    if (!memoryId) continue;
    const item = (await db
      .get(createMemoryKey(owner.ownerType, owner.ownerId, memoryId))
      .catch(() => null)) as MemoryItem | null;
    if (!item) continue;
    if (!matchesFilters(item, filters)) continue;
    matchedItems.push(item);
    if (matchedItems.length >= limit) break;
  }

  if (matchedItems.length === 0) {
    return { deletedCount: 0, deletedIds: [], matchedItems: [] };
  }

  const batch = db.batch();
  for (const item of matchedItems) {
    deleteMemoryItemWithIndexesInBatch(batch, item);
  }
  await batch.write();

  return {
    deletedCount: matchedItems.length,
    deletedIds: matchedItems.map((item) => item.id),
    matchedItems,
  };
};

export const deleteMemoriesForOwner = async (
  owner: MemoryOwnerRef,
  filters: DeleteMemoryFilters = {}
): Promise<DeleteMemoryResult> => {
  const getDefaultDb = async () => (await import("../../database-engine/db")).default;
  return deleteMemoriesForOwnerFromDb(await getDefaultDb(), owner, filters);
};
