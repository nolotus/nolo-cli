// 文件路径: auth/authSlice.ts

import {
  buildCreateSlice,
  asyncThunkCreator,
  PayloadAction, // 导入 PayloadAction 用于为 reducer 的 payload 提供类型
} from "@reduxjs/toolkit";
import type { AppThunkApi, RootState } from "../app/store";
import { selectRemoteServer } from "../app/settings/settingSlice";
import { fetchWithTransientReadRetry } from "../app/utils/retryFetch";
import { loadDefaultSpace, fetchUserSpaceMemberships } from "../create/space/spaceSlice";
import { generateUserIdV1 } from "../core/generateMainKey";
import { generateKeyPairFromSeedV1 } from "../core/generateKeyPairFromSeedV1";
import { hashPasswordV1 } from "../core/password";

import { signUpAction } from "./action/signUpAction";
import { loginRequest } from "./client/loginRequest";
import { resetAuthScopedClientState } from "./resetAuthScopedClientState";
import { buildPersistentAuthTokenPayload, parseToken, signToken } from "./token";
import { authRoutes } from "./routes";
import type { User } from "./types";

interface AuthState {
  currentUser: User | null;
  users: User[];
  isLoggedIn: boolean;
  currentToken: string | null;
  isLoading: boolean;
}

const getLoginErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = await response.clone().json();
    if (typeof payload?.error === "string" && payload.error.trim()) {
      return payload.error;
    }
    if (typeof payload?.message === "string" && payload.message.trim()) {
      return payload.message;
    }
  } catch {
    // Fall back to plain text below.
  }

  try {
    const text = (await response.text()).trim();
    if (text) return text;
  } catch {
    // Ignore text parsing errors and use the status fallback.
  }

  return `服务器响应状态码：${response.status}`;
};

const initialState: AuthState = {
  currentUser: null,
  users: [],
  isLoggedIn: false,
  currentToken: null,
  isLoading: false,
};

const isUser = (value: unknown): value is User =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { userId?: unknown }).userId === "string";

const parseUserToken = (token: string): User | null => {
  const parsed = parseToken(token);
  return isUser(parsed) ? parsed : null;
};

const parseStoredTokenEntries = (tokens: string[]) => {
  const seenUserIds = new Set<string>();
  return tokens.flatMap((token) => {
    const user = parseUserToken(token);
    if (user && seenUserIds.has(user.userId)) return [];
    if (user) seenUserIds.add(user.userId);
    return user ? [{ token, user }] : [];
  });
};

const compactUsers = (users: Array<User | null | undefined>) => users.filter(isUser);

const compactUniqueUsers = (users: Array<User | null | undefined>) => {
  const seenUserIds = new Set<string>();
  return compactUsers(users).filter((user) => {
    if (seenUserIds.has(user.userId)) return false;
    seenUserIds.add(user.userId);
    return true;
  });
};

function mergeUserState(existingUser: User | null | undefined, nextUser: User): User {
  if (!existingUser || existingUser.userId !== nextUser.userId) {
    return nextUser;
  }
  return {
    ...existingUser,
    ...nextUser,
  };
}

const createSliceWithThunks = buildCreateSlice({
  creators: { asyncThunk: asyncThunkCreator },
});

