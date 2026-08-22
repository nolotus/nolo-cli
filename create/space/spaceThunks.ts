// create/space/spaceThunks.ts
import type { SpaceContent, SpaceData } from "../../app/types";
import { patch, read } from "../../database/dbSlice";
import { addSpaceAction } from "./addSpaceAction";
import { deleteSpaceAction } from "./deleteSpaceAction";
import { fetchSpaceAction } from "./fetchSpaceAction";
import { createSpaceKey, normalizeSpaceId } from "./spaceKeys";
import { updateSpaceAction } from "./updateSpaceAction";
import { fetchSpaceSidebarStateAction } from "./fetchSpaceSidebarStateAction";
import { changeSpaceAction } from "./changeSpaceAction";
import { type SpaceState } from "./types";
// Wave A: collapsedCategories 已剥至 module store。
import { setCollapsedCategories as setCollapsedCategoriesUi } from "./spaceUiStore";
// Wave D: setViewMode 已从 spaceUiStore 迁至 spaceCurrentStore。
import { setViewMode as setViewModeUi } from "./spaceCurrentStore";
// Wave C: memberSpaces/loading/membershipStatus/initialized 已剥至 module store。
import {
  addMemberSpace,
  removeMemberSpace,
  updateMemberSpaceName,
  setMembershipLoading,
  setMembershipLoaded,
  setSpaceInitialized,
  setMembershipRejected,
} from "./spaceMembershipStore";
// Wave D: currentSpaceId/currentSpace 已剥至 module store。
import {
  getCurrentSpaceIdRaw,
  setCurrentSpaceBoth,
  setCurrentSpaceId,
  setCurrentSpace,
  updateCurrentSpaceIfMatch,
} from "./spaceCurrentStore";

type Create = {
  asyncThunk: (...args: any[]) => any;
  reducer: (...args: any[]) => any;
};

export const createSpaceThunks = (create: Create) => ({
  fetchSpaceSidebarState: create.asyncThunk(fetchSpaceSidebarStateAction, {
    fulfilled: (state: SpaceState, action: any) => {
      setCollapsedCategoriesUi(action.payload.collapsedCategories, getCurrentSpaceIdRaw());
    },
    rejected: (state: SpaceState, action: any) => {
      console.error("获取空间侧边栏状态失败:", action.error.message);
      setCollapsedCategoriesUi({}, getCurrentSpaceIdRaw());
    },
  }),

  changeSpace: create.asyncThunk(changeSpaceAction, {
    pending: (state: SpaceState, action: any) => {
      const newSpaceId = normalizeSpaceId(action.meta.arg);
      if (getCurrentSpaceIdRaw() !== newSpaceId) {
        setMembershipLoading();
        setCurrentSpace(null);
      }
    },
    fulfilled: (state: SpaceState, action: any) => {
      setCurrentSpaceBoth(action.payload.spaceId, action.payload.spaceData);
      setMembershipLoaded();
      setCollapsedCategoriesUi(
        action.payload.sidebarState?.collapsedCategories || {},
        action.payload.spaceId,
      );
    },
    rejected: (state: SpaceState, action: any) => {
      setMembershipRejected(action.error.message || "切换空间失败", false);
      setCurrentSpaceBoth(null, null);
      setCollapsedCategoriesUi({}, null);
    },
  }),

  addSpace: create.asyncThunk(addSpaceAction, {
    pending: (state: SpaceState) => {
      setMembershipLoading();
    },
    fulfilled: (state: SpaceState, action: any) => {
      addMemberSpace(action.payload);
    },
    rejected: (state: SpaceState, action: any) => {
      setMembershipRejected(action.error.message, false);
    },
  }),

  deleteSpace: create.asyncThunk(deleteSpaceAction, {
    fulfilled: (state: SpaceState, action: any) => {
      const normalizedSpaceId = normalizeSpaceId(action.payload.spaceId);
      const currentSpaceId = getCurrentSpaceIdRaw();
      const normalizedCurrentSpaceId = currentSpaceId
        ? normalizeSpaceId(currentSpaceId)
        : null;
      removeMemberSpace(normalizedSpaceId);
      if (normalizedCurrentSpaceId === normalizedSpaceId) {
        setCurrentSpaceBoth(null, null);
        setCollapsedCategoriesUi({}, null);
        setViewModeUi("all");
      }
    },
  }),

  updateSpace: create.asyncThunk(updateSpaceAction, {
    fulfilled: (state: SpaceState, action: any) => {
      const { updatedSpace, spaceId } = action.payload;
      updateCurrentSpaceIfMatch(spaceId, updatedSpace);
      if (updatedSpace.name) {
        updateMemberSpaceName(updatedSpace.id, updatedSpace.name);
      }
    },
  }),

  fetchSpace: create.asyncThunk(fetchSpaceAction, {
    fulfilled: (state: SpaceState, action: any) => {
      const { spaceId, spaceData } = action.payload;
      const currentSpaceId = getCurrentSpaceIdRaw();
      if (!currentSpaceId || currentSpaceId === spaceId) {
        setCurrentSpaceBoth(spaceId, spaceData);
        setSpaceInitialized();
      }
    },
  }),
});