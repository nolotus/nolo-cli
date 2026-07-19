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
//
// 必须保持“委托 authSlice”，不要改成自己读 state 形状：
// 现有测试大量用 mock.module("auth/authSlice") 注入身份，这些 mock 的
// selectUserId 常带有本套件专用的形状回退（例如 state.auth.userId）。
// 一旦这里直接读 state.auth.currentUser.userId，就会绕过 mock，
// 表现为 thunk 里抛 “User is not logged in.”。
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
