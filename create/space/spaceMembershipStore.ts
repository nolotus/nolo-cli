// File: create/space/spaceMembershipStore.ts
// Module store for space membership list and loading status.
// State: memberSpaces, loading, membershipStatus, initialized, error.

import { useSyncExternalStore } from "react";
import { toTimestampMs } from "../../core/timestamp";
import { MemberRole, type SpaceMemberWithSpaceInfo } from "../../app/types";
import { normalizeSpaceId } from "./spaceKeys";

export type MembershipStatus = "idle" | "loading" | "fresh" | "offline";

export interface SpaceMembershipState {
  memberSpaces: SpaceMemberWithSpaceInfo[] | null;
  loading: boolean;
  membershipStatus: MembershipStatus;
  initialized: boolean;
  error?: string;
}

const createInitialState = (): SpaceMembershipState => ({
  memberSpaces: null,
  loading: false,
  membershipStatus: "idle",
  initialized: false,
});

let state: SpaceMembershipState = createInitialState();
const listeners = new Set<() => void>();
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

// ===== subscribe / getSnapshot =====

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): number {
  return version;
}

// ===== getters =====

const getMembershipUpdatedAt = (space: any): number => {
  if (!space) return 0;
  return toTimestampMs(
    space.spaceUpdatedAt ??
      space.memberUpdatedAt ??
      space.updatedAt ??
      space.createdAt ??
      space.joinedAt
  );
};

export function dedupeMemberSpacesById<T extends { spaceId: string }>(
  memberSpaces: T[]
): T[] {
  const membershipMap = new Map<string, T>();
  memberSpaces.forEach((space) => {
    const prev = membershipMap.get(space.spaceId);
    if (!prev || getMembershipUpdatedAt(space) >= getMembershipUpdatedAt(prev)) {
      membershipMap.set(space.spaceId, space);
    }
  });
  return Array.from(membershipMap.values());
}

export function getMemberSpaces(): readonly SpaceMemberWithSpaceInfo[] | null {
  return state.memberSpaces;
}

/** 去重 + 按更新时间降序排序（原 selectAllMemberSpaces 逻辑）。 */
export function getAllMemberSpaces(): readonly SpaceMemberWithSpaceInfo[] {
  const memberSpaces = dedupeMemberSpacesById(state.memberSpaces || []);
  return [...memberSpaces].sort((a, b) => {
    return getMembershipUpdatedAt(b) - getMembershipUpdatedAt(a);
  });
}

export function getOwnedMemberSpaces(): readonly SpaceMemberWithSpaceInfo[] {
  return getAllMemberSpaces().filter(
    (space) => space.role === MemberRole.OWNER
  );
}

export function getMemberSpacesLoaded(): boolean {
  return state.memberSpaces !== null;
}

export function getMembershipStatus(): MembershipStatus {
  return state.membershipStatus ?? "idle";
}

export function getSpaceLoading(): boolean {
  return state.loading;
}

export function getSpaceInitialized(): boolean {
  return state.initialized;
}

export function getSpaceError(): string | undefined {
  return state.error;
}

// ===== mutators =====

export function setMemberSpaces(
  spaces: SpaceMemberWithSpaceInfo[]
): void {
  state = {
    ...state,
    memberSpaces: spaces,
    loading: false,
    error: undefined,
    membershipStatus: "fresh",
    initialized: true,
  };
  notify();
}

export function setMembershipLoading(): void {
  state = { ...state, loading: true, membershipStatus: "loading" };
  notify();
}

export function setMembershipRejected(
  errorMessage: string,
  isRemoteUnavailable: boolean
): void {
  const membershipStatus: MembershipStatus = isRemoteUnavailable
    ? "offline"
    : state.membershipStatus === "loading"
      ? "idle"
      : state.membershipStatus;
  state = {
    ...state,
    loading: false,
    error: errorMessage,
    membershipStatus,
  };
  notify();
}

/** 用本地缓存先恢复空间列表（hydrateMemberSpacesFromLocal）。 */
export function hydrateMemberSpacesFromLocal(
  spaces: SpaceMemberWithSpaceInfo[]
): void {
  if (state.memberSpaces !== null || spaces.length === 0) return;
  state = {
    ...state,
    memberSpaces: dedupeMemberSpacesById(spaces),
    loading: false,
  };
  notify();
}

/** 追加恢复的 membership（appendRecoveredMemberships）。 */
export function appendRecoveredMemberships(
  recovered: SpaceMemberWithSpaceInfo[]
): void {
  if (!recovered || recovered.length === 0) return;
  if (state.memberSpaces === null) {
    state = {
      ...state,
      memberSpaces: dedupeMemberSpacesById(recovered),
    };
    notify();
    return;
  }
  state = {
    ...state,
    memberSpaces: dedupeMemberSpacesById([
      ...state.memberSpaces,
      ...recovered,
    ]).sort((a, b) => toTimestampMs(b.joinedAt) - toTimestampMs(a.joinedAt)),
  };
  notify();
}

/** mark space as initialized (fetchSpace fulfilled)。 */
export function setSpaceInitialized(): void {
  state = { ...state, initialized: true };
  notify();
}

/** changeSpace fulfilled 清除 loading（不更新 memberSpaces）。 */
export function setMembershipLoaded(): void {
  state = { ...state, loading: false, error: undefined };
  notify();
}

/** addSpace fulfilled 追加新 space。
 *  顺序与原 Redux 实现一致：[...existing, space]，保证 dedupe 在等时间戳时新 space 胜出。 */
export function addMemberSpace(space: SpaceMemberWithSpaceInfo): void {
  const existing = state.memberSpaces || [];
  state = {
    ...state,
    memberSpaces: dedupeMemberSpacesById([...existing, space]),
  };
  notify();
}

/** deleteSpace fulfilled 从列表删除。
 *  spaceId 会被 normalizeSpaceId 处理，所以两边都 normalize 再比。 */
export function removeMemberSpace(spaceId: string): void {
  if (!state.memberSpaces) return;
  const normalized = normalizeSpaceId(spaceId);
  state = {
    ...state,
    memberSpaces: state.memberSpaces.filter(
      (s) => normalizeSpaceId(s.spaceId) !== normalized
    ),
  };
  notify();
}

/** updateSpace fulfilled 更新 spaceName。 */
export function updateMemberSpaceName(
  spaceId: string,
  name: string
): void {
  if (!state.memberSpaces || !name) return;
  state = {
    ...state,
    memberSpaces: state.memberSpaces.map((space) =>
      space.spaceId === spaceId ? { ...space, spaceName: name } : space
    ),
  };
  notify();
}

/** 重置（切换用户时调用）。 */
export function resetSpaceMembershipState(): void {
  state = createInitialState();
  notify();
}

// ===== React hooks =====

export function useAllMemberSpaces(): readonly SpaceMemberWithSpaceInfo[] {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getAllMemberSpaces();
}

export function useOwnedMemberSpaces(): readonly SpaceMemberWithSpaceInfo[] {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getOwnedMemberSpaces();
}

export function useMemberSpacesLoaded(): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getMemberSpacesLoaded();
}

export function useMembershipStatus(): MembershipStatus {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getMembershipStatus();
}

export function useSpaceLoading(): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getSpaceLoading();
}

export function useSpaceInitialized(): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getSpaceInitialized();
}