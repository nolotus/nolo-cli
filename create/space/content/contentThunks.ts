import { toast } from "../../../app/utils/toast";
import type { SpaceState } from "../types";
// Wave D: currentSpaceId/currentSpace 已剥至 module store。
import {
  getCurrentSpaceIdRaw,
  updateCurrentSpaceIfMatch,
} from "../spaceCurrentStore";
import { addContentAction } from "./addContentAction";
import { deleteContentFromSpaceAction } from "./deleteContentFromSpaceAction";
import { moveContentAction } from "./moveContentAction";
import { updateContentTitleAction } from "./updateContentTitleAction";
import { updateContentPinnedAction } from "./updateContentPinnedAction";
import { updateContentCategoryAction } from "./updateContentCategoryAction";
import { deleteMultipleContentAction } from "./deleteMultipleContentAction"; // <-- 新增: 导入批量删除 Action
import { uploadAndAddFileToSpaceAction } from "./uploadAndAddFileToSpaceAction";
import { normalizeSpaceId } from "../spaceKeys";
import { UNCATEGORIZED_ID } from "../constants";
import { writeStoredCollapsedCategories } from "../spaceCollapsedState";
import { asTrimmedString } from "../../../core/trimmedString";
// Wave A: collapsedCategories 已剥至 module store。
import {
  getCollapsedCategories,
  expandCategoryInCollapsed,
} from "../spaceUiStore";

type Create = {
  asyncThunk: (...args: any[]) => any;
  reducer: (...args: any[]) => any;
};

/**
 * 创建与内容相关的 Async Thunks
 * @param create - 由 buildCreateSlice 提供的创建器对象
 */
