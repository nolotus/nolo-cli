// 文件: render/page/docStore.ts
// Module store for the doc editor — peeled out of Redux (Wave doc migration).
// Mirrors packages/app/notifications/notificationStore.ts +
// packages/chat/dialog/dialogRuntimeStore.ts:
//   - listeners Set + version counter
//   - notify/bump with try/catch around each listener
//   - hooks call useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
//     (third arg required for SSR; App/layout consumers render on server)
//
// Reducer semantics below are copied verbatim from the deleted docSlice.ts.
// The async thunks (initDoc / saveDoc / createDoc) are reproduced as plain
// async functions that receive { dispatch, getState } from the call site
// (same contract as createPageAction), so they can still drive dbSlice thunks
// without a global store singleton.
//
// CURSOR BUG FIX:
// The old docSlice reused `lastSavedAt` as the RenderPage editor remount key.
// `saveDoc.fulfilled` also wrote `lastSavedAt`, so every autosave remounted
// the Slate editor and reset the caret. We now keep `lastSavedAt` purely as a
// timestamp and drive remounts with a dedicated `externalUpdateSeq` that only
// `applyExternalDocUpdate` increments — user saves no longer remount.

import { useSyncExternalStore } from "react";

import { formatISO } from "date-fns";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { toErrorMessage } from "../../core/errorMessage";
import { readAndWait, patch } from "../../database/dbSlice";
import { updateContentTitle } from "../../create/space/spaceSlice";
import { DataType } from "../../create/types";
import type { EditorContent } from "../../create/editor/utils/slateUtils";
import type { PageSkillMetadata } from "../../ai/skills/skillDocProtocol";
import type { ContentIcon } from "../contentIcon/types";
import type { PageData } from "./types";

// ---------------------------------------------------------------------------
// State shape (mirrors the old DocState, plus externalUpdateSeq)
// ---------------------------------------------------------------------------

export interface DocFocusContext {
  isFocused: boolean;
  isCollapsed: boolean;
  anchorPath: number[];
  anchorOffset: number;
  focusPath: number[];
  focusOffset: number;
  selectedText: string | null;
  blockType: string | null;
}

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
  /** Creator user id (from page record, used by topbar edit-visibility checks). */
  creator: string | null;
  focusContext: DocFocusContext | null;
  /**
   * Monotonic counter incremented only by `applyExternalDocUpdate` (AI /
   * external writes). Drives the RenderPage editor remount key so the editor
   * is rebuilt when content is externally replaced, but NOT on every user
   * autosave — fixing the caret-jump bug where saveDoc.fulfilled reused
   * lastSavedAt as the remount trigger.
   */
  externalUpdateSeq: number;
}

const createInitialState = (): DocState => ({
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
  creator: null,
  focusContext: null,
  externalUpdateSeq: 0,
});

// ---------------------------------------------------------------------------
// Store core: listeners + version + notify (notificationStore pattern)
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let version = 0;

let state: DocState = createInitialState();

const notify = (): void => {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* subscriber errors must not break mutators */
    }
  }
};

const bump = (): void => {
  version += 1;
  notify();
};

const setState = (updater: DocState | ((prev: DocState) => DocState)): void => {
  state =
    typeof updater === "function"
      ? (updater as (prev: DocState) => DocState)(state)
      : updater;
  bump();
};

// ---------------------------------------------------------------------------
// Deep equality helpers (copied verbatim from the old docSlice)
// ---------------------------------------------------------------------------

const deepEqualEditorContent = (a: any, b: any): boolean => {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const isArrayA = Array.isArray(a);
  const isArrayB = Array.isArray(b);
  if (isArrayA || isArrayB) {
    if (!isArrayA || !isArrayB || a.length !== b.length) return false;
    return a.every((item: any, index: number) =>
      deepEqualEditorContent(item, b[index]),
    );
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      deepEqualEditorContent(a[key], b[key]),
  );
};

const hasSlateContentChanged = (
  newContent: EditorContent | null,
  oldContent: EditorContent | null,
): boolean => {
  if (newContent === oldContent) return false;
  if (!newContent || !oldContent) return true;
  if (newContent.length !== oldContent.length) return true;
  return !deepEqualEditorContent(newContent, oldContent);
};

