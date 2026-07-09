// ai/agent/planSlice.ts
// 管理计划（Plan）的 Redux 状态
// 支持普通步骤和反思步骤（reflect step）

import { type PayloadAction, createSlice } from "@reduxjs/toolkit";
import type { RootState } from "../../app/store";

// --- Interfaces ---

export interface PlanState {
  planDetails: string;
  currentProgress: number;
}

// 单个工具调用的接口
export interface ToolCall {
  tool_name: string;
  parameters: any;
}

// 反思决策的输出结构
export interface ReflectDecision {
  action: "continue" | "stop" | "insert_steps";
  reason: string;
  steps?: Omit<Step, "status" | "result">[]; // 仅当 action 是 insert_steps 时
}

// Step 类型：normal 或 reflect
export type StepType = "normal" | "reflect";

export interface Step {
  id: string;
  title: string;
  type?: StepType; // 默认 "normal"
  status: "pending" | "in-progress" | "completed" | "failed";

  // normal step 使用
  calls?: ToolCall[];

  // reflect step 使用
  reflectInput?: string; // 给反思 LLM 的提示

  // 通用
  details?: any;
  result?: any[]; // normal step: 工具调用结果; reflect step: ReflectDecision
}

// Plan 执行配置
export interface PlanExecutionConfig {
  maxReflectCount?: number; // 最多允许多少次 reflect step，默认不限
  maxTotalSteps?: number; // 最多执行多少个 step（包括动态插入的），默认不限
  maxTimeMs?: number; // 最大执行时间（毫秒），默认不限
}

interface PlanSliceState {
  plan: PlanState | null;
  steps: Step[];
  currentStep: string | null;
  executionConfig: PlanExecutionConfig | null;
  // 执行统计
  stats: {
    reflectCount: number;
    totalStepsExecuted: number;
    startTime: number | null;
  };
}

// --- Initial State ---

const initialState: PlanSliceState = {
  plan: null,
  steps: [],
  currentStep: null,
  executionConfig: null,
  stats: {
    reflectCount: 0,
    totalStepsExecuted: 0,
    startTime: null,
  },
};

// --- Slice Definition ---

const planSlice = createSlice({
  name: "plan",
  initialState,
  reducers: {
    // 设置整个计划的顶层信息
    setPlan: (state, action: PayloadAction<PlanState>) => {
      state.plan = action.payload;
    },

    // 更新计划的整体进度
    updatePlanProgress: (state, action: PayloadAction<number>) => {
      if (state.plan) {
        state.plan.currentProgress = action.payload;
      }
    },

    // 清除整个计划
    clearPlan: (state) => {
      state.plan = null;
      state.steps = [];
      state.currentStep = null;
      state.executionConfig = null;
      state.stats = {
        reflectCount: 0,
        totalStepsExecuted: 0,
        startTime: null,
      };
    },

    // 设置计划的所有步骤
    setSteps: (state, action: PayloadAction<Step[]>) => {
      state.steps = action.payload;
    },

    // 更新单个步骤的状态或结果
    updateStep: (
      state,
      action: PayloadAction<{ id: string; updates: Partial<Step> }>
    ) => {
      const step = state.steps.find((s) => s.id === action.payload.id);
      if (step) {
        Object.assign(step, action.payload.updates);
      }
    },

    // 设置当前正在执行的步骤ID
    setCurrentStep: (state, action: PayloadAction<string | null>) => {
      state.currentStep = action.payload;
    },

    // 清除所有步骤信息
    clearSteps: (state) => {
      state.steps = [];
      state.currentStep = null;
    },

    // 新增：在指定步骤之后插入新步骤
    insertStepsAfter: (
      state,
      action: PayloadAction<{
        afterStepId: string;
        newSteps: Step[];
      }>
    ) => {
      const { afterStepId, newSteps } = action.payload;
      const index = state.steps.findIndex((s) => s.id === afterStepId);
      if (index !== -1) {
        // 在 afterStepId 之后插入新步骤
        state.steps.splice(index + 1, 0, ...newSteps);
      }
    },

    // 新增：移除指定步骤之后的所有待执行步骤
    removeStepsAfter: (state, action: PayloadAction<string>) => {
      const afterStepId = action.payload;
      const index = state.steps.findIndex((s) => s.id === afterStepId);
      if (index !== -1) {
        // 只保留 afterStepId 及之前的步骤，以及已完成的步骤
        state.steps = state.steps.filter(
          (s, i) => i <= index || s.status === "completed"
        );
      }
    },

    // 新增：设置执行配置
    setExecutionConfig: (
      state,
      action: PayloadAction<PlanExecutionConfig | null>
    ) => {
      state.executionConfig = action.payload;
    },

    // 新增：更新执行统计
    updateStats: (
      state,
      action: PayloadAction<Partial<PlanSliceState["stats"]>>
    ) => {
      Object.assign(state.stats, action.payload);
    },

    // 新增：增加反思计数
    incrementReflectCount: (state) => {
      state.stats.reflectCount += 1;
    },

    // 新增：增加已执行步骤计数
    incrementStepsExecuted: (state) => {
      state.stats.totalStepsExecuted += 1;
    },

    // 新增：设置开始时间
    setStartTime: (state, action: PayloadAction<number>) => {
      state.stats.startTime = action.payload;
    },
  },
  selectors: {
    selectPlanState: (state: PlanSliceState) => state.plan,
    selectStepsState: (state: PlanSliceState) => state.steps,
    selectCurrentStepIdState: (state: PlanSliceState) => state.currentStep,
    selectExecutionConfigState: (state: PlanSliceState) =>
      state.executionConfig,
    selectStatsState: (state: PlanSliceState) => state.stats,
  },
});

// --- Exports ---

export const {
  setPlan,
  updatePlanProgress,
  clearPlan,
  setSteps,
  updateStep,
  setCurrentStep,
  clearSteps,
  insertStepsAfter,
  removeStepsAfter,
  setExecutionConfig,
  updateStats,
  incrementReflectCount,
  incrementStepsExecuted,
  setStartTime,
} = planSlice.actions;

export default planSlice.reducer;

// Selectors
export const selectPlan = (state: RootState): PlanState | null =>
  state.plan.plan;

export const selectSteps = (state: RootState): Step[] => state.plan.steps;

export const selectCurrentStepId = (state: RootState): string | null =>
  state.plan.currentStep;

export const selectCurrentStepDetails = (state: RootState): Step | null => {
  if (!state.plan.currentStep) return null;
  return (
    state.plan.steps.find((step: Step) => step.id === state.plan.currentStep) || null
  );
};

export const selectExecutionConfig = (
  state: RootState
): PlanExecutionConfig | null => state.plan.executionConfig;

export const selectPlanStats = (state: RootState): PlanSliceState["stats"] =>
  state.plan.stats;

// 新增：获取待执行的步骤
export const selectPendingSteps = (state: RootState): Step[] =>
  state.plan.steps.filter((s: Step) => s.status === "pending");

// 新增：获取已完成的步骤
export const selectCompletedSteps = (state: RootState): Step[] =>
  state.plan.steps.filter((s: Step) => s.status === "completed");
