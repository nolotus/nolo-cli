import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import { RootState } from "../store";

export interface AppSelectedNode {
  cssPath: string;
  tagName: string;
  classList: string[];
  textSnippet: string;
  outerHTMLSnippet: string;
  noloLoc?: string;
}

interface AppInspectorState {
  inspecting: boolean;
  appKey: string | null;
  selectedNode: AppSelectedNode | null;
}

const initialState: AppInspectorState = {
  inspecting: false,
  appKey: null,
  selectedNode: null,
};

const appInspectorSlice = createSlice({
  name: "appInspector",
  initialState,
  reducers: {
    setInspecting(state, action: PayloadAction<boolean>) {
      state.inspecting = action.payload;
    },
    setSelectedNode(
      state,
      action: PayloadAction<{ appKey: string; node: AppSelectedNode }>
    ) {
      state.appKey = action.payload.appKey;
      state.selectedNode = action.payload.node;
    },
    clearSelectedNode(state) {
      state.selectedNode = null;
      state.appKey = null;
    },
  },
});

export const { setInspecting, setSelectedNode, clearSelectedNode } =
  appInspectorSlice.actions;

export const selectAppInspecting = (state: RootState) =>
  state.appInspector?.inspecting ?? false;

export const selectAppSelectedNode = (state: RootState) =>
  state.appInspector?.selectedNode ?? null;

export default appInspectorSlice.reducer;
