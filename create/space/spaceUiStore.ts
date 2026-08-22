// File: create/space/spaceUiStore.ts
// Module store for space UI state: favoritesCollapsed + collapsedCategories.
// View mode and current-space selection live in spaceCurrentStore.ts.
//
// Pattern: version counter + useSyncExternalStore for React consumers;
// mutator/getter functions for non-React callers (thunks, tools);
// localStorage persistence for favoritesCollapsed;
// per-space collapsedCategories (delegated to spaceCollapsedState.ts).

import { useSyncExternalStore } from "react";

import { UNCATEGORIZED_ID } from "./constants";
import {
  readStoredCollapsedCategories,
  writeStoredCollapsedCategories,
} from "./spaceCollapsedState";

/**
 * 折叠态隐式默认:当 collapsedCategories map 里没有某个 categoryId 时,
 * 用这份常量作为回退。UNCATEGORIZED 系统桶默认展开,普通分类默认折叠。
 * 任何"创建新分类"的 reducer 必须显式把 [newCategoryId]: false 写入 map,
 * 此常量只用于"未登记"场景的回退(用户从未 toggle 过的 id)。
 */
export const DEFAULT_COLLAPSED_CATEGORIES: Record<string, boolean> = {
  [UNCATEGORIZED_ID]: false,
};

const FAVORITES_COLLAPSED_STORAGE_KEY = "nolo-sidebar-favorites-collapsed";

const readStoredFavoritesCollapsed = (): boolean => {
  try {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(FAVORITES_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

const writeStoredFavoritesCollapsed = (collapsed: boolean): void => {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      FAVORITES_COLLAPSED_STORAGE_KEY,
      collapsed ? "1" : "0",
    );
  } catch {
    // localStorage 不可用时静默忽略
  }
};

export interface SpaceUiState {
  favoritesCollapsed: boolean;
  collapsedCategories: Record<string, boolean>;
  /** 当前 collapsedCategories 所属的 spaceId,用于判断是否需要重新加载。 */
  collapsedCategoriesSpaceId: string | null;
}

const createInitialState = (): SpaceUiState => ({
  favoritesCollapsed: readStoredFavoritesCollapsed(),
  collapsedCategories: {},
  collapsedCategoriesSpaceId: null,
});

let state: SpaceUiState = createInitialState();
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

// ===== subscribe / getSnapshot (for useSyncExternalStore) =====

// Internal-only — not exported to avoid Knip unused-export warnings.

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): number {
  return version;
}

// ===== getters (non-React callers) =====

export function getFavoritesCollapsed(): boolean {
  return state.favoritesCollapsed;
}

export function getCollapsedCategories(): Readonly<Record<string, boolean>> {
  return state.collapsedCategories;
}

export function getIsCategoryCollapsed(categoryId: string): boolean {
  return (
    state.collapsedCategories[categoryId] ??
    (DEFAULT_COLLAPSED_CATEGORIES[categoryId] ?? true)
  );
}

// ===== mutators =====

export function toggleFavoritesCollapse(): void {
  state = { ...state, favoritesCollapsed: !state.favoritesCollapsed };
  writeStoredFavoritesCollapsed(state.favoritesCollapsed);
  notify();
}

export function setCollapsedCategories(
  categories: Record<string, boolean>,
  spaceId: string | null,
): void {
  state = {
    ...state,
    collapsedCategories: categories,
    collapsedCategoriesSpaceId: spaceId,
  };
  notify();
}

export function toggleCategoryCollapse(categoryId: string): void {
  const current = state.collapsedCategories[categoryId] ??
    (DEFAULT_COLLAPSED_CATEGORIES[categoryId] ?? true);
  state = {
    ...state,
    collapsedCategories: {
      ...state.collapsedCategories,
      [categoryId]: !current,
    },
  };
  notify();
}

/**
 * 在已有 collapsedCategories 上合并展开某个分类(新增内容时自动展开)。
 * 供 contentThunks 等 thunk 在 fulfilled 后调用,替代原来直接改 Redux state。
 */
export function expandCategoryInCollapsed(
  categoryId: string,
  spaceId: string,
): void {
  if (!categoryId || categoryId === UNCATEGORIZED_ID) return;
  state = {
    ...state,
    collapsedCategories: {
      ...state.collapsedCategories,
      [categoryId]: false,
    },
  };
  if (typeof window !== "undefined") {
    writeStoredCollapsedCategories(
      spaceId,
      state.collapsedCategories,
      window.localStorage,
    );
  }
  notify();
}

/**
 * 重置 space UI 状态(切换用户时调用)。
 * 重置为纯默认值，不从 localStorage 读——避免与 module store 分叉。
 * 同时清 localStorage 的 favoritesCollapsed。
 */
export function resetSpaceUiState(): void {
  state = {
    favoritesCollapsed: false,
    collapsedCategories: {},
    collapsedCategoriesSpaceId: null,
  };
  writeStoredFavoritesCollapsed(false);
  notify();
}

// ===== React hooks =====

export function useFavoritesCollapsed(): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return state.favoritesCollapsed;
}

export function useCollapsedCategories(): Record<string, boolean> {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return state.collapsedCategories;
}

export function useIsCategoryCollapsed(categoryId: string): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getIsCategoryCollapsed(categoryId);
}