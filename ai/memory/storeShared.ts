import { createHash } from "crypto";
import { ulid } from "../../database/utils/ulid";
import {
  createMemoryKey,
  createMemoryOwnerIndexKey,
  createMemorySubjectKindIndexKey,
} from "../../database/keys";
import type {
  MemoryItem,
  MemoryKind,
  MemoryOwnerType,
  MemorySubjectType,
} from "./types";

/**
 * 计算记忆的语义内容标识（contentKey）。
 *
 * 输入：ownerType + ownerId + subjectType + subjectId + kind + content
 * 输出：`mem-{sha256 前 16 字符 hex}`
 *
 * 64 位空间，百万条碰撞概率 2.7e-8——远超实际数据量需求。
 * 同一条记忆无论在本地还是远程生成，只要内容相同，contentKey 相同，
 * `mergeAndDedupUserData` 据此跨实例去重。
 *
 * 用 JSON.stringify 做无歧义序列化——字段值里的冒号不会造成碰撞。
 */
export const computeMemoryContentKey = (input: {
  ownerType: MemoryOwnerType;
  ownerId: string;
  subjectType: MemorySubjectType;
  subjectId: string;
  kind: MemoryKind;
  content: string;
}): string => {
  const seed = JSON.stringify([
    input.ownerType,
    input.ownerId,
    input.subjectType,
    input.subjectId,
    input.kind,
    input.content,
  ]);
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  return `mem-${hash}`;
};

/**
 * 从 MemoryItem 提取 contentKey 计算所需的 6 个字段。
 * 避免在各调用处手动展开同 6 个字段——改字段时只改这里。
 */
export const memoryContentKeyInput = (
  item: Pick<MemoryItem, "ownerType" | "ownerId" | "subjectType" | "subjectId" | "kind" | "content">,
) => ({
  ownerType: item.ownerType,
  ownerId: item.ownerId,
  subjectType: item.subjectType,
  subjectId: item.subjectId,
  kind: item.kind,
  content: item.content,
});

export const createMemoryItem = (
  input: Omit<MemoryItem, "id" | "createdAt" | "lastActivatedAt" | "activationCount" | "contentKey">
): MemoryItem => {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    contentKey: computeMemoryContentKey(input),
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

export const MIN_MEMORY_CONFIDENCE = 0.05;
export const MAX_MEMORY_CONFIDENCE = 0.95;

const clampConfidence = (value: number): number =>
  Math.min(MAX_MEMORY_CONFIDENCE, Math.max(MIN_MEMORY_CONFIDENCE, value));

/**
 * Shift confidence on stored items (positive = reinforce, negative = penalize).
 * Reads the freshest copy of each item first so a concurrent touch is not
 * clobbered, then writes back the adjusted confidence.
 */
export const adjustMemoryConfidenceInDb = async (
  db: any,
  items: MemoryItem[],
  delta: number
): Promise<MemoryItem[]> => {
  if (items.length === 0 || delta === 0) return [];
  const fresh = await Promise.all(
    items.map((item) =>
      db
        .get(createMemoryKey(item.ownerType, item.ownerId, item.id))
        .catch(() => null)
    )
  );
  const updated: MemoryItem[] = [];
  const batch = db.batch();
  for (const item of fresh) {
    if (!item) continue;
    const next: MemoryItem = {
      ...item,
      confidence: clampConfidence((item.confidence ?? 0) + delta),
    };
    batch.put(createMemoryKey(next.ownerType, next.ownerId, next.id), next);
    updated.push(next);
  }
  if (updated.length === 0) return [];
  await batch.write();
  return updated;
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
