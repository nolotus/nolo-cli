// packages/create/space/spaceEventCore.ts
//
// 侧边栏对话实时状态的纯决策 core（Wave22，自 spaceSlice.applySpaceEvent 剥出）。
// 把 SSE space 事件（dialog.created / dialog.done / dialog.failed）翻译成对 space
// 运行时指示字段（dialogStatuses / dialogEventTimestamps / dialogTitles /
// unreadDialogIds，以及当前 space 的 contents）的就地变更。
//
// 纯逻辑、无 Redux/RTK 依赖，可脱离 store 单测；reducer 仅做一行接线：
//   applySpaceEvent: create.reducer<SpaceEvent>((state, action) =>
//     applySpaceEventCore(state, action.payload))
// 行为与剥出前 spaceSlice.applySpaceEvent reducer 完全一致。
import { toTimestampMs } from "../../core/timestamp";

export interface SpaceEvent {
  type: string;
  dialogId?: string;
  dialogKey?: string;
  title?: string;
  status?: string;
}

/** applySpaceEvent 会就地读写的当前 space 子集（解耦 app/types，仅取用到的字段）。 */
export interface SpaceEventCurrentSpace {
  contents?: Record<string, any>;
  updatedAt?: number | string;
  [key: string]: any;
}

/** applySpaceEvent 会就地读写的 space state 子集。 */
export interface SpaceEventState {
  currentSpace: SpaceEventCurrentSpace | null;
  dialogStatuses: Record<string, string>;
  dialogEventTimestamps: Record<string, number>;
  dialogTitles: Record<string, string>;
  unreadDialogIds: Record<string, boolean>;
}

/**
 * 单调递增事件时间戳：始终 > prev 且 >= now。
 * now 可注入以便确定性单测；默认 Date.now() 与剥出前 nextUpdatedAt 一致。
 */
export const nextSpaceEventTimestamp = (
  prev: number | string | undefined,
  now: number = Date.now()
): number => Math.max(now, toTimestampMs(prev) + 1);

/**
 * 就地把一个 SSE space 事件应用到 state 子集。
 * 三个分支互斥（事件 type 唯一），结构与剥出前 reducer 保持一致。
 */
export const applySpaceEventCore = (
  state: SpaceEventState,
  ev: SpaceEvent,
  now: number = Date.now()
): void => {
  if (ev.type === "dialog.created" && ev.dialogKey && ev.dialogId && ev.title) {
    // 追加到当前 space 的 contents（侧边栏立即可见）
    const ts = nextSpaceEventTimestamp(state.dialogEventTimestamps[ev.dialogId], now);
    if (state.currentSpace) {
      if (!state.currentSpace.contents) {
        state.currentSpace.contents = {};
      }
      state.currentSpace.contents[ev.dialogKey] = {
        title: ev.title,
        type: "dialog" as any,
        contentKey: ev.dialogKey,
        pinned: false,
        createdAt: ts,
        updatedAt: ts,
      };
      state.currentSpace.updatedAt = ts;
    }
    state.dialogStatuses[ev.dialogId] = "running";
    state.dialogEventTimestamps[ev.dialogId] = ts;
    state.dialogTitles[ev.dialogId] = ev.title;
    delete state.unreadDialogIds[ev.dialogId];
  }

  if (ev.type === "dialog.done" && ev.dialogId) {
    state.dialogStatuses[ev.dialogId] = "done";
    state.dialogEventTimestamps[ev.dialogId] = nextSpaceEventTimestamp(
      state.dialogEventTimestamps[ev.dialogId],
      now
    );
    state.unreadDialogIds[ev.dialogId] = true;
  }

  if (ev.type === "dialog.failed" && ev.dialogId) {
    state.dialogStatuses[ev.dialogId] = "failed";
    state.dialogEventTimestamps[ev.dialogId] = nextSpaceEventTimestamp(
      state.dialogEventTimestamps[ev.dialogId],
      now
    );
    state.unreadDialogIds[ev.dialogId] = true;
  }
};