// ---------------------------------------------------------------------------
// Sync reads (return live state — same as reading Redux state)
// ---------------------------------------------------------------------------

export function getDocState(): DocState {
  return state;
}

export function getDocField<T>(selector: (s: DocState) => T): T {
  return selector(state);
}

export function getDocPageKey(): string | null {
  return state.pageKey;
}

export function getDocIsInitialized(): boolean {
  return state.isInitialized;
}

export function getDocIsReadOnly(): boolean {
  return state.isReadOnly;
}

export function getDocHasPendingChanges(): boolean {
  if (!state.isInitialized || state.isReadOnly) return false;
  return (
    hasSlateContentChanged(state.slateData, state.lastSavedSlateData) ||
    (state.title || "") !== (state.lastSavedTitle || "") ||
    JSON.stringify(state.icon ?? null) !==
      JSON.stringify(state.lastSavedIcon ?? null)
  );
}

// ---------------------------------------------------------------------------
// Sync mutators (mirror the old reducers — NOT Redux actions)
// ---------------------------------------------------------------------------

export function updateSlateDoc(value: EditorContent): void {
  if (!state.isInitialized || state.isReadOnly) return;
  if (state.slateData === value) return;
  setState((prev) => ({ ...prev, slateData: value, justSaved: false }));
}

export function updateTitleDoc(title: string): void {
  if (!state.isInitialized || state.isReadOnly) return;
  setState((prev) => ({ ...prev, title, justSaved: false }));
}

export function updateIconDoc(icon: ContentIcon | null): void {
  if (!state.isInitialized || state.isReadOnly) return;
  setState((prev) => ({ ...prev, icon, justSaved: false }));
}

export function resetJustSavedStatus(): void {
  if (state.justSaved === false) return;
  setState((prev) => ({ ...prev, justSaved: false }));
}

export function setDocFocusContext(focusContext: DocFocusContext | null): void {
  setState((prev) => ({ ...prev, focusContext }));
}

export function toggleReadOnlyDoc(): void {
  setState((prev) => ({ ...prev, isReadOnly: !prev.isReadOnly }));
}

export function setReadOnlyDoc(isReadOnly: boolean): void {
  setState((prev) => ({ ...prev, isReadOnly }));
}

export function updateDocTags(tags: string[]): void {
  if (!state.isInitialized) return;
  setState((prev) => ({ ...prev, tags }));
}

export function resetDocState(): void {
  setState(createInitialState());
}

export function previewDocState(payload: any): void {
  const next = createInitialState();
  next.isInitialized = true;
  next.isLoading = false;
  next.isReadOnly = true;
  next.slateData = payload.slateData;
  next.title = payload.title;
  next.lastSavedTitle = payload.title;
  next.pageKey = payload.dbKey;
  next.id = payload.id;
  next.type = payload.type || DataType.DOC;
  next.lastSavedSlateData = payload.slateData;
  next.tags = payload.tags || null;
  next.icon = payload.icon || null;
  next.lastSavedIcon = payload.icon || null;
  next.dbSpaceId = payload.spaceId;
  next.content = payload.content || null;
  next.meta = payload.meta || null;
  setState(next);
}

/**
 * External write (e.g. AI updateDoc tool) has been persisted; apply the new
 * content to the currently-open editor in place: replace slateData + sync the
 * lastSaved markers (so autosave does not overwrite with stale content), and
 * bump `externalUpdateSeq` to drive a silent editor remount — WITHOUT a full
 * initDoc reload (users expect content to appear in place, not a page refresh).
 *
 * `lastSavedAt` is updated purely as a timestamp here; user saves no longer
 * bump `externalUpdateSeq`, so autosave no longer remounts the editor.
 */
