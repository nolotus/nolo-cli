// File: ai/tools/toolRunSlice.ts
import {
  createSlice,
  createEntityAdapter,
  EntityState,
  PayloadAction,
  createAsyncThunk,
  createSelector,
} from "@reduxjs/toolkit";

import type { ToolBehavior, ToolInteraction } from ".";
import { getToolResultErrorData } from "./toolResultError";

export type ToolRunStatus = "pending" | "running" | "succeeded" | "failed";
export type ToolRunStepStatus = ToolRunStatus;

export interface ToolRunStep {
  id: string;
  label: string;
  status: ToolRunStepStatus;
  detail?: string;
}

export interface ToolRun {
  id: string;
  messageId: string; // 这次工具调用属于哪条消息或步骤消息
  toolName: string;
  behavior?: ToolBehavior;
  inputSummary?: string;
  outputSummary?: string;
  steps?: ToolRunStep[];
  status: ToolRunStatus;
  error?: string;
  startedAt: number;
  finishedAt?: number;

  // 交互模式（从 ToolDefinition 抄过来）
  interaction?: ToolInteraction;

  // 保存本次调用的完整参数，后续确认或重放时会用到
  input?: any;
}

const toolRunAdapter = createEntityAdapter<ToolRun, string>({
  selectId: (run: ToolRun) => run.id,
  sortComparer: (a, b) => a.startedAt - b.startedAt,
});

export interface ToolRunSliceState {
  runs: EntityState<ToolRun, string>;
}

const initialState: ToolRunSliceState = {
  runs: toolRunAdapter.getInitialState(),
};

