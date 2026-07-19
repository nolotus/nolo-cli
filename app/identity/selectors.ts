import {
  selectCurrentToken,
  selectCurrentUser,
  selectIsLoggedIn,
  selectUserId,
} from "../../auth/authSlice";
import type { User } from "../../auth/types";

type IdentityState = { auth: any };

// Identity 读取面的 selector 版本，供 thunk / getState 使用（非 React）。
// 与 hook 版（useIdentity）共用同一 edition 注入点：当前委托 authSlice，
// 开源本地版只改本文件即可。见 docs/agent-guidance/open-source-decoupling.md。
export const selectIdentityUserId = (
  state: IdentityState
): string | undefined => selectUserId(state);

export const selectIdentityToken = (
  state: IdentityState
): string | null | undefined => selectCurrentToken(state);

export const selectIdentityIsLoggedIn = (state: IdentityState): boolean =>
  selectIsLoggedIn(state);

export const selectIdentityUser = (state: IdentityState): User | null =>
  selectCurrentUser(state);