export function applyExternalDocUpdate(payload: {
  slateData: EditorContent;
  content?: string | null;
  title?: string | null;
  tools?: string[] | null;
  meta?: PageSkillMetadata | null;
  /** External write persistence time (ISO); synced to lastSavedAt. */
  savedAt?: string;
}): void {
  if (!state.isInitialized) return;
  const { slateData, content, title, tools, meta, savedAt } = payload;
  setState((prev) => {
    const next: DocState = {
      ...prev,
      slateData,
      lastSavedSlateData: slateData,
      lastSavedAt: savedAt ?? new Date().toISOString(),
      justSaved: true,
      saveError: null,
      externalUpdateSeq: prev.externalUpdateSeq + 1,
    };
    if (content !== undefined) next.content = content;
    if (title != null) {
      next.title = title;
      next.lastSavedTitle = title;
    }
    if (tools !== undefined) next.tools = tools;
    if (meta !== undefined) next.meta = meta;
    return next;
  });
}

// ---------------------------------------------------------------------------
// Async operations (mirror the old asyncThunks; receive { dispatch, getState })
// ---------------------------------------------------------------------------

export interface DocThunkApi {
  dispatch: any;
  getState: () => any;
}

export interface InitDocArgs {
  pageKey: string;
  isReadOnly: boolean;
}

interface InitDocPayload extends PageData {
  isReadOnly: boolean;
}

export async function initDocState(
  args: InitDocArgs,
  { dispatch }: DocThunkApi,
): Promise<void> {
  const { pageKey, isReadOnly } = args;
  // pending
  setState((prev) => ({
    ...createInitialState(),
    isLoading: true,
    pageKey,
    isReadOnly,
  }));
  try {
    const readAction = await dispatch(readAndWait(pageKey));
    if (readAndWait.fulfilled.match(readAction) && readAction.payload) {
      const data = readAction.payload as PageData;
      if (data.type !== DataType.DOC) {
        const msg = `加载的内容 ${pageKey} 不是文档类型 (${data.type})`;
        setState((prev) => ({
          ...prev,
          isLoading: false,
          isInitialized: true,
          error: msg,
        }));
        return;
      }
      const payload = data as InitDocPayload;
      const lastSavedAt =
        (payload as any).updatedAt ||
        (payload as any).updated_at ||
        null;
      const createdAt =
        (typeof (payload as any).created === "string" &&
          (payload as any).created) ||
        (typeof (payload as any).createdAt === "string" &&
          (payload as any).createdAt) ||
        lastSavedAt;
      setState((prev) => ({
        ...prev,
        isLoading: false,
        isInitialized: true,
        error: null,
        externalUpdateSeq: prev.externalUpdateSeq + 1,
        content: payload.content || null,
        slateData: payload.slateData || null,
        lastSavedSlateData: payload.slateData || null,
        title: payload.title || null,
        lastSavedTitle: payload.title || null,
        dbSpaceId: payload.spaceId || null,
        tags: payload.tags || null,
        icon: payload.icon || null,
        lastSavedIcon: payload.icon || null,
        isReadOnly: payload.isReadOnly,
        pageKey: payload.dbKey,
        id: payload.id,
        type: payload.type,
        lastSavedAt,
        createdAt,
        tools: payload.tools || null,
        meta: payload.meta || null,
      }));
    } else {
      const msg =
        (readAction.payload as any)?.message || `无法加载文档 ${pageKey}`;
      setState((prev) => ({
        ...prev,
        isLoading: false,
        isInitialized: true,
        error: msg,
      }));
    }
  } catch (e: any) {
    setState((prev) => ({
      ...prev,
      isLoading: false,
      isInitialized: true,
      error: e?.message || `初始化文档 ${pageKey} 时出错`,
    }));
  }
}

export interface SaveDocArgs {
  pageKey: string;
}

