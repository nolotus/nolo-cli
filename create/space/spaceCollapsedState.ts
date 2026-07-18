import { asRecordOrEmpty } from "../../core/recordOrEmpty";

import { UNCATEGORIZED_ID } from "./constants";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const SPACE_COLLAPSE_STORAGE_PREFIX = "space-collapsed-categories:";

export const normalizeCollapsedCategories = (
  value: unknown,
): Record<string, boolean> => {
  const entries = Object.entries(asRecordOrEmpty(value)).filter(
    ([key, collapsed]) => typeof key === "string" && typeof collapsed === "boolean",
  );
  return Object.fromEntries(entries);
};

const storageKeyForSpace = (spaceId: string) =>
  `${SPACE_COLLAPSE_STORAGE_PREFIX}${spaceId}`;

export const readStoredCollapsedCategories = (
  spaceId: string,
  storage: StorageLike | null | undefined,
): Record<string, boolean> => {
  if (!spaceId || !storage) return {};

  try {
    const raw = storage.getItem(storageKeyForSpace(spaceId));
    if (!raw) return { [UNCATEGORIZED_ID]: false };
    return normalizeCollapsedCategories(JSON.parse(raw));
  } catch (error) {
    console.warn("[Space] 读取分类折叠状态失败:", error);
    return {};
  }
};

export const writeStoredCollapsedCategories = (
  spaceId: string,
  collapsedCategories: Record<string, boolean>,
  storage: StorageLike | null | undefined,
) => {
  if (!spaceId || !storage) return;

  try {
    storage.setItem(
      storageKeyForSpace(spaceId),
      JSON.stringify(normalizeCollapsedCategories(collapsedCategories)),
    );
  } catch (error) {
    console.warn("[Space] 保存分类折叠状态失败:", error);
  }
};
