// File: create/space/spaceDialogStore.ts
// Module store for space dialog runtime indicators (SSE-driven).
// State: dialogStatuses, dialogEventTimestamps, dialogTitles, unreadDialogIds.

import { useSyncExternalStore } from "react";

import { toTimestampMs } from "../../core/timestamp";

export interface SpaceDialogState {
  /** 实时任务状态：dialogId → "running" | "done" | "failed" */
  dialogStatuses: Record<string, string>;
  /** 最近一次 dialog 事件时间，用于顶部通知排序 */
  dialogEventTimestamps: Record<string, number>;
  /** 运行时可用的 dialog 标题缓存 */
  dialogTitles: Record<string, string>;
  /** 第一层网页体验：后台完成/失败后给侧边栏一个未读提示点，进入该对话即清除 */
  unreadDialogIds: Record<string, boolean>;
}

const createInitialState = (): SpaceDialogState => ({
  dialogStatuses: {},
  dialogEventTimestamps: {},
  dialogTitles: {},
  unreadDialogIds: {},
});

let state: SpaceDialogState = createInitialState();
const listeners = new Set<() => void>();
let version = 0;

const notify = (): void => {
  version += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* subscriber errors must not break mutators */
    }
  }
};

// ===== subscribe / getSnapshot (for useSyncExternalStore) =====
// Internal-only — not exported to avoid Knip unused-export warnings.

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): number {
  return version;
}

// ===== getters (non-React callers) =====

export function getDialogStatuses(): Readonly<Record<string, string>> {
  return state.dialogStatuses;
}

export function getDialogEventTimestamps(): Readonly<Record<string, number>> {
  return state.dialogEventTimestamps;
}

export function getDialogTitles(): Readonly<Record<string, string>> {
  return state.dialogTitles;
}

export function getUnreadDialogIds(): Readonly<Record<string, boolean>> {
  return state.unreadDialogIds;
}

export function getDialogStatus(dialogId: string): string | undefined {
  return state.dialogStatuses[dialogId];
}

export function getIsDialogUnread(dialogId: string): boolean {
  return state.unreadDialogIds[dialogId] === true;
}

// ===== mutators =====

/**
 * 单调递增事件时间戳：始终 > prev 且 >= now。
 * 与 spaceEventCore.ts 的 nextSpaceEventTimestamp 保持一致。
 */
const nextDialogEventTimestamp = (
  prev: number | string | undefined,
  now: number = Date.now()
): number => Math.max(now, toTimestampMs(prev) + 1);

export interface SpaceEvent {
  type: string;
  dialogId?: string;
  dialogKey?: string;
  title?: string;
  status?: string;
}

/**
 * 就地把一个 SSE space 事件的 dialog 实时状态部分应用到 module store。
 */
export function applySpaceEventDialog(
  ev: SpaceEvent,
  now: number = Date.now()
): void {
  if (ev.type === "dialog.created" && ev.dialogKey && ev.dialogId && ev.title) {
    const ts = nextDialogEventTimestamp(state.dialogEventTimestamps[ev.dialogId], now);
    state = {
      ...state,
      dialogStatuses: { ...state.dialogStatuses, [ev.dialogId]: "running" },
      dialogEventTimestamps: { ...state.dialogEventTimestamps, [ev.dialogId]: ts },
      dialogTitles: { ...state.dialogTitles, [ev.dialogId]: ev.title },
      unreadDialogIds: { ...state.unreadDialogIds, [ev.dialogId]: false },
    };
    // delete 不支持展开运算符设 false，手动删
    if (state.unreadDialogIds[ev.dialogId] !== undefined) {
      const next = { ...state.unreadDialogIds };
      delete next[ev.dialogId];
      state = { ...state, unreadDialogIds: next };
    }
  }

  if (ev.type === "dialog.done" && ev.dialogId) {
    const ts = nextDialogEventTimestamp(state.dialogEventTimestamps[ev.dialogId], now);
    state = {
      ...state,
      dialogStatuses: { ...state.dialogStatuses, [ev.dialogId]: "done" },
      dialogEventTimestamps: { ...state.dialogEventTimestamps, [ev.dialogId]: ts },
      unreadDialogIds: { ...state.unreadDialogIds, [ev.dialogId]: true },
    };
  }

  if (ev.type === "dialog.failed" && ev.dialogId) {
    const ts = nextDialogEventTimestamp(state.dialogEventTimestamps[ev.dialogId], now);
    state = {
      ...state,
      dialogStatuses: { ...state.dialogStatuses, [ev.dialogId]: "failed" },
      dialogEventTimestamps: { ...state.dialogEventTimestamps, [ev.dialogId]: ts },
      unreadDialogIds: { ...state.unreadDialogIds, [ev.dialogId]: true },
    };
  }

  notify();
}

/**
 * 清除某 dialog 的未读状态（markDialogRead 调用）。
 */
export function clearDialogUnread(dialogId: string): void {
  if (state.unreadDialogIds[dialogId] === undefined) return;
  const next = { ...state.unreadDialogIds };
  delete next[dialogId];
  state = { ...state, unreadDialogIds: next };
  notify();
}

/**
 * 重置 dialog 实时状态（切换用户/空间时调用）。
 */
export function resetSpaceDialogState(): void {
  state = createInitialState();
  notify();
}

// ===== React hooks =====

export function useDialogStatus(dialogId: string | null): string | undefined {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return dialogId ? state.dialogStatuses[dialogId] : undefined;
}

export function useIsDialogUnread(dialogId: string | null): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return dialogId ? state.unreadDialogIds[dialogId] === true : false;
}