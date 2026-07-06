import {
  getRecordTimestamp,
  isTombstoneRecord,
  shouldReplaceWithNextRecord,
} from "./tombstones";

interface MergeableUserDataItem {
  id?: string;
  dbKey?: string;
  contentKey?: string;
  appKey?: string;
  appId?: string;
  [key: string]: any;
}

export const getUserDataItemTimestamp = (dataItem: MergeableUserDataItem): number =>
  getRecordTimestamp(dataItem);

export const getItemKey = (item: MergeableUserDataItem): string | null => {
  // contentKey/dbKey 是跨本地 tombstone、远端 summary、完整记录共享的实体键。
  // raw id 可能只是 ULID/短 id；如果优先使用 id，deleted tombstone 会无法覆盖
  // 只带 contentKey 的远端活记录，导致已删除内容重新出现在列表里。
  const candidates = [
    typeof item.contentKey === "string" ? item.contentKey : undefined,
    typeof item.dbKey === "string" ? item.dbKey : undefined,
    typeof item.appKey === "string" ? item.appKey : undefined,
    typeof item.appId === "string" ? item.appId : undefined,
    item.id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return null;
};

export const mergeAndDedupUserData = (
  localData: MergeableUserDataItem[],
  remoteResults: any[],
  options: { includeDeleted?: boolean } = {}
): MergeableUserDataItem[] => {
  const uniqueMap = new Map<string, MergeableUserDataItem>();

  const mergeRecordMetadata = (
    currentItem: MergeableUserDataItem,
    nextItem: MergeableUserDataItem
  ): MergeableUserDataItem => {
    if (
      typeof currentItem.serverOrigin !== "string" &&
      typeof nextItem.serverOrigin === "string" &&
      nextItem.serverOrigin.trim().length > 0
    ) {
      return {
        ...currentItem,
        serverOrigin: nextItem.serverOrigin,
      };
    }

    return currentItem;
  };

  const addToMap = (item: MergeableUserDataItem) => {
    const itemKey = getItemKey(item);
    if (!itemKey) return;

    const existing = uniqueMap.get(itemKey);
    if (!existing) {
      uniqueMap.set(itemKey, item);
      return;
    }

    if (shouldReplaceWithNextRecord(item, existing)) {
      uniqueMap.set(itemKey, item);
      return;
    }

    uniqueMap.set(itemKey, mergeRecordMetadata(existing, item));
  };

  localData.forEach(addToMap);
  remoteResults.forEach((result) => {
    const items = result?.data?.data;
    if (Array.isArray(items)) {
      items.forEach(addToMap);
    }
  });

  const merged = Array.from(uniqueMap.values());
  return options.includeDeleted
    ? merged
    : merged.filter((item) => !isTombstoneRecord(item));
};
