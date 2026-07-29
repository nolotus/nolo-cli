// create/space/member/memberThunks.ts
import type { SpaceState } from "../types";
import { fetchUserSpaceMembershipsAction } from "./fetchUserSpaceMembershipsAction";
import { addMemberAction } from "./addMemberAction";
import { removeMemberAction } from "./removeMemberAction";
import { isSpaceMembershipRemoteUnavailableError } from "./isSpaceMembershipRemoteUnavailableError";

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
        // Keep cached memberSpaces; only mark refresh in progress.
        state.loading = true;
        state.membershipStatus = "loading";
      },
      fulfilled: (state: SpaceState, action: any) => {
        state.memberSpaces = action.payload;
        state.loading = false;
        state.error = undefined;
        state.membershipStatus = "fresh";
        // No sticky default space: memberships alone complete space boot.
        state.initialized = true;
      },
      rejected: (state: SpaceState, action: any) => {
        state.loading = false;
        state.error = action.error.message;
        // Preserve memberSpaces (incl. local hydrate preview).
        if (isSpaceMembershipRemoteUnavailableError(action.error)) {
          state.membershipStatus = "offline";
        } else if (state.membershipStatus === "loading") {
          state.membershipStatus = "idle";
        }
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
