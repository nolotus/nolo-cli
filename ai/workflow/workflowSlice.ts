import { type PayloadAction, createSlice } from "@reduxjs/toolkit";
import type { RootState } from "../../app/store";
import type {
  WorkflowStepState,
  WorkflowExecutionStats,
} from "./workflowTypes";

interface WorkflowSliceState {
  title: string | null;
  steps: WorkflowStepState[];
  stats: WorkflowExecutionStats;
}

const initialState: WorkflowSliceState = {
  title: null,
  steps: [],
  stats: {
    startTime: null,
    totalStepsExecuted: 0,
    failedSteps: 0,
  },
};

const workflowSlice = createSlice({
  name: "workflow",
  initialState,
  reducers: {
    setWorkflow: (
      state,
      action: PayloadAction<{ title: string; steps: WorkflowStepState[] }>
    ) => {
      state.title = action.payload.title;
      state.steps = action.payload.steps;
      state.stats = { startTime: Date.now(), totalStepsExecuted: 0, failedSteps: 0 };
    },

    updateStep: (
      state,
      action: PayloadAction<{ id: string; updates: Partial<WorkflowStepState> }>
    ) => {
      const step = state.steps.find((s) => s.id === action.payload.id);
      if (step) Object.assign(step, action.payload.updates);
    },

    incrementStepsExecuted: (state) => {
      state.stats.totalStepsExecuted += 1;
    },

    incrementFailedSteps: (state) => {
      state.stats.failedSteps += 1;
    },

    clearWorkflow: () => initialState,
  },
});

export const {
  setWorkflow,
  updateStep,
  incrementStepsExecuted,
  incrementFailedSteps,
  clearWorkflow,
} = workflowSlice.actions;

export const selectWorkflowSteps = (state: RootState) => state.workflow.steps;
export const selectWorkflowTitle = (state: RootState) => state.workflow.title;
export const selectWorkflowStats = (state: RootState) => state.workflow.stats;
export const selectPendingSteps = (state: RootState) =>
  state.workflow.steps.filter((s: WorkflowStepState) => s.status === "pending");
export const selectCompletedSteps = (state: RootState) =>
  state.workflow.steps.filter((s: WorkflowStepState) => s.status === "completed");

export default workflowSlice.reducer;
