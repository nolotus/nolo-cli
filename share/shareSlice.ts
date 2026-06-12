// 路径: share/shareSlice.ts
// 职责：管理 Share 相关的 Redux 状态，支持 SSR 首屏预载

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { ShareSummary } from ".//types";

interface ShareState {
  communityShares: {
    loading: boolean;
    error: string | null;
    data: ShareSummary[];
    nextCursor?: string;
  };
}

const initialState: ShareState = {
  communityShares: {
    loading: false,
    error: null,
    data: [],
    nextCursor: undefined,
  },
};

const shareSlice = createSlice({
  name: "share",
  initialState,
  reducers: {
    /**
     * SSR 首屏：服务端预取社区分享列表后注入，走 __PRELOADED_STATE__ 链路
     */
    setSSRCommunityShares: (
      state,
      action: PayloadAction<{ data: ShareSummary[]; nextCursor?: string }>
    ) => {
      state.communityShares.data = Array.isArray(action.payload.data)
        ? action.payload.data
        : [];
      state.communityShares.nextCursor = action.payload.nextCursor;
      state.communityShares.loading = false;
      state.communityShares.error = null;
    },
  },
});

export const { setSSRCommunityShares } = shareSlice.actions;
export default shareSlice.reducer;

/** 读取 SSR 预载的社区分享列表 */
export const selectSSRCommunityShares = (
  state: any
): { data: ShareSummary[]; nextCursor?: string } =>
  state.share?.communityShares ?? { data: [], nextCursor: undefined };
