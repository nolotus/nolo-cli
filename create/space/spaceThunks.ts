// create/space/spaceThunks.ts
import type { SpaceContent, SpaceData } from "../../app/types";
import { toTimestampMs } from "../../core/timestamp";
import { patch, read } from "../../database/dbSlice";
import { addSpaceAction } from "./addSpaceAction";
import { deleteSpaceAction } from "./deleteSpaceAction";
import { fetchSpaceAction } from "./fetchSpaceAction";
import { createSpaceKey, normalizeSpaceId } from "./spaceKeys";
import { updateSpaceAction } from "./updateSpaceAction";
import { fetchSpaceSidebarStateAction } from "./fetchSpaceSidebarStateAction";
import { changeSpaceAction } from "./changeSpaceAction";
import { type SpaceState } from "./types";

type Create = {
  asyncThunk: (...args: any[]) => any;
  reducer: (...args: any[]) => any;
};

const dedupeMemberSpaces = <T extends { spaceId: string }>(memberSpaces: T[]): T[] => {
  const membershipMap = new Map<string, T>();
  memberSpaces.forEach((space) => {
    const nextUpdatedAt = toTimestampMs(
      (space as any).spaceUpdatedAt ??
        (space as any).memberUpdatedAt ??
        (space as any).updatedAt ??
        (space as any).createdAt ??
        (space as any).joinedAt
    );
    const prev = membershipMap.get(space.spaceId);
    const prevUpdatedAt = prev
      ? toTimestampMs(
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
});
