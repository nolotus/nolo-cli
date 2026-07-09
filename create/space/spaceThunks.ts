// create/space/spaceThunks.ts
import type { SpaceContent, SpaceData } from "../../app/types";
import { patch, read } from "../../database/dbSlice";
import { addSpaceAction } from "./addSpaceAction";
import { deleteSpaceAction } from "./deleteSpaceAction";
import { fetchSpaceAction } from "./fetchSpaceAction";
import { loadDefaultSpaceAction } from "./loadDefaultSpaceAction";
import { createSpaceKey, normalizeSpaceId } from "./spaceKeys";
import { updateSpaceAction } from "./updateSpaceAction";
import { fetchSpaceSidebarStateAction } from "./fetchSpaceSidebarStateAction";
import { changeSpaceAction } from "./changeSpaceAction";
import { type SpaceState } from "./types";

type Create = {
  asyncThunk: (...args: any[]) => any;
  reducer: (...args: any[]) => any;
};

const parseUpdatedAt = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? ts : 0;
  }
  return 0;
};

const dedupeMemberSpaces = <T extends { spaceId: string }>(memberSpaces: T[]): T[] => {
  const membershipMap = new Map<string, T>();
  memberSpaces.forEach((space) => {
    const nextUpdatedAt = parseUpdatedAt(
      (space as any).spaceUpdatedAt ??
        (space as any).memberUpdatedAt ??
        (space as any).updatedAt ??
        (space as any).createdAt ??
        (space as any).joinedAt
    );
    const prev = membershipMap.get(space.spaceId);
    const prevUpdatedAt = prev
      ? parseUpdatedAt(
          (prev as any).spaceUpdatedAt ??
            (prev as any).memberUpdatedAt ??
            (prev as any).updatedAt ??
            (prev as any).createdAt ??
            (prev as any).joinedAt
        )
      : -1;
    if (!prev || nextUpdatedAt >= prevUpdatedAt) {
      membershipMap.set(space.spaceId, space);
    }
  });
  return Array.from(membershipMap.values());
};

const extractTypedIdentityId = (key: string, type: string): string | null => {
  if (!key || !type || !key.startsWith(`${type}-`)) return null;
  const parts = key.split("-");
  if (parts.length < 2) return null;
  if (parts.length >= 3) return parts.slice(2).join("-");
  return parts[1] || null;
};

const isCanonicalTypedDbKey = (key: string, type: string): boolean => {
  if (!key || !type || !key.startsWith(`${type}-`)) return false;
  const parts = key.split("-");
  return parts.length >= 3;
};

const dedupeSpaceContents = (
  contents: Record<string, SpaceContent | null> | undefined
): {
  contents: Record<string, SpaceContent | null>;
  removedKeys: string[];
  changed: boolean;
} => {
  if (!contents) return { contents: {}, removedKeys: [], changed: false };

  const entries = Object.entries(contents);
  const sorted = [...entries].sort((a, b) => {
    const aItem = a[1];
    const bItem = b[1];
    const aType = String(aItem?.type || "").toLowerCase();
    const bType = String(bItem?.type || "").toLowerCase();
    const aCanonical =
      isCanonicalTypedDbKey(a[0], aType) ||
      isCanonicalTypedDbKey(String(aItem?.contentKey || ""), aType);
    const bCanonical =
      isCanonicalTypedDbKey(b[0], bType) ||
      isCanonicalTypedDbKey(String(bItem?.contentKey || ""), bType);

    if (aCanonical !== bCanonical) return aCanonical ? -1 : 1;

    const aUpdated = parseUpdatedAt(aItem?.updatedAt);
    const bUpdated = parseUpdatedAt(bItem?.updatedAt);
    return bUpdated - aUpdated;
  });

  let changed = false;
  const deduped: Record<string, SpaceContent | null> = {};
  const seenIdentity = new Set<string>();

  for (const [entryKey, item] of sorted) {
    if (!item) {
      if (Object.prototype.hasOwnProperty.call(deduped, entryKey)) changed = true;
      else deduped[entryKey] = item;
      continue;
    }

    const normalizedType = String(item.type || "").toLowerCase();
    const currentContentKey = String(item.contentKey || entryKey);
    const typedIdFromEntry = extractTypedIdentityId(entryKey, normalizedType);
    const typedIdFromContent = extractTypedIdentityId(currentContentKey, normalizedType);
    const identityId = typedIdFromEntry || typedIdFromContent || currentContentKey || entryKey;
    const identity = `${normalizedType || "unknown"}:${identityId}`;

    if (seenIdentity.has(identity)) {
      changed = true;
      continue;
    }
    seenIdentity.add(identity);

    const contentKeyIsCanonical = isCanonicalTypedDbKey(
      currentContentKey,
      normalizedType
    );
    const entryKeyIsCanonical = isCanonicalTypedDbKey(entryKey, normalizedType);
    const canonicalKey =
      (contentKeyIsCanonical && currentContentKey) ||
      (entryKeyIsCanonical && entryKey) ||
      entryKey;
    const canonicalContentKey =
      (contentKeyIsCanonical && currentContentKey) ||
      (entryKeyIsCanonical && entryKey) ||
      currentContentKey;

    if (canonicalKey !== entryKey || canonicalContentKey !== item.contentKey) {
      changed = true;
    }

    deduped[canonicalKey] = {
      ...item,
      contentKey: canonicalContentKey,
    };
  }

  const removedKeys = Object.keys(contents).filter(
    (key) => !Object.prototype.hasOwnProperty.call(deduped, key)
  );

  if (!changed && removedKeys.length > 0) {
    changed = true;
  }

  return { contents: deduped, removedKeys, changed };
};