export async function saveDocState(
  arg: SaveDocArgs,
  { dispatch, getState }: DocThunkApi,
): Promise<void> {
  const requestedPageKey = arg.pageKey;
  const current: DocState = state;
  const { pageKey, slateData, dbSpaceId, meta, icon } = current;

  // ── 诊断日志：检测"旧编辑器状态覆盖 AI/外部写入"冲突 ──────────────
  // 根因：服务端 updateDoc 只写数据库，不调用 applyExternalDocUpdate，
  // 前端编辑器仍持有旧 slateData。当 visibilitychange/beforeunload/
  // 组件卸载无条件触发 saveNow() 时，旧 slateData 被 PATCH 回数据库，
  // 覆盖了 AI 刚写入的新内容。此日志帮助确认冲突是否发生：
  //   - triggerSource 标记触发来源（由调用方传入）
  //   - lastSavedAt vs updated_at 差值 > 0 说明编辑器状态比数据库旧
  const triggerSource = (arg as any).triggerSource ?? "unknown";
  const hasPending = getDocHasPendingChanges();
  if (typeof console !== "undefined") {
    console.info("[saveDocState] triggered", {
      triggerSource,
      pageKey,
      hasPendingChanges: hasPending,
      lastSavedAt: current.lastSavedAt,
      externalUpdateSeq: current.externalUpdateSeq,
      // 若 hasPending=false，说明 slateData===lastSavedSlateData，
      // 此刻 save 仍被无条件触发 → 会用旧内容覆盖数据库（若数据库已有更新）
    });
  }
  // ── 诊断日志结束 ──────────────────────────────────────────────

  if (!pageKey || pageKey !== requestedPageKey) {
    return;
  }
  if (!slateData) {
    return;
  }

  // ── 冲突防护：无改动时跳过保存，避免旧编辑器状态覆盖 AI/外部写入 ──
  // 根因修复：visibilitychange/beforeunload/组件卸载会无条件触发 saveNow()，
  // 即使编辑器内容没有任何改动。此时如果数据库已被 AI updateDoc 更新，
  // 旧 slateData 会通过 PATCH 覆盖新内容。这里加守卫：当 slateData 与
  // lastSavedSlateData 深度相等且标题/图标也没变时，直接跳过——没有
  // 改动就没有理由写数据库。
  if (!hasPending) {
    if (typeof console !== "undefined") {
      console.info("[saveDocState] skipped — no pending changes (protects external writes)", {
        triggerSource,
        pageKey,
        externalUpdateSeq: current.externalUpdateSeq,
      });
    }
    return;
  }
  // ── 冲突防护结束 ──────────────────────────────────────────────

  // pending
  setState((prev) => ({
    ...prev,
    isSaving: true,
    saveError: null,
    justSaved: false,
  }));

  try {
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
      asOptionalTrimmedString(current.title) ||
      extractTitleFromSlate(slateData) ||
      "未命名页面";
    const tools = extractMentionsFromSlate(slateData);
    const skillSummary = buildSkillSummaryMarker(meta);
    const content = slateToRenderMarkdown(slateData);
    const now = new Date();
    const updatedAt = formatISO(now);

    await dispatch(
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
      }),
    ).unwrap();

    if (dbSpaceId) {
      try {
        await dispatch(
          (updateContentTitle as any)({
            spaceId: dbSpaceId,
            contentKey: pageKey,
            title,
            skillSummary,
          }),
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

    // fulfilled — NOTE: does NOT bump externalUpdateSeq (cursor bug fix).
    setState((prev) => ({
      ...prev,
      isSaving: false,
      lastSavedAt: updatedAt,
      title,
      content,
      lastSavedSlateData: slateData,
      lastSavedTitle: title,
      lastSavedIcon: prev.icon,
      justSaved: true,
    }));
  } catch (e: any) {
    setState((prev) => ({
      ...prev,
      isSaving: false,
      saveError: e?.message || "保存失败",
      justSaved: false,
    }));
  }
}

/**
 * Create a new page. Delegates to createPageAction (same lazy contract as the
 * old docSlice.createDoc asyncThunk). Returns the new page dbKey so callers
 * can navigate.
 */
export async function createDocState(
  args: any,
  thunkApi: DocThunkApi,
): Promise<string> {
  const { createPageAction } = await import("./createPageAction");
  return createPageAction(args, thunkApi);
}

// ---------------------------------------------------------------------------
// useSyncExternalStore hooks (React consumers)
// ---------------------------------------------------------------------------

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): number {
  return version;
}

/**
 * Subscribe to the whole doc state. Prefer `useDocField` for scoped reads to
 * avoid re-rendering on unrelated field changes.
 */
export function useDocState(): DocState {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getDocState();
}

export function useDocField<T>(selector: (s: DocState) => T): T {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return selector(state);
}

export function resetDocStoreForTests(): void {
  state = createInitialState();
  bump();
}