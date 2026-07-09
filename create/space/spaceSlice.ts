import { asyncThunkCreator, buildCreateSlice, createSelector } from "@reduxjs/toolkit";
import { selectEntities } from "../../database/dbSlice";

import { MemberRole, type SpaceContent, type SpaceMemberWithSpaceInfo } from "../../app/types";

import { createCategoryActions } from "./category/categoryActions";
import { createContentThunks } from "./content/contentThunks";
import { createMemberThunks } from "./member/memberThunks";
import { createSpaceThunks } from "./spaceThunks";
import { SpaceState, type SpaceViewMode } from "./types";
import { UNCATEGORIZED_ID } from "./constants";

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
  const value = space.updatedAt;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? ts : 0;
  }
  return 0;
};

const nextUpdatedAt = (prev?: number | string): number => {
  const prevTs =
    typeof prev === "number"
      ? prev
      : typeof prev === "string"
        ? Date.parse(prev) || 0
        : 0;
  return Math.max(Date.now(), prevTs + 1);
};

const getMembershipUpdatedAt = (space: any): number => {
  if (!space) return 0;
  const value =
    space.spaceUpdatedAt ??
    space.memberUpdatedAt ??
    space.updatedAt ??
    space.createdAt ??
    space.joinedAt;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? ts : 0;
  }
  return 0;
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
     * 当前阶段只做“网页端切换不停止”的第一层体验：
     * - 侧边栏能看到后台对话 done/failed 后有未读点
     * - 真正的跨窗口/多 tab 已读同步，留到桌面端阶段再设计
     */
    markDialogRead: create.reducer<{ dialogId: string }>((state, action) => {
      delete state.unreadDialogIds[action.payload.dialogId];
    }),

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

export const {
  toggleCategoryCollapse,
  setAllCategoriesCollapsed,
  changeSpace,
  addSpace,
  deleteSpace,
  updateSpace,
  loadDefaultSpace,
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
} = spaceSlice.actions;

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
    (collapsed) => collapsed[categoryId] ?? categoryId !== UNCATEGORIZED_ID
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

export const selectViewMode = createSelector(
  selectSpaceState,
  (space) => space.viewMode
);

export default spaceSlice.reducer;
