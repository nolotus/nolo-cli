// 文件: render/page/docSlice.ts

import { formatISO } from "date-fns";
import {
  asyncThunkCreator,
  buildCreateSlice,
  createListenerMiddleware,
  PayloadAction,
  createSelector,
} from "@reduxjs/toolkit";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { readAndWait, patch } from "../../database/dbSlice";
import { updateContentTitle } from "../../create/space/spaceSlice";
import type { EditorContent } from "../../create/editor/utils/slateUtils";
import { DataType } from "../../create/types";
import { PageData } from "./types";
import type { PageSkillMetadata } from "../../ai/skills/skillDocProtocol";
import type { ContentIcon } from "../contentIcon/types";

// —— State 接口 ——
export interface DocState {
  content: string | null;
  slateData: EditorContent | null;
  title: string | null;
  dbSpaceId: string | null;
  tags: string[] | null;
  icon: ContentIcon | null;
  isReadOnly: boolean;
  isLoading: boolean;
  isInitialized: boolean;
  error: string | null;
  pageKey: string | null;
  isSaving: boolean;
  saveError: string | null;
  lastSavedAt: string | null;
  /** ISO creation time from page record (for title meta chrome). */
  createdAt: string | null;
  lastSavedSlateData: EditorContent | null;
  lastSavedTitle: string | null;
  lastSavedIcon: ContentIcon | null;
  justSaved: boolean;
  tools: string[] | null;
  meta: PageSkillMetadata | null;
  id: string | null;
  type: DataType | null;
  focusContext: {
    isFocused: boolean;
    isCollapsed: boolean;
    anchorPath: number[];
    anchorOffset: number;
    focusPath: number[];
    focusOffset: number;
    selectedText: string | null;
    blockType: string | null;
  } | null;
}

// —— 初始状态 ——
const initialState: DocState = {
  content: null,
  slateData: null,
  title: null,
  dbSpaceId: null,
  tags: null,
  icon: null,
  isReadOnly: true,
  isLoading: false,
  isInitialized: false,
  error: null,
  pageKey: null,
  isSaving: false,
  saveError: null,
  lastSavedAt: null,
  createdAt: null,
  lastSavedSlateData: null,
  lastSavedTitle: null,
  lastSavedIcon: null,
  justSaved: false,
  tools: null,
  meta: null,
  id: null,
  type: null,
  focusContext: null,
};

