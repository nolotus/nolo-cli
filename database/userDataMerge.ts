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

const getItemKey = (item: MergeableUserDataItem): string | null => {
  // dbKey 必须优先于 id：dbKey 是全局唯一的 "type-userId-id" 格式，
  // 而 id 可能只是 ULID 短串，与本地 tombstone 的 dbKey 不匹配会导致
  // merge 时 tombstone 无法覆盖远端活记录。
  const candidates = [
    typeof item.dbKey === "string" ? item.dbKey : undefined,
    item.id,
    typeof item.contentKey === "string" ? item.contentKey : undefined,
    typeof item.appKey === "string" ? item.appKey : undefined,
    typeof item.appId === "string" ? item.appId : undefined,
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
