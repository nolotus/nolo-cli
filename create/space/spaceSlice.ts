import { asyncThunkCreator, buildCreateSlice, createSelector } from "@reduxjs/toolkit";
import { toTimestampMs } from "../../core/timestamp";
import { patch, selectEntities } from "../../database/dbSlice";

import { MemberRole, type SpaceContent, type SpaceMemberWithSpaceInfo } from "../../app/types";

import { createCategoryActions } from "./category/categoryActions";
import { createContentThunks } from "./content/contentThunks";
import { createMemberThunks } from "./member/memberThunks";
import { createSpaceThunks } from "./spaceThunks";
import { SpaceState, type SpaceViewMode } from "./types";
import { UNCATEGORIZED_ID } from "./constants";

/**
 * 折叠态隐式默认:当 collapsedCategories map 里没有某个 categoryId 时,
 * 用这份常量作为回退。UNCATEGORIZED 系统桶默认展开,普通分类默认折叠。
 * 任何"创建新分类"的 reducer 必须显式把 [newCategoryId]: false 写入 map,
 * 此常量只用于"未登记"场景的回退(用户从未 toggle 过的 id)。
 */
export const DEFAULT_COLLAPSED_CATEGORIES: Record<string, boolean> = {
  [UNCATEGORIZED_ID]: false,
};

import { createSpaceKey } from "./spaceKeys";

const createSliceWithThunks = buildCreateSlice({
  creators: { asyncThunk: asyncThunkCreator },
});

const VIEW_MODE_STORAGE_KEY = "nolo-space-view-mode";

const readStoredViewMode = (): SpaceViewMode => {
  if (typeof window === "undefined") return "all";
  try {
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return stored === "categories" ? "categories" : "all";
  } catch {
    return "all";
  }
};

const initialState: SpaceState = {
  currentSpaceId: null,
  currentSpace: null,
  memberSpaces: null,
  loading: false,
  membershipStatus: "idle",
  initialized: false,
  collapsedCategories: {},
  viewMode: readStoredViewMode(),
  dialogStatuses: {},
  dialogEventTimestamps: {},
  dialogTitles: {},
  // 第一层网页体验：对话切走后仍可在 sidebar 感知其运行中/已完成。
  // 多窗口/多 tab 的已读同步语义暂不在这里定义，等桌面端阶段统一设计。
  unreadDialogIds: {},
};

const getSpaceUpdatedAt = (space: any): number => {
  if (!space) return 0;
  return toTimestampMs(space.updatedAt);
};

const nextUpdatedAt = (prev?: number | string): number => {
  return Math.max(Date.now(), toTimestampMs(prev) + 1);
};

const getMembershipUpdatedAt = (space: any): number => {
  if (!space) return 0;
  return toTimestampMs(
    space.spaceUpdatedAt ??
      space.memberUpdatedAt ??
      space.updatedAt ??
      space.createdAt ??
      space.joinedAt
  );
};

export const dedupeMemberSpacesById = <T extends { spaceId: string }>(
  memberSpaces: T[]
): T[] => {
  const membershipMap = new Map<string, T>();
  memberSpaces.forEach((space) => {
    const prev = membershipMap.get(space.spaceId);
    if (!prev || getMembershipUpdatedAt(space) >= getMembershipUpdatedAt(prev)) {
      membershipMap.set(space.spaceId, space);
    }
  });
  return Array.from(membershipMap.values());
};

