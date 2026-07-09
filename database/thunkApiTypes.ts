// 文件路径: database/thunkApiTypes.ts
//
// Relaxed thunk-API type for database/share async actions.
//
// `AppThunkApi` (from app/store) declares `getState: () => RootState`,
// `dispatch: AppDispatch`, and `extra: AppExtra`. RTK's `create.asyncThunk` /
// `buildCreateSlice` infers the payload creator's thunkAPI as
// `GetThunkAPI<AsyncThunkConfig>`, whose `getState` returns `unknown`,
// `dispatch` is the generic `ThunkDispatch<unknown, unknown, UnknownAction>`,
// and `extra` is `unknown`. RTK intentionally forbids typing `state`/`dispatch`
// on the ThunkApiConfig (see `PreventCircular`, which maps those keys to
// `never`), and specializing `extra` to `AppExtra` would force every caller's
// dispatch to carry `extra: AppExtra` too — breaking callers (e.g. the ai
// slice) whose store dispatch has `extra: unknown`.
//
// `DbThunkApi` therefore mirrors RTK's default inferred thunkAPI exactly
// (`state: unknown`, `dispatch: ThunkDispatch<unknown, unknown, UnknownAction>`,
// `extra: unknown`) so the inferred thunkAPI is assignable AND callers with the
// default `extra: unknown` dispatch can still dispatch these thunks. Actions
// that need a typed `extra`/`state` cast at the (few) call sites that use them.
// Runtime is unchanged: the real store still injects the same `AppThunkApi`-
// shaped object.

import type { ThunkDispatch, UnknownAction } from "@reduxjs/toolkit";
import type { AppExtra, RootState } from "../app/store";

export type DbThunkApi = {
  dispatch: ThunkDispatch<unknown, unknown, UnknownAction>;
  getState: () => unknown;
  extra: unknown;
};

// Cast helpers for the call sites that need typed state/extra. Centralizes the
// casts instead of repeating `as RootState` / `as AppExtra` across files.
export const dbThunkState = (thunkApi: DbThunkApi): RootState =>
  thunkApi.getState() as RootState;

export const dbThunkExtra = (thunkApi: DbThunkApi): AppExtra =>
  thunkApi.extra as AppExtra;