const deepEqualEditorContent = (a: any, b: any): boolean => {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;

  const isArrayA = Array.isArray(a);
  const isArrayB = Array.isArray(b);
  if (isArrayA || isArrayB) {
    if (!isArrayA || !isArrayB || a.length !== b.length) return false;
    return a.every((item, index) => deepEqualEditorContent(item, b[index]));
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  return keysA.every((key) =>
    Object.prototype.hasOwnProperty.call(b, key) && deepEqualEditorContent(a[key], b[key])
  );
};

const hasSlateContentChanged = (
  newContent: EditorContent | null,
  oldContent: EditorContent | null
) => {
  if (newContent === oldContent) return false;
  if (!newContent || !oldContent) return true;
  if (newContent.length !== oldContent.length) return true;
  return !deepEqualEditorContent(newContent, oldContent);
};

interface InitDocArgs {
  pageKey: string;
  isReadOnly: boolean;
}

interface InitDocPayload extends PageData {
  isReadOnly: boolean;
}

interface SaveDocArgs {
  pageKey: string;
}

const createSliceWithThunks = buildCreateSlice({
  creators: { asyncThunk: asyncThunkCreator },
});

export const docSlice = createSliceWithThunks({
  name: "doc",
  initialState,
  reducers: (create): any => ({
    createDoc: create.asyncThunk(async (args: any, thunkApi: any) => {
      const { createPageAction } = await import("./createPageAction");
      return createPageAction(args, thunkApi);
    }),

    initDoc: create.asyncThunk(
      async (args: InitDocArgs, { dispatch, rejectWithValue }) => {
        const { pageKey, isReadOnly } = args;
        try {
          const readAction = await (dispatch as any)(readAndWait(pageKey));

          if (readAndWait.fulfilled.match(readAction) && readAction.payload) {
            const data = readAction.payload as PageData;

            // docSlice 仅处理 DataType.DOC
            if (data.type !== DataType.DOC) {
              return rejectWithValue(`加载的内容 ${pageKey} 不是文档类型 (${data.type})`);
            }

            return { ...data, isReadOnly };
          } else {
            const msg =
              (readAction.payload as any)?.message || `无法加载文档 ${pageKey}`;
            return rejectWithValue(msg);
          }
        } catch (e: any) {
          return rejectWithValue(e.message || `初始化文档 ${pageKey} 时出错`);
        }
      },
      {
        pending: (state, action) => {
          Object.assign(state, initialState);
          state.isLoading = true;
          state.pageKey = action.meta.arg.pageKey;
          state.isReadOnly = action.meta.arg.isReadOnly;
        },
        fulfilled: (state, action: PayloadAction<InitDocPayload>) => {
          state.isLoading = false;
          state.isInitialized = true;
          state.error = null;
          state.content = action.payload.content || null;
          state.slateData = action.payload.slateData || null;
          state.lastSavedSlateData = action.payload.slateData || null;
          state.title = action.payload.title || null;
          state.lastSavedTitle = action.payload.title || null;
          state.dbSpaceId = action.payload.spaceId || null;
          state.tags = action.payload.tags || null;
          state.icon = action.payload.icon || null;
          state.lastSavedIcon = action.payload.icon || null;
          state.isReadOnly = action.payload.isReadOnly;
          state.pageKey = action.payload.dbKey;
          state.id = action.payload.id;
          state.type = action.payload.type;
          const payload = action.payload as any;
          state.lastSavedAt = payload.updatedAt || payload.updated_at || null;
          state.createdAt =
            (typeof payload.created === "string" && payload.created) ||
            (typeof payload.createdAt === "string" && payload.createdAt) ||
            state.lastSavedAt;
          state.tools = action.payload.tools || null;
          state.meta = action.payload.meta || null;
        },
        rejected: (state, action) => {
          state.isLoading = false;
          state.isInitialized = true;
          state.error =
            (action.payload as string) ||
            action.error.message ||
            "初始化文档时发生未知错误";
        },
      }
    ),

    updateSlate: create.reducer(
      (state, action: PayloadAction<EditorContent>) => {
        if (state.isInitialized && !state.isReadOnly) {
          state.slateData = action.payload;
          state.justSaved = false;
        }
      }
    ),

    /**
     * 外部写入（如 AI updateDoc 工具）已落库后，把新内容应用到当前打开的编辑器：
     * 直接替换 slateData 并同步 lastSaved 标记（避免自动保存用过期内容回写）。
     * lastSavedAt 同时是 RenderPage 编辑器 key 的一部分——外部写入更新它，
     * 触发编辑器静默重挂载，不走 initDoc 全量 loading 重载。
     */
    applyExternalDocUpdate: create.reducer(
      (
        state,
        action: PayloadAction<{
          slateData: EditorContent;
          content?: string | null;
          title?: string | null;
          tools?: string[] | null;
          meta?: PageSkillMetadata | null;
          /** 外部写入的落库时间（ISO），同步为 lastSavedAt 并驱动编辑器重挂载。 */
          savedAt?: string;
        }>,
      ) => {
        if (!state.isInitialized) return;
        const { slateData, content, title, tools, meta, savedAt } = action.payload;
        state.slateData = slateData;
        state.lastSavedSlateData = slateData;
        if (content !== undefined) state.content = content;
        if (title != null) {
          state.title = title;
          state.lastSavedTitle = title;
        }
        if (tools !== undefined) state.tools = tools;
        if (meta !== undefined) state.meta = meta;
        state.lastSavedAt = savedAt ?? new Date().toISOString();
        state.justSaved = true;
        state.saveError = null;
      }
    ),

    updateTitle: create.reducer((state, action: PayloadAction<string>) => {
      if (state.isInitialized && !state.isReadOnly) {
        state.title = action.payload;
        state.justSaved = false;
      }
    }),

    updateIcon: create.reducer((state, action: PayloadAction<ContentIcon | null>) => {
      if (state.isInitialized && !state.isReadOnly) {
        state.icon = action.payload;
        state.justSaved = false;
      }
    }),

    saveDoc: create.asyncThunk(
      async (arg: SaveDocArgs, { dispatch, getState, rejectWithValue }) => {
        const requestedPageKey = arg.pageKey;
        const state = (getState() as any).doc;
        const { pageKey, slateData, dbSpaceId, meta, icon } = state;

        if (!pageKey || pageKey !== requestedPageKey) {
          return rejectWithValue("内容已切换，取消保存");
        }

        if (!slateData) {
          return rejectWithValue("内容为空，无法保存");
        }

        const [
          { extractTitleFromSlate, extractMentionsFromSlate },
          { slateToRenderMarkdown },
          { buildSkillSummaryMarker },
        ] = await Promise.all([
          import("../../create/editor/utils/slateUtils"),
          import("../../create/editor/transforms/slateToRenderMarkdown"),
          import("../../ai/skills/skillSummaryMarker"),
        ]);
        const title =
          asOptionalTrimmedString(state.title) ||
          extractTitleFromSlate(slateData) ||
          "未命名页面";
        const tools = extractMentionsFromSlate(slateData);
        const skillSummary = buildSkillSummaryMarker(meta);
        // `content` 是只读展示缓存，保存时从当前 Slate 重新生成。
        const content = slateToRenderMarkdown(slateData);
        const now = new Date();
        const updatedAt = formatISO(now);

        try {
          await (dispatch as (action: any) => any)(
            patch({
              dbKey: pageKey,
              changes: {
                updatedAt,
                slateData,
                title,
                tools,
                content,
                icon: icon ?? null,
                ...(meta ? { meta } : {}),
              },
            })
          ).unwrap();

          if (dbSpaceId) {
            // 空间侧标题同步是次级操作：页面本身已保存成功，
            // 空间记录不可读（跨服务器空间/本地未同步）不应把整个保存判失败，
            // 否则每次自动保存都双重报错（「内容保存失败」+「无法加载空间数据」）。
            try {
              await (dispatch as (action: any) => any)(
                (updateContentTitle as any)({
                  spaceId: dbSpaceId,
                  contentKey: pageKey,
                  title,
                  skillSummary,
                })
              ).unwrap();
            } catch (spaceSyncError) {
              console.warn(
                `[saveDoc] 空间标题同步失败（页面已保存）: ${toErrorMessage(spaceSyncError)}`,
              );
            }
          }

          if (typeof window !== "undefined") {
            window.dispatchEvent(new Event("nolo-user-data-updated"));
          }

          return { updatedAt, title, savedContent: slateData, content };
        } catch (e: any) {
          return rejectWithValue(e.message || "保存失败");
        }
      },
      {
        pending: (state) => {
          state.isSaving = true;
          state.saveError = null;
          state.justSaved = false;
        },
        fulfilled: (
          state,
          action: PayloadAction<{
            updatedAt: string;
            title: string;
            savedContent: any;
            content: string;
          }>
        ) => {
          state.isSaving = false;
          state.lastSavedAt = action.payload.updatedAt;
          state.title = action.payload.title;
          state.content = action.payload.content;
          state.lastSavedSlateData = action.payload.savedContent;
          state.lastSavedTitle = action.payload.title;
          state.lastSavedIcon = state.icon;
          state.justSaved = true;
        },
        rejected: (state, action) => {
          state.isSaving = false;
          state.saveError =
            (action.payload as string) || action.error.message || "未知错误";
          state.justSaved = false;
        },
      }
    ),

    resetJustSavedStatus: create.reducer((state) => {
      state.justSaved = false;
    }),

    setDocFocusContext: create.reducer(
      (state, action: PayloadAction<DocState["focusContext"]>) => {
        state.focusContext = action.payload;
      }
    ),

    toggleReadOnly: create.reducer((state) => {
      state.isReadOnly = !state.isReadOnly;
    }),
    setReadOnly: create.reducer((state, action: PayloadAction<boolean>) => {
      state.isReadOnly = action.payload;
    }),
    resetDoc: create.reducer((state) => {
      Object.assign(state, initialState);
    }),
    updateDocTags: create.reducer((state, action: PayloadAction<string[]>) => {
      if (state.isInitialized) state.tags = action.payload;
    }),
    previewDoc: create.reducer((state, action: PayloadAction<any>) => {
      Object.assign(state, initialState);
      state.isInitialized = true;
      state.isLoading = false;
      state.isReadOnly = true;
      state.slateData = action.payload.slateData;
      state.title = action.payload.title;
      state.lastSavedTitle = action.payload.title;
      state.pageKey = action.payload.dbKey;
      state.id = action.payload.id;
      state.type = action.payload.type || DataType.DOC;
      state.lastSavedSlateData = action.payload.slateData;
      state.tags = action.payload.tags || null;
      state.icon = action.payload.icon || null;
      state.lastSavedIcon = action.payload.icon || null;
      state.dbSpaceId = action.payload.spaceId;
      state.content = action.payload.content || null;
      state.meta = action.payload.meta || null;
    }),
  }),
});

// cast: buildCreateSlice async thunks 会推断成 void|AsyncThunk|ActionCreator 联合
export const {
  createDoc,
  initDoc,
  updateSlate,
  updateTitle,
  updateIcon,
  saveDoc,
  resetJustSavedStatus,
  setDocFocusContext,
  toggleReadOnly,
  setReadOnly,
  resetDoc,
  updateDocTags,
  previewDoc,
} = docSlice.actions as any;

const selectDocState = (state: any) => state.doc;

export const selectDoc = (state: any) => state.doc;

export const selectSlateData = createSelector(
  [selectDocState],
  (doc) => doc.slateData
);

export const selectDocIsLoading = createSelector(
  [selectDocState],
  (doc) => doc.isLoading
);

export const selectIsReadOnly = createSelector(
  [selectDocState],
  (doc) => doc.isReadOnly
);

export const selectDocIsInitialized = createSelector(
  [selectDocState],
  (doc) => doc.isInitialized
);

export const selectDocError = createSelector(
  [selectDocState],
  (doc) => doc.error
);

export const selectIsSaving = createSelector(
  [selectDocState],
  (doc) => doc.isSaving
);

export const selectSaveError = createSelector(
  [selectDocState],
  (doc) => doc.saveError
);

export const selectJustSaved = createSelector(
  [selectDocState],
  (doc) => doc.justSaved
);

export const selectDocTitle = createSelector(
  [selectDocState],
  (doc) => doc.title
);

export const selectHasPendingChanges = createSelector(
  [
    selectSlateData,
    (state: any) => state.doc.lastSavedSlateData,
    selectDocTitle,
    (state: any) => state.doc.lastSavedTitle,
    (state: any) => state.doc.icon,
    (state: any) => state.doc.lastSavedIcon,
    selectIsReadOnly,
    selectDocIsInitialized,
  ],
  (slateData, lastSavedSlateData, title, lastSavedTitle, icon, lastSavedIcon, isReadOnly, isInitialized) => {
    if (!isInitialized || isReadOnly) return false;
    return (
      hasSlateContentChanged(slateData, lastSavedSlateData) ||
      (title || "") !== (lastSavedTitle || "") ||
      JSON.stringify(icon ?? null) !== JSON.stringify(lastSavedIcon ?? null)
    );
  }
);

export const selectDocSpaceId = createSelector(
  [selectDocState],
  (doc) => doc.dbSpaceId
);

export const selectDocId = createSelector(
  [selectDocState],
  (doc) => doc.id
);

export const selectDocKey = createSelector(
  [selectDocState],
  (doc) => doc.pageKey
);

export const selectDocTags = createSelector(
  [selectDocState],
  (doc) => doc.tags
);

export const selectDocIcon = createSelector(
  [selectDocState],
  (doc) => doc.icon
);

export const selectDocFocusContext = createSelector(
  [selectDocState],
  (doc) => doc.focusContext
);

export const selectLastSavedAt = createSelector(
  [selectDocState],
  (doc) => doc.lastSavedAt
);

export const selectDocCreatedAt = createSelector(
  [selectDocState],
  (doc) => doc.createdAt
);

export default docSlice.reducer;
export const docListenerMiddleware = createListenerMiddleware();