const spaceSlice = createSliceWithThunks({
  name: "space",
  initialState,
  reducers: (create) => ({
    ...createSpaceThunks(create),
    ...createCategoryActions(create),
    ...createContentThunks(create),
    ...createMemberThunks(create),

    /** 重置 space 状态（切换用户时调用），清空旧用户数据 */
    resetSpace: create.reducer((state) => {
      state.currentSpaceId = null;
      state.currentSpace = null;
      state.memberSpaces = null;
      state.collapsedCategories = {};
      state.viewMode = "all";
      state.initialized = false;
      state.loading = false;
      state.error = undefined;
      // Never inherit membership freshness across account switches.
      state.membershipStatus = "idle";
      state.dialogStatuses = {};
      state.dialogEventTimestamps = {};
      state.dialogTitles = {};
      state.unreadDialogIds = {};
    }),

    /** 切换侧边栏视图模式：全部 vs 分类 */
    setViewMode: create.reducer<SpaceViewMode>((state, action) => {
      state.viewMode = action.payload;
    }),

    /** 用本地缓存先恢复空间列表，远端校验完成后再由 fetchUserSpaceMemberships.fulfilled 覆盖。 */
    hydrateMemberSpacesFromLocal: create.reducer<SpaceMemberWithSpaceInfo[]>(
      (state, action) => {
        if (state.memberSpaces !== null || action.payload.length === 0) return;
        state.memberSpaces = dedupeMemberSpacesById(action.payload);
      }
    ),

    /** 进入某个对话后清除其未读提示。
     * 当前阶段只做"网页端切换不停止"的第一层体验：
     * - 侧边栏能看到后台对话 done/failed 后有未读点
     * - 持久化未读写在 dialog 记录的 unreadAt（跨 space / 刷新后仍可见），这里一并 patch 为 null
     * - 真正的跨窗口/多 tab 已读同步，留到桌面端阶段再设计
     */
    markDialogRead: create.asyncThunk(
      async (
        payload: { dialogId: string; dialogKey?: string },
        thunkAPI
      ) => {
        // 清零持久化未读：patch dialog 记录 unreadAt 为 null。
        // dialogKey 缺省时仅清内存态（兼容旧调用点与 markDialogRead 入口）。
        if (payload.dialogKey) {
          try {
            await thunkAPI.dispatch(
              patch({ dbKey: payload.dialogKey, changes: { unreadAt: null } })
            ).unwrap();
          } catch (error) {
            console.warn(
              "[space/markDialogRead] failed to clear unreadAt",
              payload.dialogKey,
              error
            );
            // patch 失败不阻塞内存态清除；侧边栏未读点仍有内存态兜底（本会话内）。
          }
        }
        return { dialogId: payload.dialogId };
      },
      {
        // 乐观清除：派发即同步删内存态未读，让点击进入瞬间未读点消失，
        // 不等 patch 网络往返。patch 失败也不会把未读恢复（已在内存层清掉）。
        pending: (state, action) => {
          delete state.unreadDialogIds[action.meta.arg.dialogId];
        },
        fulfilled: (state, action) => {
          delete state.unreadDialogIds[action.payload.dialogId];
        },
      }
    ),

    /** 处理来自 SSE 的 space 实时事件，直接 patch Redux state，无需 re-fetch */
    applySpaceEvent: create.reducer<{
      type: string;
      dialogId?: string;
      dialogKey?: string;
      title?: string;
      status?: string;
    }>((state, action) => {
      const ev = action.payload;

      if (ev.type === "dialog.created" && ev.dialogKey && ev.dialogId && ev.title) {
        // 追加到当前 space 的 contents（侧边栏立即可见）
        const now = nextUpdatedAt(state.dialogEventTimestamps[ev.dialogId]);
        if (state.currentSpace) {
          if (!state.currentSpace.contents) {
            state.currentSpace.contents = {};
          }
          state.currentSpace.contents[ev.dialogKey] = {
            title: ev.title,
            type: "dialog" as any,
            contentKey: ev.dialogKey,
            pinned: false,
            createdAt: now,
            updatedAt: now,
          };
          state.currentSpace.updatedAt = now;
        }
        state.dialogStatuses[ev.dialogId] = "running";
        state.dialogEventTimestamps[ev.dialogId] = now;
        state.dialogTitles[ev.dialogId] = ev.title;
        delete state.unreadDialogIds[ev.dialogId];
      }

      if (ev.type === "dialog.done" && ev.dialogId) {
        state.dialogStatuses[ev.dialogId] = "done";
        state.dialogEventTimestamps[ev.dialogId] = nextUpdatedAt(
          state.dialogEventTimestamps[ev.dialogId]
        );
        state.unreadDialogIds[ev.dialogId] = true;
      }

      if (ev.type === "dialog.failed" && ev.dialogId) {
        state.dialogStatuses[ev.dialogId] = "failed";
        state.dialogEventTimestamps[ev.dialogId] = nextUpdatedAt(
          state.dialogEventTimestamps[ev.dialogId]
        );
        state.unreadDialogIds[ev.dialogId] = true;
      }
    }),
  }),
});

// cast: buildCreateSlice async thunks 会推断成 void|AsyncThunk|ActionCreator 联合
export const {
  toggleCategoryCollapse,
  setAllCategoriesCollapsed,
  changeSpace,
  addSpace,
  deleteSpace,
  updateSpace,
  fetchSpace,
  addCategory,
  deleteCategory,
  updateCategoryName,
  reorderCategories,
  addContentToSpace,
  moveContentToSpace,
  deleteContentFromSpace,
  deleteMultipleContent,
  updateContentTitle,
  updateContentPinned,
  updateContentCategory,
  uploadAndAddFileToSpace,
  fetchUserSpaceMemberships,
  addMember,
  removeMember,
  fixSpace,
  fetchSpaceSidebarState,
  applySpaceEvent,
  markDialogRead,
  resetSpace,
  setViewMode,
  hydrateMemberSpacesFromLocal,
} = spaceSlice.actions as any;

