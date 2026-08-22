// create/space/member/memberThunks.ts
import type { SpaceState } from "../types";
// Wave D: currentSpaceId/currentSpace 已剥至 module store。
import {
  getCurrentSpaceIdRaw,
  updateCurrentSpaceIfMatch,
} from "../spaceCurrentStore";
import { fetchUserSpaceMembershipsAction } from "./fetchUserSpaceMembershipsAction";
import { addMemberAction } from "./addMemberAction";
import { removeMemberAction } from "./removeMemberAction";
import { isSpaceMembershipRemoteUnavailableError } from "./isSpaceMembershipRemoteUnavailableError";
// Wave C: memberSpaces/loading/membershipStatus 已剥至 module store。
import {
  setMemberSpaces,
  setMembershipLoading,
  setMembershipRejected,
} from "../spaceMembershipStore";

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
        // Wave C: loading/membershipStatus 已剥至 module store。
        setMembershipLoading();
      },
      fulfilled: (state: SpaceState, action: any) => {
        // Wave C: memberSpaces/loading/membershipStatus/initialized 已剥至 module store。
        setMemberSpaces(action.payload);
      },
      rejected: (state: SpaceState, action: any) => {
        // Wave C: error/membershipStatus 已剥至 module store。
        setMembershipRejected(
          action.error.message,
          isSpaceMembershipRemoteUnavailableError(action.error)
        );
      },
    }
  ),

  addMember: create.asyncThunk(addMemberAction, {
    fulfilled: (state: SpaceState, action: any) => {
      if (getCurrentSpaceIdRaw() === action.payload.spaceId) {
        updateCurrentSpaceIfMatch(action.payload.spaceId, action.payload.updatedSpaceData);
      }
    },
  }),

  removeMember: create.asyncThunk(removeMemberAction, {
    fulfilled: (state: SpaceState, action: any) => {
      if (getCurrentSpaceIdRaw() === action.payload.spaceId) {
        updateCurrentSpaceIfMatch(action.payload.spaceId, action.payload.updatedSpaceData);
      }
    },
  }),
});