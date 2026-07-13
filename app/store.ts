import { configureStore, type ThunkDispatch, type UnknownAction } from "@reduxjs/toolkit";
import { TypedUseSelectorHook, useDispatch, useSelector } from "react-redux";
import { reducer } from "./reducer";
import type { TokenManager } from "../auth/types";
import type { Level } from "level";

// RootState: explicit interface — NOT derived from AppStore or reducer map.
// This avoids TS2456/TS2502 circular alias errors caused by cross-slice
// module imports when resolving the reducer map at type-evaluation time.
export interface RootState {
  auth: any;
  dialog: any;
  plan: any;
  workflow: any;
  message: any;
  doc: any;
  db: any;
  settings: any;
  space: any;
  notifications: any;
  cybot: any;
  table: any;
  toolRun: any;
  favorite: any;
  share: any;
  appInspector: any;
}

export type AppExtra = {
  db: Level<string, any> | null;
  tokenManager: TokenManager | null;
};

// AppDispatch: loose on purpose for full-repo typecheck.
// buildCreateSlice / create.asyncThunk 导出常被推断成 `void | AsyncThunk` 联合；
// 严格 ThunkDispatch 会在 call site 炸掉。返回值用 `any`（不是 unknown）以保留
// 既有 `.unwrap()` 后属性访问（green gate 依赖这一点）。
type DispatchResult = Promise<any> & {
  unwrap: () => Promise<any>;
  then: Promise<any>["then"];
  catch: Promise<any>["catch"];
  finally: Promise<any>["finally"];
};

export type AppDispatch = ((action: any) => DispatchResult) &
  ThunkDispatch<RootState, AppExtra, UnknownAction>;

// 已知调用的是 thunk 时，可指定 unwrap 的结果类型。
export type TypedThunkDispatch = <T = any>(
  action: any
) => Promise<T> & { unwrap: () => Promise<T> };

/** Strip void|union from buildCreateSlice async thunk action creators. */
export function asThunkActionCreator<A extends any[], R = any>(
  creator: ((...args: A) => R) | void | object | unknown
): (...args: A) => R {
  return creator as (...args: A) => R;
}

/** Dispatch a (possibly void-union) thunk/action and keep unwrap(). */
export function dispatchThunk<T = any>(
  dispatch: AppDispatch | ((action: any) => any),
  action: any
): Promise<T> & { unwrap: () => Promise<T> } {
  return (dispatch as (a: any) => Promise<T> & { unwrap: () => Promise<T> })(
    action
  );
}

export type AppThunkApi = {
  dispatch: AppDispatch;
  getState: () => RootState;
  extra: AppExtra;
};

interface CreateStoreOptions {
  dbInstance?: Level<string, any>;
  tokenManager?: TokenManager;
  preloadedState?: Partial<RootState>;
}

export const createAppStore = (options: CreateStoreOptions = {}): any => {
  const { dbInstance, tokenManager, preloadedState } = options;

  // Bind durable explicit-sync mapping persistence to the same client DB.
  // Dynamic import avoids static cycles; best-effort when DB is present.
  if (dbInstance) {
    void import("../database/sync/syncMapping")
      .then(({ bindSyncMappingClientDb }) => {
        bindSyncMappingClientDb(dbInstance);
      })
      .catch(() => {
        /* mapping store optional during SSR / partial bundles */
      });
  }

  return configureStore({
    reducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: false,
        thunk: {
          extraArgument: {
            db: dbInstance || null,
            tokenManager: tokenManager || null,
          },
        },
      }),
    preloadedState,
  });
};

export type AppStore = any;
// RootState IS defined directly above — no AppStore dependency.

export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
export const useAppDispatch = () => useDispatch<AppDispatch>();

declare global {
  interface Window {
    __PRELOADED_STATE__?: RootState;
    __NOLO_DESKTOP__?: boolean;
    __appInitPerf?: {
      start(label: string): void;
      end(label: string): void;
    };
    __sidebarPerfTiming?: {
      measure: (label: string) => void;
      marks: Record<string, number>;
    };
  }
}