const selectSpaceState = (state: any): SpaceState => state.space;

export const selectCurrentSpaceId = createSelector(
  selectSpaceState,
  (space) => space.viewMode === "all" ? null : space.currentSpaceId
);

export const selectCurrentSpace = createSelector(
  [
    selectSpaceState,
    (state: any) => {
      const spaceState = state.space;
      if (spaceState?.viewMode === "all") return undefined;
      if (!spaceState?.currentSpaceId) return undefined;
      const dbKey = createSpaceKey.space(spaceState.currentSpaceId);
      return selectEntities(state)[dbKey];
    },
  ],
  (space, spaceEntity) => {
    if (space.viewMode === "all") return null;
    if (!space.currentSpaceId) return null;
    if (!space.currentSpace) return spaceEntity || null;
    if (!spaceEntity) return space.currentSpace;
    return getSpaceUpdatedAt(spaceEntity) > getSpaceUpdatedAt(space.currentSpace)
      ? spaceEntity
      : space.currentSpace;
  }
);

export const selectAllMemberSpaces = createSelector(
  selectSpaceState,
  (space): SpaceMemberWithSpaceInfo[] => {
    const memberSpaces = dedupeMemberSpacesById(space.memberSpaces || []);
    return [...memberSpaces].sort((a, b) => {
      return getMembershipUpdatedAt(b) - getMembershipUpdatedAt(a);
    });
  }
);

export const selectOwnedMemberSpaces = createSelector(
  selectAllMemberSpaces,
  (memberSpaces) =>
    memberSpaces.filter((space) => space.role === MemberRole.OWNER)
);

export interface CrossSpaceContentItem extends SpaceContent {
  spaceId: string;
  spaceName: string;
}

export const selectSpaceLoading = createSelector(
  selectSpaceState,
  (space) => space.loading
);

export const selectMembershipStatus = createSelector(
  selectSpaceState,
  (space) => space.membershipStatus ?? "idle"
);

export const selectSpaceInitialized = createSelector(
  selectSpaceState,
  (space) => space.initialized
);

export const selectCollapsedCategories = createSelector(
  selectSpaceState,
  (space) => space.collapsedCategories
);

export const selectIsCategoryCollapsed = (categoryId: string) =>
  createSelector(
    selectCollapsedCategories,
    (collapsed) =>
      collapsed[categoryId] ??
      (DEFAULT_COLLAPSED_CATEGORIES[categoryId] ?? true)
  );

export const selectDialogStatuses = createSelector(
  selectSpaceState,
  (space) => space.dialogStatuses ?? {}
);

export const selectDialogEventTimestamps = createSelector(
  selectSpaceState,
  (space) => space.dialogEventTimestamps ?? {}
);

export const selectDialogTitles = createSelector(
  selectSpaceState,
  (space) => space.dialogTitles ?? {}
);

export const selectDialogStatus = (dialogId: string) =>
  createSelector(selectDialogStatuses, (statuses) => statuses[dialogId]);

export const selectUnreadDialogIds = createSelector(
  selectSpaceState,
  (space) => space.unreadDialogIds ?? {}
);

export const selectIsDialogUnread = (dialogId: string) =>
  createSelector(selectUnreadDialogIds, (unreadMap) => unreadMap[dialogId] === true);

/**
 * 持久化未读/状态来源：dialog 记录实体本身。
 *
 * 与 selectIsDialogUnread / selectDialogStatus（来自当前 space 的 SSE 实时事件）互补：
 * SSE 只覆盖当前打开的 space、刷新后丢失；实体读取覆盖跨 space 与刷新后场景。
 * dialog 终态时服务端写 unreadAt + status，进入对话 markDialogRead 清零 unreadAt。
 */
export const selectDialogStatusFromEntity = (dialogKey: string) =>
  createSelector(selectEntities, (entities) => {
    const entity = entities[dialogKey];
    return (entity as { status?: string } | undefined)?.status;
  });

export const selectIsDialogUnreadFromEntity = (dialogKey: string) =>
  createSelector(selectEntities, (entities) => {
    const entity = entities[dialogKey] as { unreadAt?: number | null } | undefined;
    return typeof entity?.unreadAt === "number" && entity.unreadAt > 0;
  });

export const selectViewMode = createSelector(
  selectSpaceState,
  (space) => space.viewMode
);

export default spaceSlice.reducer;
