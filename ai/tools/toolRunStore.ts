// File: ai/tools/toolRunStore.ts
// Module store for ToolRun — peeled out of Redux (Wave7).
// Mirrors packages/app/notifications/notificationStore.ts +
// packages/ai/agent/publicAgentsSSRStore.ts (content snapshot for
// useSyncExternalStore so UI updates when runs change).
//
// Reducer semantics below are copied verbatim from the deleted toolRunSlice.ts
// (upsert/update/remove filters, processLaunch helpers, startedAt ascending
// sortComparer). toolRun state reads/writes no longer go through Redux; the
// only Redux-bound piece left is `executeToolRun`, kept as createAsyncThunk so
// call sites stay `dispatch(executeToolRun(...))` — but inside it calls the
// mutators below directly and reads via getToolRunById.

import {
  createAsyncThunk,
  type AsyncThunk,
} from "@reduxjs/toolkit";
import { useSyncExternalStore } from "react";
import { toErrorMessage } from "../../core/errorMessage";
import { asOptionalTrimmedString } from "../../core/optionalString";
import type { ProcessLaunchInfo } from "../../chat/messages/types";
import type { ToolBehavior, ToolInteraction } from ".";
import { getToolResultErrorData } from "./toolResultError";

// ===== types =====

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
  /** launchProcess 启动的后台进程信息。独立于 toolRun 状态机：
   * 工具调用本身是 succeeded（立即返回），但进程后续可 running→stopped→exited 流转。 */
  processLaunch?: ProcessLaunchInfo;
}