export const createToolRunId = () =>
  `toolrun_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

const toolRunSlice = createSlice({
  name: "toolRun",
  initialState,
  reducers: {
    toolRunStarted: (
      state,
      action: PayloadAction<{
        id: string;
        messageId: string;
        toolName: string;
        behavior?: ToolBehavior;
        inputSummary?: string;
        startedAt?: number;
        interaction?: ToolInteraction;
        input?: any;
      }>
    ) => {
      const {
        id,
        messageId,
        toolName,
        behavior,
        inputSummary,
        startedAt,
        interaction,
        input,
      } = action.payload;

      // 每次开始（包括重试）都清空上一次的 error / 输出 / 结束时间
      toolRunAdapter.upsertOne(state.runs, {
        id,
        messageId,
        toolName,
        behavior,
        inputSummary,
        status: "running",
        startedAt: startedAt ?? Date.now(),
        interaction,
        input,
          error: undefined,
          finishedAt: undefined,
          outputSummary: undefined,
          steps: undefined,
        });
    },

    // 把某个 ToolRun 状态设为 pending（用于“预览但未执行”的阶段）
    toolRunSetPending: (
      state,
      action: PayloadAction<{
        id: string;
      }>
    ) => {
      const { id } = action.payload;
      toolRunAdapter.updateOne(state.runs, {
        id,
        changes: {
          status: "pending",
        },
      });
    },

    toolRunSucceeded: (
      state,
      action: PayloadAction<{
        id: string;
        outputSummary?: string;
        steps?: ToolRunStep[];
        finishedAt?: number;
      }>
    ) => {
      const { id, outputSummary, steps, finishedAt } = action.payload;
      toolRunAdapter.updateOne(state.runs, {
        id,
        changes: {
          status: "succeeded",
          outputSummary,
          ...(steps === undefined ? {} : { steps }),
          finishedAt: finishedAt ?? Date.now(),
        },
      });
    },
    toolRunUpdated: (
      state,
      action: PayloadAction<{
        id: string;
        outputSummary?: string;
        steps?: ToolRunStep[];
      }>
    ) => {
      const { id, outputSummary, steps } = action.payload;
      toolRunAdapter.updateOne(state.runs, {
        id,
        changes: {
          ...(outputSummary === undefined ? {} : { outputSummary }),
          ...(steps === undefined ? {} : { steps }),
        },
      });
    },
    toolRunFailed: (
      state,
      action: PayloadAction<{
        id: string;
        error: string;
        outputSummary?: string;
        steps?: ToolRunStep[];
        finishedAt?: number;
      }>
    ) => {
      const { id, error, outputSummary, steps, finishedAt } = action.payload;
      toolRunAdapter.updateOne(state.runs, {
        id,
        changes: {
          status: "failed",
          error,
          ...(outputSummary === undefined ? {} : { outputSummary }),
          ...(steps === undefined ? {} : { steps }),
          finishedAt: finishedAt ?? Date.now(),
        },
      });
    },
    resetToolRunsForMessage: (
      state,
      action: PayloadAction<{ messageId: string }>
    ) => {
      const { messageId } = action.payload;
      const all = state.runs.ids as string[];
      const toRemove = all.filter((id) => {
        const run = state.runs.entities[id];
        return run?.messageId === messageId;
      });
      toolRunAdapter.removeMany(state.runs, toRemove);
    },
    resetAllToolRuns: (state) => {
      toolRunAdapter.removeAll(state.runs);
    },
  },
});

export const {
  toolRunStarted,
  toolRunSetPending,
  toolRunSucceeded,
  toolRunUpdated,
  toolRunFailed,
  resetToolRunsForMessage,
  resetAllToolRuns,
} = toolRunSlice.actions;

export default toolRunSlice.reducer;

// ===== selectors =====
const selectors = toolRunAdapter.getSelectors<any>(
  (state) => state.toolRun.runs
);

export const selectAllToolRuns = selectors.selectAll;

export const selectToolRunsByMessageId = createSelector(
  [selectors.selectAll, (_state: any, messageId: string) => messageId],
  (runs, messageId) => runs.filter((run) => run.messageId === messageId)
);

// 按 id 精确获取（导出给组件用）
export const selectToolRunById = (
  state: any,
  id: string
): ToolRun | undefined => selectors.selectById(state, id);

// ===== 通用执行 thunk：基于已有 ToolRun.input 再次执行工具（可作为重试） =====
export const executeToolRun = createAsyncThunk(
  "toolRun/executeToolRun",
  async ({ id, inputOverride }: { id: string; inputOverride?: Record<string, unknown> }, thunkApi) => {
    const state = thunkApi.getState() as any;
    const run = selectToolRunById(state, id);

    if (!run) {
      throw new Error(`ToolRun not found: ${id}`);
    }
    const executionInput = inputOverride ?? run.input;
    if (!executionInput) {
      throw new Error(`ToolRun ${id} has no input to execute with.`);
    }

    const { findToolExecutor } = await import(".");
    const { executor } = findToolExecutor(run.toolName);

    // 点击按钮时，把状态重新置为 running，方便 UI 显示“执行中…”；这同时也清掉旧错误
    thunkApi.dispatch(
      toolRunStarted({
        id: run.id,
        messageId: run.messageId,
        toolName: run.toolName,
        behavior: run.behavior,
        inputSummary: run.inputSummary,
        startedAt: Date.now(),
        interaction: run.interaction,
        input: executionInput,
      })
    );

    try {
      const result = await executor(executionInput, thunkApi, {
        parentMessageId: run.messageId,
      });

      thunkApi.dispatch(
        toolRunSucceeded({
          id: run.id,
          outputSummary: result?.displayData || "",
        })
      );

      if (run.toolName === "deleteSpaces") {
        const latestState = thunkApi.getState() as any;
        const userId = latestState.auth?.currentUser?.userId;
        if (userId) {
          const { fetchUserSpaceMemberships } = await import("../../create/space/spaceSlice");
          // @ts-expect-error dynamic import callability
          await thunkApi.dispatch(fetchUserSpaceMemberships(userId) as any);
        }
      }

      return {
        id: run.id,
        rawData: result?.rawData,
        displayData: result?.displayData,
      };
    } catch (e: any) {
      const msg = e?.message || String(e);
      const structured = getToolResultErrorData(e);
      thunkApi.dispatch(
        toolRunFailed({
          id: run.id,
          error: msg,
          outputSummary:
            (typeof structured?.displayData === "string" && structured.displayData.trim()) ||
            undefined,
        })
      );
      throw e;
    }
  }
);
