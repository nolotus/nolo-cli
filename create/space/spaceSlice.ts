import { asyncThunkCreator, buildCreateSlice, createSelector } from "@reduxjs/toolkit";
import { toTimestampMs } from "../../core/timestamp";
import { patch, selectEntities } from "../../database/dbSlice";

import { MemberRole, type SpaceContent, type SpaceMemberWithSpaceInfo } from "../../app/types";

import { createCategoryActions } from "./category/categoryActions";
import { createContentThunks } from "./content/contentThunks";
import { createMemberThunks } from "./member/memberThunks";
import { createSpaceThunks } from "./spaceThunks";
import { applySpaceEventCore, type SpaceEvent } from "./spaceEventCore";
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
const FAVORITES_COLLAPSED_STORAGE_KEY = "nolo-sidebar-favorites-collapsed";

const readStoredFavoritesCollapsed = (): boolean => {
  try {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(FAVORITES_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

const writeStoredFavoritesCollapsed = (collapsed: boolean): void => {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      FAVORITES_COLLAPSED_STORAGE_KEY,
      collapsed ? "1" : "0",
    );
  } catch {
    // localStorage 不可用时静默忽略
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
  viewMode: "all",
  dialogStatuses: {},
  dialogEventTimestamps: {},
  dialogTitles: {},
  // 第一层网页体验：对话切走后仍可在 sidebar 感知其运行中/已完成。
  // 多窗口/多 tab 的已读同步语义暂不在这里定义，等桌面端阶段统一设计。
  unreadDialogIds: {},
  favoritesCollapsed: readStoredFavoritesCollapsed(),
};

const getSpaceUpdatedAt = (space: any): number => {
  if (!space) return 0;
  return toTimestampMs(space.updatedAt);
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
      state.favoritesCollapsed = readStoredFavoritesCollapsed();
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

    /** 切换侧边栏「我的收藏」专区折叠态，并持久化到 localStorage */
    toggleFavoritesCollapse: create.reducer((state) => {
      state.favoritesCollapsed = !state.favoritesCollapsed;
      writeStoredFavoritesCollapsed(state.favoritesCollapsed);
    }),

    /** 用本地缓存先恢复空间列表，远端校验完成后再由 fetchUserSpaceMemberships.fulfilled 覆盖。 */
    hydrateMemberSpacesFromLocal: create.reducer<SpaceMemberWithSpaceInfo[]>(
      (state, action) => {
        if (state.memberSpaces !== null || action.payload.length === 0) return;
        state.memberSpaces = dedupeMemberSpacesById(action.payload);
        // 本地缓存已出列表即解除 loading（stale-while-revalidate）：
        // 选择器立刻停止转圈显示本地空间，远端校验在 thunk 内后台继续，
        // fulfilled 时照常覆盖 memberSpaces 并复位 loading/membershipStatus。
        state.loading = false;
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

    /** 处理来自 SSE 的 space 实时事件，直接 patch Redux state，无需 re-fetch。
     *  纯决策已剥至 spaceEventCore（Wave22），此处仅接线。 */
    applySpaceEvent: create.reducer<SpaceEvent>((state, action) => {
      applySpaceEventCore(state, action.payload);
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
  fetchSpaceSidebarState,
  applySpaceEvent,
  markDialogRead,
  resetSpace,
  setViewMode,
  toggleFavoritesCollapse,
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

export const selectFavoritesCollapsed = createSelector(
  selectSpaceState,
  (space) => space.favoritesCollapsed ?? false
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