export const createToolRunId = () =>
  `toolrun_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// ===== internal state =====

// Map preserves insertion order; getAllToolRuns sorts by startedAt ascending
// (same as the old entity adapter sortComparer).
const runsById = new Map<string, ToolRun>();

const listeners = new Set<() => void>();

// Client-only store (no SSR) — version counter matches notificationStore.
// A hand-rolled content snapshot previously omitted outputSummary/steps and
// missed deploy-progress UI updates from toolRunUpdated.
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

// ===== mutators (plain functions — same payloads as old actions) =====

export function toolRunStarted(payload: {
  id: string;
  messageId: string;
  toolName: string;
  behavior?: ToolBehavior;
  inputSummary?: string;
  startedAt?: number;
  interaction?: ToolInteraction;
  input?: any;
}): void {
  const {
    id,
    messageId,
    toolName,
    behavior,
    inputSummary,
    startedAt,
    interaction,
    input,
  } = payload;
  // 每次开始（包括重试）都清空上一次的 error / 输出 / 结束时间
  runsById.set(id, {
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
  notify();
}

// 把某个 ToolRun 状态设为 pending（用于“预览但未执行”的阶段）
export function toolRunSetPending(payload: { id: string }): void {
  const { id } = payload;
  const run = runsById.get(id);
  if (run) {
    run.status = "pending";
    notify();
  }
}

export function toolRunSucceeded(payload: {
  id: string;
  outputSummary?: string;
  steps?: ToolRunStep[];
  finishedAt?: number;
}): void {
  const { id, outputSummary, steps, finishedAt } = payload;
  const run = runsById.get(id);
  if (run) {
    run.status = "succeeded";
    run.outputSummary = outputSummary;
    if (steps !== undefined) {
      run.steps = steps;
    }
    run.finishedAt = finishedAt ?? Date.now();
    notify();
  }
}

export function toolRunUpdated(payload: {
  id: string;
  outputSummary?: string;
  steps?: ToolRunStep[];
}): void {
  const { id, outputSummary, steps } = payload;
  const run = runsById.get(id);
  if (run) {
    if (outputSummary !== undefined) {
      run.outputSummary = outputSummary;
    }
    if (steps !== undefined) {
      run.steps = steps;
    }
    notify();
  }
}

export function toolRunFailed(payload: {
  id: string;
  error: string;
  outputSummary?: string;
  steps?: ToolRunStep[];
  finishedAt?: number;
}): void {
  const { id, error, outputSummary, steps, finishedAt } = payload;
  const run = runsById.get(id);
  if (run) {
    run.status = "failed";
    run.error = error;
    if (outputSummary !== undefined) {
      run.outputSummary = outputSummary;
    }
    if (steps !== undefined) {
      run.steps = steps;
    }
    run.finishedAt = finishedAt ?? Date.now();
    notify();
  }
}

export function resetToolRunsForMessage(payload: { messageId: string }): void {
  const { messageId } = payload;
  let changed = false;
  for (const [id, run] of runsById) {
    if (run.messageId === messageId) {
      runsById.delete(id);
      changed = true;
    }
  }
  if (changed) notify();
}

export function resetAllToolRuns(): void {
  if (runsById.size === 0) return;
  runsById.clear();
  notify();
}

export function updateProcessLaunchStatus(payload: {
  toolRunId: string;
  status: ProcessLaunchInfo["status"];
  exitCode?: number;
}): void {
  const run = runsById.get(payload.toolRunId);
  if (run?.processLaunch) {
    run.processLaunch.status = payload.status;
    if (payload.exitCode !== undefined) {
      run.processLaunch.exitCode = payload.exitCode;
    }
    notify();
  }
}

/** 将 processLaunch 信息写入 toolRun（launchProcess 工具返回后调用）。 */
export function setProcessLaunch(payload: {
  toolRunId: string;
  processLaunch: ProcessLaunchInfo;
}): void {
  const run = runsById.get(payload.toolRunId);
  if (run) {
    run.processLaunch = payload.processLaunch;
    notify();
  }
}

// ===== reads =====

export function getAllToolRuns(): ToolRun[] {
  return Array.from(runsById.values()).sort((a, b) => a.startedAt - b.startedAt);
}

export function getToolRunById(id: string): ToolRun | undefined {
  return runsById.get(id);
}

export function getToolRunsByMessageId(messageId: string): ToolRun[] {
  return getAllToolRuns().filter((run) => run.messageId === messageId);
}

// ===== useSyncExternalStore =====

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): number {
  return version;
}

export function useAllToolRuns(): ToolRun[] {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getAllToolRuns();
}

export function useToolRunById(id: string): ToolRun | undefined {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getToolRunById(id);
}

export function useToolRunsByMessageId(messageId: string): ToolRun[] {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getToolRunsByMessageId(messageId);
}

export function resetToolRunStoreForTests(): void {
  runsById.clear();
  notify();
}

// ===== 通用执行 thunk：基于已有 ToolRun.input 再次执行工具（可作为重试） =====
//
// 保留 createAsyncThunk 名称/导出，调用方仍是 dispatch(executeToolRun(...))。
// 但 toolRun 状态读写不走 Redux：run 从 getToolRunById 取，状态推进直接调
// mutator（toolRunStarted / toolRunSucceeded / toolRunFailed），只剩
// findToolExecutor 的 thunkApi 第二参数、fetchUserSpaceMemberships dispatch、
// getState().auth 仍走 Redux。

export const executeToolRun: AsyncThunk<
  // payload creator 总是返回这三个键（rawData/displayData 可能是 undefined 值，
  // 但键本身一定在），写成可选键会与 createAsyncThunk 推导出的类型不兼容。
  { id: string; rawData: any; displayData: any },
  { id: string; inputOverride?: Record<string, unknown> },
  any
> = createAsyncThunk(
  "toolRun/executeToolRun",
  async (
    { id, inputOverride }: { id: string; inputOverride?: Record<string, unknown> },
    thunkApi
  ) => {
    const run = getToolRunById(id);

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
    toolRunStarted({
      id: run.id,
      messageId: run.messageId,
      toolName: run.toolName,
      behavior: run.behavior,
      inputSummary: run.inputSummary,
      startedAt: Date.now(),
      interaction: run.interaction,
      input: executionInput,
    });

    try {
      const result = await executor(executionInput, thunkApi, {
        parentMessageId: run.messageId,
      });

      toolRunSucceeded({
        id: run.id,
        outputSummary: result?.displayData || "",
      });

      if (run.toolName === "deleteSpaces") {
        const latestState = thunkApi.getState() as any;
        const userId = latestState.auth?.currentUser?.userId;
        if (userId) {
          const { fetchUserSpaceMemberships } = await import(
            "../../create/space/spaceSlice"
          );
          await thunkApi.dispatch(fetchUserSpaceMemberships(userId) as any);
        }
      }

      return {
        id: run.id,
        rawData: result?.rawData,
        displayData: result?.displayData,
      };
    } catch (e: any) {
      const msg = toErrorMessage(e);
      const structured = getToolResultErrorData(e);
      toolRunFailed({
        id: run.id,
        error: msg,
        outputSummary: asOptionalTrimmedString(structured?.displayData),
      });
      throw e;
    }
  }
);