/**
 * 创建与 Space 操作相关的 Async Thunks
 * @param create - 由 buildCreateSlice 提供的创建器对象
 */
export const createSpaceThunks = (create: Create) => ({
  // --- 读取当前设备下的空间侧边栏状态 ---
  fetchSpaceSidebarState: create.asyncThunk(fetchSpaceSidebarStateAction, {
    fulfilled: (state: SpaceState, action: any) => {
      state.collapsedCategories = action.payload.collapsedCategories;
    },
    rejected: (state: SpaceState, action: any) => {
      console.error("获取空间侧边栏状态失败:", action.error.message);
      state.collapsedCategories = {};
    },
  }),

  // --- 切换空间 (核心操作) ---
  changeSpace: create.asyncThunk(changeSpaceAction, {
    pending: (state: SpaceState, action: any) => {
      const newSpaceId = normalizeSpaceId(action.meta.arg);
      if (state.currentSpaceId !== newSpaceId) {
        state.loading = true;
        // Wait until changeSpace.fulfilled before exposing the route space.
        // Otherwise selectCurrentSpace can render stale local cache for a
        // space the current user can no longer access.
        state.currentSpace = null;
      }
      state.error = undefined;
    },
    fulfilled: (state: SpaceState, action: any) => {
      state.currentSpaceId = action.payload.spaceId;
      state.currentSpace = action.payload.spaceData;
      // 原子更新：在内容显示的同一帧应用折叠状态
      state.collapsedCategories =
        action.payload.sidebarState?.collapsedCategories || {};
      state.initialized = true;
      state.loading = false;
    },
    rejected: (state: SpaceState, action: any) => {
      state.error = action.error.message || "切换空间失败";
      state.initialized = true;
      state.loading = false;
      state.currentSpaceId = null;
      state.currentSpace = null;
      state.collapsedCategories = {};
    },
  }),

  // ... (保留后面的 actions 不变，只需对齐缩进)

  // --- 其他核心空间操作 ---
  addSpace: create.asyncThunk(addSpaceAction, {
    fulfilled: (state: SpaceState, action: any) => {
      state.memberSpaces = dedupeMemberSpaces([
        ...(state.memberSpaces || []),
        action.payload,
      ]);
    },
    pending: (state: SpaceState) => {
      state.loading = true;
    },
    rejected: (state: SpaceState, action: any) => {
      state.loading = false;
      state.error = action.error.message;
    },
  }),

  deleteSpace: create.asyncThunk(deleteSpaceAction, {
    fulfilled: (state: SpaceState, action: any) => {
      const normalizedSpaceId = normalizeSpaceId(action.payload.spaceId);
      const normalizedCurrentSpaceId = state.currentSpaceId
        ? normalizeSpaceId(state.currentSpaceId)
        : null;
      if (state.memberSpaces) {
        state.memberSpaces = state.memberSpaces.filter(
          (space) => normalizeSpaceId(space.spaceId) !== normalizedSpaceId
        );
      }
      if (normalizedCurrentSpaceId === normalizedSpaceId) {
        state.currentSpace = null;
        state.currentSpaceId = null;
        state.collapsedCategories = {};
        state.viewMode = "all";
      }
    },
  }),

  updateSpace: create.asyncThunk(updateSpaceAction, {
    fulfilled: (state: SpaceState, action: any) => {
      const { updatedSpace, spaceId } = action.payload;
      if (spaceId === state.currentSpaceId) {
        state.currentSpace = updatedSpace;
      }
      if (state.memberSpaces && updatedSpace.name) {
        state.memberSpaces = state.memberSpaces.map((space) =>
          space.spaceId === updatedSpace.id
            ? { ...space, spaceName: updatedSpace.name }
            : space
        );
      }
    },
  }),

  loadDefaultSpace: create.asyncThunk(loadDefaultSpaceAction, {
    pending: (state: SpaceState) => {
      state.loading = true;
      state.initialized = false;
      state.error = undefined;
    },
    fulfilled: (state: SpaceState) => {
      state.loading = false;
      // 实际状态更新由内部派发的 changeSpace Thunk 处理
      if (!state.currentSpaceId) {
        state.initialized = true;
        state.collapsedCategories = {};
      }
    },
    rejected: (state: SpaceState, action: any) => {
      state.loading = false;
      state.initialized = true;
      state.error = action.error.message || "加载默认空间失败";
      state.currentSpaceId = null;
      state.currentSpace = null;
      state.collapsedCategories = {};
    },
  }),

  fetchSpace: create.asyncThunk(fetchSpaceAction, {
    fulfilled: (state: SpaceState, action: any) => {
      const { spaceId, spaceData } = action.payload;
      // 如果当前没有空间，或者 ID 匹配，则更新当前空间
      if (!state.currentSpaceId || state.currentSpaceId === spaceId) {
        state.currentSpaceId = spaceId;
        state.currentSpace = spaceData;
        state.initialized = true;
      }
    },
  }),

  fixSpace: create.asyncThunk(
    async (spaceId: string, thunkAPI: any) => {
      const spaceKey = createSpaceKey.space(spaceId);
      const spaceData = (await thunkAPI.dispatch(
        read({ dbKey: spaceKey })
      ).unwrap()) as SpaceData | null;

      if (!spaceData) {
        throw new Error("空间不存在");
      }

      const changes: Partial<Pick<SpaceData, "id" | "contents" | "updatedAt">> = {};
      const spaceDataId = String(spaceData.id || "");
      if (spaceDataId.startsWith("space-")) {
        changes.id = spaceDataId.slice(6);
      }

      const {
        contents: dedupedContents,
        removedKeys,
        changed: deduped,
      } = dedupeSpaceContents(spaceData.contents);

      const agentReferenceEntries = Object.entries(dedupedContents).filter(
        ([entryKey, item]) => {
          if (!item) return false;
          const normalizedType = String(item.type || "").toLowerCase();
          const contentKey = String(item.contentKey || entryKey);
          return (
            normalizedType === "agent" ||
            normalizedType === "cybot" ||
            contentKey.startsWith("agent-") ||
            contentKey.startsWith("cybot-") ||
            entryKey.startsWith("agent-") ||
            entryKey.startsWith("cybot-")
          );
        }
      );

      const orphanAgentEntryKeys = (
        await Promise.all(
          agentReferenceEntries.map(async ([entryKey, item]) => {
            const dbKey = String(item?.contentKey || entryKey);
            try {
              const entity = await thunkAPI.dispatch(
                read({ dbKey })
              ).unwrap();
              return entity ? null : entryKey;
            } catch {
              return entryKey;
            }
          })
        )
      ).filter((key): key is string => !!key);

      let contentChanges: Record<string, SpaceContent | null> | null = null;
      if (deduped) {
        contentChanges = { ...dedupedContents };
        for (const removedKey of removedKeys) {
          if (!Object.prototype.hasOwnProperty.call(contentChanges, removedKey)) {
            contentChanges[removedKey] = null;
          }
        }
      }
      if (orphanAgentEntryKeys.length > 0) {
        if (!contentChanges) contentChanges = { ...dedupedContents };
        orphanAgentEntryKeys.forEach((entryKey) => {
          contentChanges![entryKey] = null;
        });
      }
      if (contentChanges) {
        changes.contents = contentChanges;
      }

      if (Object.keys(changes).length === 0) {
        return {
          repaired: false,
          deduped: false,
          prunedOrphanAgentRefs: 0,
          spaceData,
        };
      }

      changes.updatedAt = Math.max(
        Date.now(),
        parseUpdatedAt(spaceData.updatedAt) + 1
      );

      await thunkAPI.dispatch(
        patch({ dbKey: spaceKey, changes })
      ).unwrap();

      const refreshedSpaceData = (await thunkAPI.dispatch(
        read({ dbKey: spaceKey })
      ).unwrap()) as SpaceData | null;

      return {
        repaired: true,
        deduped,
        prunedOrphanAgentRefs: orphanAgentEntryKeys.length,
        spaceData: refreshedSpaceData || ({ ...spaceData, ...changes } as SpaceData),
      };
    },
    {
      fulfilled: (state: SpaceState, action: any) => {
        if (state.currentSpaceId !== action.meta.arg) return;
        const nextSpace = action.payload.spaceData;
        if (!nextSpace) return;
        if (!state.currentSpace) {
          state.currentSpace = nextSpace;
          return;
        }
        const currentUpdatedAt = parseUpdatedAt(state.currentSpace.updatedAt);
        const nextUpdatedAt = parseUpdatedAt(nextSpace.updatedAt);
        if (nextUpdatedAt > currentUpdatedAt) {
          state.currentSpace = nextSpace;
        }
      },
    }
  ),
});
