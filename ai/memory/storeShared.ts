import { ulid } from "../../database/utils/ulid";
import {
  createMemoryKey,
  createMemoryOwnerIndexKey,
  createMemorySubjectKindIndexKey,
} from "../../database/keys";
import type { MemoryItem } from "./types";

export const createMemoryItem = (
  input: Omit<MemoryItem, "id" | "createdAt" | "lastActivatedAt" | "activationCount">
): MemoryItem => {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    createdAt: now,
    lastActivatedAt: now,
    activationCount: 0,
    ...input,
  };
};

export const writeMemoryItemWithIndexesToDb = async (
  db: any,
  item: MemoryItem
): Promise<void> => {
  const batch = db.batch();
  batch.put(createMemoryKey(item.ownerType, item.ownerId, item.id), item);
  batch.put(
    createMemoryOwnerIndexKey(
      item.ownerType,
      item.ownerId,
      item.createdAt,
      item.id
    ),
    {
      memoryKey: createMemoryKey(item.ownerType, item.ownerId, item.id),
      ownerType: item.ownerType,
      ownerId: item.ownerId,
      memoryId: item.id,
    }
  );
  batch.put(
    createMemorySubjectKindIndexKey(
      item.subjectType,
      item.subjectId,
      item.kind,
      item.createdAt,
      item.id
    ),
    {
      memoryKey: createMemoryKey(item.ownerType, item.ownerId, item.id),
      subjectType: item.subjectType,
      subjectId: item.subjectId,
      kind: item.kind,
      memoryId: item.id,
    }
  );
  await batch.write();
};

export const touchMemoryItemsInDb = async (
  db: any,
  items: MemoryItem[],
  now = new Date().toISOString()
): Promise<void> => {
  if (items.length === 0) return;
  const batch = db.batch();
  for (const item of items) {
    batch.put(createMemoryKey(item.ownerType, item.ownerId, item.id), {
      ...item,
      lastActivatedAt: now,
      activationCount: (item.activationCount ?? 0) + 1,
    });
  }
  await batch.write();
};
