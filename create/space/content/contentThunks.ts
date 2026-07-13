import { toast } from "../../../app/utils/toast";
import type { SpaceState } from "../types";
import { addContentAction } from "./addContentAction";
import { deleteContentFromSpaceAction } from "./deleteContentFromSpaceAction";
import { moveContentAction } from "./moveContentAction";
import { updateContentTitleAction } from "./updateContentTitleAction";
import { updateContentPinnedAction } from "./updateContentPinnedAction";
import { updateContentCategoryAction } from "./updateContentCategoryAction";
import { deleteMultipleContentAction } from "./deleteMultipleContentAction"; // <-- 新增: 导入批量删除 Action
import { uploadAndAddFileToSpaceAction } from "./uploadAndAddFileToSpaceAction";
import { normalizeSpaceId } from "../spaceKeys";

type Create = {
  asyncThunk: (...args: any[]) => any;
  reducer: (...args: any[]) => any;
};

/**
 * 创建与内容相关的 Async Thunks
 * @param create - 由 buildCreateSlice 提供的创建器对象
 */
export const createContentThunks = (create: Create) => ({
  addContentToSpace: create.asyncThunk(addContentAction, {
    fulfilled: (state: SpaceState, action: any) => {
      const { spaceId, updatedSpaceData } = action.payload;
      const normalizedSpaceId = normalizeSpaceId(spaceId);
      const normalizedCurrentSpaceId = state.currentSpaceId
        ? normalizeSpaceId(state.currentSpaceId)
        : null;
      if (normalizedCurrentSpaceId === normalizedSpaceId) {
        state.currentSpace = updatedSpaceData;
      }
    },
  }),

  moveContentToSpace: create.asyncThunk(moveContentAction, {
    fulfilled: (state: SpaceState, action: any) => {
      const {
        sourceSpaceId,
        updatedSourceSpaceData,
        targetSpaceId,
        updatedTargetSpaceData,
      } = action.payload;
      if (state.currentSpaceId === sourceSpaceId && updatedSourceSpaceData) {
        state.currentSpace = updatedSourceSpaceData;
      }
      if (state.currentSpaceId === targetSpaceId && updatedTargetSpaceData) {
        state.currentSpace = updatedTargetSpaceData;
      }
    },
  }),

  deleteContentFromSpace: create.asyncThunk(deleteContentFromSpaceAction, {
    fulfilled: (state: SpaceState, action: any) => {
      const { spaceId, updatedSpaceData } = action.payload;
      const normalizedSpaceId = normalizeSpaceId(spaceId);
      const normalizedCurrentSpaceId = state.currentSpaceId
        ? normalizeSpaceId(state.currentSpaceId)
        : null;
      if (normalizedCurrentSpaceId === normalizedSpaceId) {
        state.currentSpace = updatedSpaceData;
      }
    },
  }),

  // --- 新增: 批量删除内容的 Thunk ---
  deleteMultipleContent: create.asyncThunk(deleteMultipleContentAction, {
    fulfilled: (state: SpaceState, action: any) => {
      const normalizedSpaceId = normalizeSpaceId(action.payload.spaceId);
      const normalizedCurrentSpaceId = state.currentSpaceId
        ? normalizeSpaceId(state.currentSpaceId)
        : null;
      if (normalizedCurrentSpaceId === normalizedSpaceId) {
        state.currentSpace = action.payload.updatedSpaceData;
      }
    },
  }),

  uploadAndAddFileToSpace: create.asyncThunk(uploadAndAddFileToSpaceAction, {
    fulfilled: (state: SpaceState, action: any) => {
      if (state.currentSpaceId === action.payload.spaceId) {
        state.currentSpace = action.payload.updatedSpaceData;
      }
    }
  }),
  // --- 结束新增 ---

  updateContentTitle: create.asyncThunk(updateContentTitleAction, {
    fulfilled: (state: SpaceState, action: any) => {
      if (state.currentSpaceId === action.payload.spaceId) {
        state.currentSpace = action.payload.updatedSpaceData;
      }
    },
    rejected: (_state: SpaceState, action: any) => {
      toast.error(action.error.message || "标题保存失败");
    },
  }),

  updateContentPinned: create.asyncThunk(updateContentPinnedAction, {
    fulfilled: (state: SpaceState, action: any) => {
      if (
        action.payload.updatedSpaceData &&
        state.currentSpaceId === action.payload.spaceId
      ) {
        state.currentSpace = action.payload.updatedSpaceData;
      }
    },
    rejected: (_state: SpaceState, action: any) => {
      toast.error(action.error.message || "置顶状态更新失败");
    },
  }),

  updateContentCategory: create.asyncThunk(updateContentCategoryAction, {
    fulfilled: (state: SpaceState, action: any) => {
      if (state.currentSpaceId === action.payload.spaceId) {
        state.currentSpace = action.payload.updatedSpaceData;
      }
    },
  }),
});
