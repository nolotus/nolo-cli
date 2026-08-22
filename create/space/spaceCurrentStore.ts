// File: create/space/spaceCurrentStore.ts
// Single source of truth for current-space selection and view mode.
// State: currentSpaceId, currentSpace, viewMode.
// Entity fallback lives in spaceCurrentSelectors.ts to avoid circular deps.

import { useSyncExternalStore } from "react";
import type { SpaceData } from "../../app/types";
import { normalizeSpaceId } from "./spaceKeys";
import type { SpaceViewMode } from "./types";

const VIEW_MODE_STORAGE_KEY = "nolo-space-view-mode";

const readStoredViewMode = (): SpaceViewMode => {
  try {
    if (typeof window === "undefined") return "all";
    return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "categories"
      ? "categories"
      : "all";
  } catch {
    return "all";
  }
};

const writeStoredViewMode = (mode: SpaceViewMode): void => {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage 不可用时静默忽略。
  }
};

export interface SpaceCurrentState {
  currentSpaceId: string | null;
  currentSpace: SpaceData | null;
  viewMode: SpaceViewMode;
}

const createInitialState = (): SpaceCurrentState => ({
  currentSpaceId: null,
  currentSpace: null,
  viewMode: readStoredViewMode(),
});

let state: SpaceCurrentState = createInitialState();
const listeners = new Set<() => void>();
let version = 0;

const notify = (): void => {
  version += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* Subscriber errors must not break mutators. */
    }
  }
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): number {
  return version;
}

/** The visible space is hidden while the sidebar is in all-spaces mode. */
export function getCurrentSpaceId(): string | null {
  return state.viewMode === "all" ? null : state.currentSpaceId;
}

/** The stored id, regardless of the current view mode. */
export function getCurrentSpaceIdRaw(): string | null {
  return state.currentSpaceId;
}

export function getCurrentSpaceRaw(): SpaceData | null {
  return state.currentSpace;
}

export function getViewMode(): SpaceViewMode {
  return state.viewMode;
}

export function setViewMode(mode: SpaceViewMode): void {
  if (state.viewMode === mode) return;
  state = { ...state, viewMode: mode };
  writeStoredViewMode(mode);
  notify();
}

export function setCurrentSpaceId(spaceId: string | null): void {
  state = { ...state, currentSpaceId: spaceId };
  notify();
}

export function setCurrentSpace(space: SpaceData | null): void {
  state = { ...state, currentSpace: space };
  notify();
}

export function setCurrentSpaceBoth(
  spaceId: string | null,
  space: SpaceData | null,
): void {
  state = { ...state, currentSpaceId: spaceId, currentSpace: space };
  notify();
}

export function updateCurrentSpaceIfMatch(
  spaceId: string,
  space: SpaceData,
): void {
  const currentId = state.currentSpaceId;
  if (currentId && normalizeSpaceId(currentId) === normalizeSpaceId(spaceId)) {
    state = { ...state, currentSpace: space };
    notify();
  }
}

export function resetSpaceCurrentState(): void {
  state = { currentSpaceId: null, currentSpace: null, viewMode: "all" };
  writeStoredViewMode("all");
  notify();
}

/** Append a dialog content entry produced by the space SSE channel. */
export function appendDialogContentEntry(
  dialogKey: string,
  title: string,
  timestamp: number,
): void {
  if (!state.currentSpace) return;
  state = {
    ...state,
    currentSpace: {
      ...state.currentSpace,
      contents: {
        ...(state.currentSpace.contents ?? {}),
        [dialogKey]: {
          title,
          type: "dialog" as any,
          contentKey: dialogKey,
          pinned: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
      updatedAt: timestamp,
    },
  };
  notify();
}

export function useCurrentSpaceId(): string | null {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getCurrentSpaceId();
}

/** Internal hook for useCurrentSpaceFromEntity in spaceCurrentSelectors. */
export function useStoreSnapshot(): void {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useViewMode(): SpaceViewMode {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return state.viewMode;
}