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
  contentSubstring?: string;
  limit?: number;
  dryRun?: boolean;
  deletionToken?: string;
}

export interface DeleteMemoryResult {
  deletedCount: number;
  deletedIds: string[];
  matchedItems: MemoryItem[];
  deletionToken?: string;
}

export function hasExplicitDeleteFilters(filters: DeleteMemoryFilters): boolean {
  return Boolean(
    (filters.ids && filters.ids.length > 0) ||
    (typeof filters.contentSubstring === "string" && filters.contentSubstring.trim().length > 0) ||
    (filters.tags && filters.tags.length > 0) ||
    (typeof filters.sourceDialogId === "string" && filters.sourceDialogId.trim().length > 0) ||
    (typeof filters.patternKeyPrefix === "string" && filters.patternKeyPrefix.trim().length > 0) ||
    (filters.facets && filters.facets.length > 0) ||
    (typeof filters.subjectId === "string" && filters.subjectId.trim().length > 0)
  );
}

export function generateMemoryDeletionToken(ownerId: string, itemIds: string[]): string {
  const sorted = [...itemIds].sort().join(",");
  const seed = `${ownerId}:${sorted}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return `tok-${Math.abs(hash).toString(36)}-${itemIds.length}`;
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

  const contentSub = asTrimmedString(filters.contentSubstring);
  if (
    contentSub &&
    !(item.content ?? "").toLowerCase().includes(contentSub.toLowerCase())
  ) {
    return false;
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
  if (!hasExplicitDeleteFilters(filters)) {
    throw new Error(
      "At least one filter is required; delete operation will not delete all memory implicitly."
    );
  }

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

  const token = generateMemoryDeletionToken(
    owner.ownerId,
    matchedItems.map((i) => i.id)
  );

  if (filters.dryRun) {
    return {
      deletedCount: 0,
      deletedIds: [],
      matchedItems,
      deletionToken: token,
    };
  }

  if (filters.deletionToken && filters.deletionToken !== token) {
    throw new Error(
      "deletionToken mismatch: memory dataset changed since preview; please rerun dry-run preview before confirming."
    );
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
    deletionToken: token,
  };
};

export const deleteMemoriesForOwner = async (
  owner: MemoryOwnerRef,
  filters: DeleteMemoryFilters = {}
): Promise<DeleteMemoryResult> => {
  const getDefaultDb = async () => (await import("../../database-engine/db")).default;
  return deleteMemoriesForOwnerFromDb(await getDefaultDb(), owner, filters);
};
