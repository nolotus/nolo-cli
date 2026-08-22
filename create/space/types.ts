import { SpaceData } from "../../app/types";

export type SpaceId = string;

// Space state types have been migrated to module stores.
// These types remain for thunk compatibility signatures only.

/** View mode is owned by spaceCurrentStore. Re-exported here for convenience. */
export type SpaceViewMode = "all" | "categories";

/** Membership status is owned by spaceMembershipStore. Re-exported here for convenience. */
export type MembershipStatus = "idle" | "loading" | "fresh" | "offline";

export interface CreateSpaceRequest {
  name: string;
  description?: string;
  visibility?: string;
  /** 空间绑定的本地文件夹路径（桌面端专用） */
  boundFolder?: string;
}

/**
 * Empty state type for the spaceSlice compatibility shell.
 * All actual state lives in module stores. This type exists only because
 * RTK thunk reducer callbacks require a state parameter type.
 * Do NOT add fields here — new state goes in a module store.
 */
export type SpaceState = Record<string, never>;