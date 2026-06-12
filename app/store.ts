// 文件路径: app/store.ts

import { configureStore } from "@reduxjs/toolkit";
import { TypedUseSelectorHook, useDispatch, useSelector } from "react-redux";
import { reducer } from "./reducer";
import type { TokenManager } from "../auth/types";
import type { Level } from "level";

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
export type RootState = ReturnType<AppStore["getState"]>;
export type AppDispatch = AppStore["dispatch"];

export type AppThunkApi = {
  dispatch: AppDispatch;
  getState: () => RootState;
  extra: {
    db: Level<string, any> | null;
    tokenManager: TokenManager | null;
  };
};

export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
export const useAppDispatch: () => AppDispatch = useDispatch;

declare global {
  interface Window {
    __PRELOADED_STATE__?: RootState;
    __NOLO_DESKTOP__?: boolean;
  }
}
