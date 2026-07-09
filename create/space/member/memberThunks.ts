// create/space/member/memberThunks.ts
import type { SpaceState } from "../types";
import { fetchUserSpaceMembershipsAction } from "./fetchUserSpaceMembershipsAction";
import { addMemberAction } from "./addMemberAction";
import { removeMemberAction } from "./removeMemberAction";

type Create = {
  asyncThunk: (...args: any[]) => any;
  reducer: (...args: any[]) => any;
};

/**
 * 创建与成员相关的 Async Thunks
 * @param create - 由 buildCreateSlice 提供的创建器对象
 */
export const createMemberThunks = (create: Create) => ({
  fetchUserSpaceMemberships: create.asyncThunk(
    fetchUserSpaceMembershipsAction,
    {
      pending: (state: SpaceState) => {
        state.loading = true;
      },
      fulfilled: (state: SpaceState, action: any) => {
        state.memberSpaces = action.payload;
        state.loading = false;
      },
      rejected: (state: SpaceState, action: any) => {
        state.loading = false;
        state.error = action.error.message;
      },
    }
  ),

  addMember: create.asyncThunk(addMemberAction, {
    fulfilled: (state: SpaceState, action: any) => {
      if (state.currentSpaceId === action.payload.spaceId) {
        state.currentSpace = action.payload.updatedSpaceData;
      }
    },
  }),

  removeMember: create.asyncThunk(removeMemberAction, {
    fulfilled: (state: SpaceState, action: any) => {
      if (state.currentSpaceId === action.payload.spaceId) {
        state.currentSpace = action.payload.updatedSpaceData;
      }
    },
  }),
});
