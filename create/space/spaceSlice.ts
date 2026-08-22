import { asyncThunkCreator, buildCreateSlice } from "@reduxjs/toolkit";
import { selectEntities } from "../../database/dbSlice";

import { createCategoryActions } from "./category/categoryActions";
import { createContentThunks } from "./content/contentThunks";
import { createMemberThunks } from "./member/memberThunks";
import { createSpaceThunks } from "./spaceThunks";
import type { SpaceEvent } from "./spaceDialogStore";
import type { SpaceViewMode } from "./types";
import {
  setCollapsedCategories as setCollapsedCategoriesUi,
  resetSpaceUiState,
} from "./spaceUiStore";
import {
  applySpaceEventDialog,
  clearDialogUnread,
  resetSpaceDialogState,
} from "./spaceDialogStore";
import {
  hydrateMemberSpacesFromLocal as hydrateMemberSpacesUi,
  appendRecoveredMemberships as appendRecoveredMembershipsUi,
  resetSpaceMembershipState,
} from "./spaceMembershipStore";
import {
  setViewMode as setViewModeUi,
  resetSpaceCurrentState,
  getCurrentSpaceId,
  getViewMode,
  appendDialogContentEntry,
} from "./spaceCurrentStore";
import { getCurrentSpace } from "./spaceCurrentSelectors";
import { createSpaceKey } from "./spaceKeys";

const createSliceWithThunks = buildCreateSlice({
  creators: { asyncThunk: asyncThunkCreator },
});

const initialState: Record<string, never> = {};

export { dedupeMemberSpacesById } from "./spaceMembershipStore";

const spaceSlice = createSliceWithThunks({
  name: "space",
  initialState,
  reducers: (create) => ({
    ...createSpaceThunks(create),
    ...createCategoryActions(create),
    ...createContentThunks(create),
    ...createMemberThunks(create),

    resetSpace: create.reducer((_state) => {
      resetSpaceUiState();
      resetSpaceDialogState();
      resetSpaceMembershipState();
      resetSpaceCurrentState();
    }),

    setViewMode: create.reducer<SpaceViewMode>((_state, action) => {
      setViewModeUi(action.payload);
    }),

    hydrateMemberSpacesFromLocal: create.reducer((_state, action) => {
      hydrateMemberSpacesUi(action.payload as any);
    }),

    appendRecoveredMemberships: create.reducer((_state, action) => {
      appendRecoveredMembershipsUi(action.payload as any);
    }),

    markDialogRead: create.asyncThunk(
      async (payload: { dialogId: string; dialogKey?: string }, thunkAPI) => {
        if (payload.dialogKey) {
          const { patch } = await import("../../database/dbSlice");
          try {
            await thunkAPI.dispatch(
              patch({ dbKey: payload.dialogKey, changes: { unreadAt: null } })
            ).unwrap();
          } catch (error) {
            console.warn("[space/markDialogRead] failed to clear unreadAt", payload.dialogKey, error);
          }
        }
        return { dialogId: payload.dialogId };
      },
      {
        pending: (_state, action) => clearDialogUnread(action.meta.arg.dialogId),
        fulfilled: (_state, action) => clearDialogUnread(action.payload.dialogId),
      }
    ),

    applySpaceEvent: create.reducer<SpaceEvent>((_state, action) => {
      const now = Date.now();
      const ev = action.payload;
      if (ev.type === "dialog.created" && ev.dialogKey && ev.dialogId && ev.title) {
        appendDialogContentEntry(ev.dialogKey, ev.title, Math.max(now, 1));
      }
      applySpaceEventDialog(ev, now);
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
  appendRecoveredMemberships,
} = spaceSlice.actions as any;

// ===== Transitional selectors =====
// These are deliberately plain functions, not memoized selectors.
// A memoized createSelector cannot observe module-store changes because
// the Redux input object never changes — it would return stale values.
// New code should import directly from the owning module store.

export const selectCurrentSpaceId = (_state?: unknown): string | null =>
  getCurrentSpaceId();

export const selectCurrentSpace = (state: any): any =>
  getCurrentSpace(selectEntities(state));

export const selectSpaceById = (state: any, spaceId?: string | null) => {
  if (!spaceId) return null;
  return selectEntities(state)[createSpaceKey.space(spaceId)] || null;
};

export const selectViewMode = (_state?: unknown) => getViewMode();

export const selectDialogStatusFromEntity = (dialogKey: string) =>
  (state: any) => (selectEntities(state)[dialogKey] as { status?: string })?.status;

export const selectIsDialogUnreadFromEntity = (dialogKey: string) =>
  (state: any) => {
    const entity = selectEntities(state)[dialogKey] as { unreadAt?: number | null } | undefined;
    return typeof entity?.unreadAt === "number" && entity.unreadAt > 0;
  };

export default spaceSlice.reducer;