export const createContentThunks = (create: Create) => ({
  /**
   * Add content into a space. When the content lands in a real category,
   * force-expand that category (Redux + localStorage) so "create page"
   * never leaves the new item trapped inside a default-collapsed section.
   */
  addContentToSpace: create.asyncThunk(
    async (
      input: Parameters<typeof addContentAction>[0],
      thunkAPI: Parameters<typeof addContentAction>[1]
    ) => {
      const result = await addContentAction(input, thunkAPI);
      const rawCategoryId = asTrimmedString(input.categoryId);
      const expandCategoryId =
        rawCategoryId && rawCategoryId !== UNCATEGORIZED_ID
          ? rawCategoryId
          : null;

      if (expandCategoryId) {
        // Wave A: 从 module store 读当前折叠状态
        const collapsedCategories = {
          ...getCollapsedCategories(),
          [expandCategoryId]: false,
        };
        if (typeof window !== "undefined") {
          writeStoredCollapsedCategories(
            result.spaceId,
            collapsedCategories,
            window.localStorage
          );
        }
        // Wave A: 直接展开分类，替代原 fulfilled reducer 写 Redux state
        expandCategoryInCollapsed(expandCategoryId, result.spaceId);
        return { ...result, expandCategoryId, collapsedCategories };
      }

      return { ...result, expandCategoryId: null as string | null };
    },
    {
      fulfilled: (state: SpaceState, action: any) => {
        const { spaceId, updatedSpaceData } = action.payload;
        const normalizedSpaceId = normalizeSpaceId(spaceId);
        const rawSpaceId = getCurrentSpaceIdRaw();
        const normalizedCurrentSpaceId = rawSpaceId
          ? normalizeSpaceId(rawSpaceId)
          : null;
        if (normalizedCurrentSpaceId === normalizedSpaceId && updatedSpaceData) {
          updateCurrentSpaceIfMatch(action.payload.spaceId, updatedSpaceData);
          // Wave A: collapsedCategories 的展开已在 thunk 体内通过
          // expandCategoryInCollapsed 写入 module store，fulfilled 不再写 Redux。
        }
      },
    }
  ),

  moveContentToSpace: create.asyncThunk(moveContentAction, {
    fulfilled: (_state: SpaceState, action: any) => {
      const {
        sourceSpaceId,
        updatedSourceSpaceData,
        targetSpaceId,
        updatedTargetSpaceData,
      } = action.payload;
      if (getCurrentSpaceIdRaw() === sourceSpaceId && updatedSourceSpaceData) {
        updateCurrentSpaceIfMatch(sourceSpaceId, updatedSourceSpaceData);
      }
      if (getCurrentSpaceIdRaw() === targetSpaceId && updatedTargetSpaceData) {
        updateCurrentSpaceIfMatch(targetSpaceId, updatedTargetSpaceData);
      }
    },
  }),

  deleteContentFromSpace: create.asyncThunk(deleteContentFromSpaceAction, {
    fulfilled: (_state: SpaceState, action: any) => {
      const { spaceId, updatedSpaceData } = action.payload;
      const normalizedSpaceId = normalizeSpaceId(spaceId);
      const rawSpaceId = getCurrentSpaceIdRaw();
      const normalizedCurrentSpaceId = rawSpaceId
        ? normalizeSpaceId(rawSpaceId)
        : null;
      if (normalizedCurrentSpaceId === normalizedSpaceId && updatedSpaceData) {
        updateCurrentSpaceIfMatch(action.payload.spaceId, updatedSpaceData);
      }
    },
  }),

  // --- 新增: 批量删除内容的 Thunk ---
  deleteMultipleContent: create.asyncThunk(deleteMultipleContentAction, {
    fulfilled: (_state: SpaceState, action: any) => {
      const normalizedSpaceId = normalizeSpaceId(action.payload.spaceId);
      const rawSpaceId = getCurrentSpaceIdRaw();
      const normalizedCurrentSpaceId = rawSpaceId
        ? normalizeSpaceId(rawSpaceId)
        : null;
      if (normalizedCurrentSpaceId === normalizedSpaceId && action.payload.updatedSpaceData) {
        updateCurrentSpaceIfMatch(action.payload.spaceId, action.payload.updatedSpaceData);
      }
    },
  }),

  uploadAndAddFileToSpace: create.asyncThunk(uploadAndAddFileToSpaceAction, {
    fulfilled: (state: SpaceState, action: any) => {
      if (getCurrentSpaceIdRaw() === action.payload.spaceId) {
        updateCurrentSpaceIfMatch(action.payload.spaceId, action.payload.updatedSpaceData);
      }
    }
  }),
  // --- 结束新增 ---

  updateContentTitle: create.asyncThunk(updateContentTitleAction, {
    fulfilled: (state: SpaceState, action: any) => {
      if (getCurrentSpaceIdRaw() === action.payload.spaceId) {
        updateCurrentSpaceIfMatch(action.payload.spaceId, action.payload.updatedSpaceData);
      }
    },
    rejected: (_state: SpaceState, action: any) => {
      const message = action.error.message || "标题保存失败";
      // 空间记录不可读（跨服务器/本地未同步的空间）属于次级同步失败：
      // 页面本身已保存成功，自动保存路径不需要每次按键都弹这个 toast；
      // 真正的写入失败（如 patch 失败）仍然提示。
      if (message.includes("无法加载空间数据")) return;
      toast.error(message);
    },
  }),

  updateContentPinned: create.asyncThunk(updateContentPinnedAction, {
    fulfilled: (state: SpaceState, action: any) => {
      if (
        action.payload.updatedSpaceData &&
        getCurrentSpaceIdRaw() === action.payload.spaceId
      ) {
        updateCurrentSpaceIfMatch(action.payload.spaceId, action.payload.updatedSpaceData);
      }
    },
    rejected: (_state: SpaceState, action: any) => {
      toast.error(action.error.message || "置顶状态更新失败");
    },
  }),

  updateContentCategory: create.asyncThunk(updateContentCategoryAction, {
    fulfilled: (state: SpaceState, action: any) => {
      if (getCurrentSpaceIdRaw() === action.payload.spaceId) {
        updateCurrentSpaceIfMatch(action.payload.spaceId, action.payload.updatedSpaceData);
      }
    },
  }),
});
