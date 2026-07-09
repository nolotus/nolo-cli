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
}

export type AppExtra = {
  db: Level<string, any> | null;
  tokenManager: TokenManager | null;
};

// AppDispatch from the real store type (avoids ThunkDispatch<RootState,...>
// incompatibility with RTK's inferred dispatch types).
export type AppDispatch = ThunkDispatch<RootState, AppExtra, UnknownAction>;

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

export const createAppStore = (options: CreateStoreOptions = {}) => {
  const { dbInstance, tokenManager, preloadedState } = options;

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

export type AppStore = ReturnType<typeof createAppStore>;
// RootState IS defined directly above — no AppStore dependency.

export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
export const useAppDispatch: () => AppDispatch = useDispatch;

declare global {
  interface Window {
    __PRELOADED_STATE__?: RootState;
    __NOLO_DESKTOP__?: boolean;
  }
}