export const authSlice = createSliceWithThunks({
  name: "auth",
  initialState,
  reducers: (create) => ({
    signIn: create.asyncThunk(
      async (
        input: {
          username: string;
          locale: string;
          localeCandidates?: string[];
          password: string;
        },
        thunkAPI
      ) => {
        const { tokenManager } = thunkAPI.extra;
        const state: RootState = thunkAPI.getState();
        const startTime = Date.now();
        console.log('[Auth] signIn thunk started');

        try {
          const { username, locale, localeCandidates: rawLocaleCandidates, password } = input;

          const hashStart = Date.now();
          const encryptionKey = await hashPasswordV1(password);
          console.log(`[Auth] hashPasswordV1 took ${Date.now() - hashStart}ms`);

          const nowSec = Math.floor(Date.now() / 1000);
          const currentServer = selectRemoteServer(state);
          const localeCandidates = Array.from(
            new Set(
              (Array.isArray(rawLocaleCandidates) && rawLocaleCandidates.length > 0
                ? rawLocaleCandidates
                : [locale]
              )
                .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
                .map((value) => value.trim())
            )
          );

          let matchedPublicKey: string | null = null;
          let matchedSecretKey: string | null = null;
          let matchedUserId: string | null = null;
          let res: Response | null = null;
          let preferredErrorMessage: string | null = null;
          let notFoundErrorMessage: string | null = null;

          for (const loginLocale of localeCandidates) {
            const keyGenStart = Date.now();
            const { publicKey, secretKey } = generateKeyPairFromSeedV1(
              username + encryptionKey + loginLocale
            );
            console.log(
              `[Auth] generateKeyPairFromSeedV1 took ${Date.now() - keyGenStart}ms for locale ${loginLocale}`
            );

            const userId = generateUserIdV1(publicKey, username, loginLocale);
            const loginToken = signToken(
              buildPersistentAuthTokenPayload({ userId, publicKey, username }, nowSec),
              secretKey
            );

            console.log(`[Auth] Sending loginRequest to: ${currentServer} (locale=${loginLocale})`);
            const networkStart = Date.now();
            const attemptResponse = await loginRequest(currentServer, { userId, token: loginToken });
            console.log(
              `[Auth] loginRequest took ${Date.now() - networkStart}ms, status: ${attemptResponse.status}, locale=${loginLocale}`
            );

            if (attemptResponse.status === 200) {
              matchedPublicKey = publicKey;
              matchedSecretKey = secretKey;
              matchedUserId = userId;
              res = attemptResponse;
              break;
            }

            const errorMessage = await getLoginErrorMessage(attemptResponse);
            if (attemptResponse.status === 404) {
              notFoundErrorMessage = errorMessage;
              continue;
            }
            preferredErrorMessage = errorMessage;
          }

          if (!res || !matchedPublicKey || !matchedSecretKey || !matchedUserId) {
            return thunkAPI.rejectWithValue(
              preferredErrorMessage || notFoundErrorMessage || "登录失败，请检查账号信息后重试。"
            );
          }

          const result = await res.json();
          const tokenVersion =
            typeof result?.tokenVersion === "number" && Number.isFinite(result.tokenVersion)
              ? Math.max(0, Math.floor(result.tokenVersion))
              : 0;
          const token = signToken(
            buildPersistentAuthTokenPayload(
              { userId: matchedUserId, publicKey: matchedPublicKey, username, tokenVersion },
              Math.floor(Date.now() / 1000)
            ),
            matchedSecretKey
          );
          const storageStart = Date.now();
          await resetAuthScopedClientState(thunkAPI.dispatch);
          await tokenManager!.storeToken(token);
          const parsedUser = parseUserToken(token);
          if (!parsedUser) {
            return thunkAPI.rejectWithValue("登录状态解析失败，请重试。");
          }
          console.log(`[Auth] token storage took ${Date.now() - storageStart}ms`);

          console.log(`[Auth] Total signIn thunk took ${Date.now() - startTime}ms`);
          return { token };
        } catch (error) {
          console.error('[Auth] signIn thunk error:', error);
          return thunkAPI.rejectWithValue(
            error instanceof Error ? error.message : String(error)
          );
        }
      },
      {
        pending: (state) => {
          state.isLoading = true;
        },
        rejected: (state) => {
          state.isLoading = false;
        },
        fulfilled: (state, action) => {
          const { token } = action.payload;
          const user = parseUserToken(token);
          if (!user) {
            state.isLoading = false;
            return;
          }
          const existingUsers = compactUniqueUsers(state.users);
          state.currentUser = mergeUserState(state.currentUser, user);
          state.currentToken = token;
          state.isLoggedIn = true;
          state.users = [user, ...existingUsers.filter((item) => item.userId !== user.userId)];
          state.isLoading = false;
        },
      }
    ),

    signUp: create.asyncThunk(signUpAction, {
      /* ... signUp implementation ... */
      fulfilled: (state, action) => {
        const { user, token } = action.payload;
        state.currentUser = user;
        state.isLoggedIn = true;
        state.users.unshift(user);
        state.currentToken = token;
      },
    }),

    inviteSignUp: create.asyncThunk(() => {
      console.log("inviteSignUp - 该功能暂未实现");
    }, {}),

    initializeAuth: create.asyncThunk(
      /* ... initializeAuth implementation ... */
      async (_, thunkAPI) => {
        const { tokenManager } = thunkAPI.extra;
        const tokens = await tokenManager!.initTokens();
        const tokenEntries = parseStoredTokenEntries(tokens ?? []);

        if (tokenEntries.length !== (tokens?.length ?? 0)) {
          const invalidTokens = (tokens ?? []).filter(
            (token) => !tokenEntries.some((entry) => entry.token === token)
          );
          for (const invalidToken of invalidTokens) {
            await tokenManager!.removeToken(invalidToken);
          }
        }

        if (tokenEntries.length > 0) {
          return {
            tokens: tokenEntries.map((entry) => entry.token),
            user: tokenEntries[0]?.user ?? null,
          };
        }
        return { tokens: [], user: null };
      },
      {
        fulfilled: (state, action) => {
          const { tokens, user } = action.payload;
          if (user) {
            state.currentUser = user;
            state.isLoggedIn = true;
          }
          if (tokens && tokens.length > 0) {
            state.currentToken = tokens[0];
            state.users = parseStoredTokenEntries(tokens).map((entry) => entry.user);
          }
        },
      }
    ),

    signOut: create.asyncThunk(
      /* ... signOut implementation ... */
      async (_, thunkAPI) => {
        const { tokenManager } = thunkAPI.extra;
        const state: RootState = thunkAPI.getState();
        const token = selectCurrentToken(state);
        await resetAuthScopedClientState(thunkAPI.dispatch);
        if (token) {
          await tokenManager!.removeToken(token);
        }
        const remainingTokens = await tokenManager!.getTokens();
        return { tokens: remainingTokens };
      },
      {
        fulfilled: (state, action) => {
          const { tokens } = action.payload;
          const otherUsers = compactUniqueUsers(state.users).filter(
            (user) => user.userId !== state.currentUser?.userId
          );

          if (otherUsers.length > 0) {
            const nextUser = otherUsers[0];
            const nextToken =
              tokens.find((t) => parseUserToken(t)?.userId === nextUser.userId) ||
              null;
            state.currentUser = nextUser;
            state.users = otherUsers;
            state.currentToken = nextToken;
          } else {
            state.isLoggedIn = false;
            state.currentUser = null;
            state.users = [];
            state.currentToken = null;
          }
        },
      }
    ),

    replaceCurrentToken: create.asyncThunk(
      async (input: { token: string }, thunkAPI) => {
        const { tokenManager } = thunkAPI.extra;
        const state: RootState = thunkAPI.getState();
        const currentToken = selectCurrentToken(state);
        if (currentToken) {
          await tokenManager!.removeToken(currentToken);
        }
        await tokenManager!.storeToken(input.token);
        return { token: input.token };
      },
      {
        fulfilled: (state, action) => {
          const nextUser = parseUserToken(action.payload.token);
          if (!nextUser) {
            return;
          }
          const existingUsers = compactUniqueUsers(state.users);
          state.currentToken = action.payload.token;
          state.currentUser = mergeUserState(state.currentUser, nextUser);
          state.users = [
            mergeUserState(
              existingUsers.find((item) => item.userId === nextUser.userId),
              nextUser
            ),
            ...existingUsers.filter((item) => item.userId !== nextUser.userId),
          ];
          state.isLoggedIn = true;
        },
      }
    ),

    changeUser: create.asyncThunk(
      /* ... changeUser implementation ... */
      async (user: User, thunkAPI) => {
        const { tokenManager } = thunkAPI.extra;
        const { dispatch } = thunkAPI;
        try {
          await resetAuthScopedClientState(dispatch);
          // 获取新用户的 space 成员资格（loadDefaultSpace 依赖 memberSpaces 已加载）
          await dispatch(fetchUserSpaceMemberships(user.userId)).unwrap();
          await dispatch(loadDefaultSpace(user.userId)).unwrap();
        } catch (error) {
          console.warn("Failed to initialize user settings:", error);
        }

        const tokens = await tokenManager!.getTokens();
        const updatedToken = tokens.find(
          (t) => parseUserToken(t)?.userId === user.userId
        );

        if (!updatedToken) {
          return thunkAPI.rejectWithValue("Token not found for user");
        }

        await tokenManager!.removeToken(updatedToken);
        await tokenManager!.storeToken(updatedToken);

        return { user, token: updatedToken };
      },
      {
        fulfilled: (state, action) => {
          const { user, token } = action.payload;
          state.currentUser = user;
          state.currentToken = token;
        },
      }
    ),

    fetchUserProfile: create.asyncThunk(
      /* ... fetchUserProfile implementation ... */
      async (_, thunkAPI) => {
        const state: RootState = thunkAPI.getState();
        const serverUrl = selectRemoteServer(state);
        const token = selectCurrentToken(state);
        const currentUser = selectCurrentUser(state);

        console.log('[Auth] fetchUserProfile thunk started. User:', currentUser?.userId);

        if (!serverUrl || !token || !currentUser?.userId) {
          return thunkAPI.rejectWithValue(
            "无法获取用户信息：缺少必要参数（服务器地址、Token或用户ID）"
          );
        }

        const { userId } = currentUser;
        const path = authRoutes.users.detail.createPath({ userId });
        const url = `${serverUrl}${path}`;

        try {
          const response = await fetchWithTransientReadRetry(url, {
            method: authRoutes.users.detail.method,
            headers: {
              Authorization: `Bearer ${token}`,
            },
          });

          if (!response.ok) {
            const errorText = await response.text();
            return thunkAPI.rejectWithValue(
              `请求失败: ${response.status} ${errorText}`
            );
          }

          const profileData: {
            balance: number;
            gptProAccess?: User["gptProAccess"];
            adminPermissions?: User["adminPermissions"];
          } =
            await response.json();
          return {
            userId,
            balance: profileData.balance,
            gptProAccess: profileData.gptProAccess,
            adminPermissions: profileData.adminPermissions,
          };
        } catch (error: any) {
          return thunkAPI.rejectWithValue(
            error.message || "获取用户信息时发生未知错误"
          );
        }
      },
      {
        rejected: (state, action) => {
          console.error("获取用户 Profile 失败:", action.payload);
        },
        fulfilled: (state, action) => {
          const { userId, balance, gptProAccess, adminPermissions } = action.payload;
          if (state.currentUser && state.currentUser.userId === userId) {
            state.currentUser.balance = balance;
            state.currentUser.gptProAccess = gptProAccess;
            state.currentUser.adminPermissions = adminPermissions;
          }
          const userIndex = state.users.findIndex(
            (user) => user.userId === userId
          );
          if (userIndex !== -1) {
            state.users[userIndex].balance = balance;
            state.users[userIndex].gptProAccess = gptProAccess;
            state.users[userIndex].adminPermissions = adminPermissions;
          }
        },
      }
    ),

    // 前端临时扣款: 接收一个 cost 数值，从当前用户的余额中扣除。
    // 这可以让 UI 实时显示余额变化，而无需等待下一次从服务器完整刷新。
    deductBalance: create.reducer((state, action: PayloadAction<number>) => {
      const cost = action.payload;
      // 更新当前登录用户的余额
      if (state.currentUser && typeof state.currentUser.balance === "number") {
        state.currentUser.balance -= cost;
      }

      // 同时更新 users 数组中的该用户，保持数据一致性
      if (state.currentUser) {
        const userInArray = state.users.find(
          (u) => u.userId === state.currentUser!.userId
        );
        if (userInArray && typeof userInArray.balance === "number") {
          userInArray.balance -= cost;
        }
      }
    }),
  }),
});

export const {
  signIn,
  signUp,
  inviteSignUp,
  signOut,
  replaceCurrentToken,
  changeUser,
  initializeAuth,
  fetchUserProfile,
  deductBalance, // 导出新的 action
} = authSlice.actions;

export default authSlice.reducer;

export const selectCurrentUser = (state: RootState) => state.auth.currentUser;
export const selectUsers = (state: RootState) => state.auth.users;
export const selectUserId = (state: RootState) =>
  state.auth.currentUser?.userId;
export const selectIsLoggedIn = (state: RootState) => state.auth.isLoggedIn;
export const selectCurrentToken = (state: RootState) => state.auth.currentToken;
export const selectCurrentUserBalance = (state: RootState) =>
  state.auth.currentUser?.balance;
