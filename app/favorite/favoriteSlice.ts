// 文件路径: app/favorite/favoriteSlice.ts

import {
    buildCreateSlice,
    asyncThunkCreator,
    type PayloadAction,
} from "@reduxjs/toolkit";
import { selectIdentityToken } from "../identity/selectors";
import {
    selectRemoteServers,
} from "../settings/settingSlice";
import type {
    FavoriteTargetType,
    FavoriteListItem,
    ListFavoritesResult,
    SetFavoriteResult,
} from "./type";

interface FavoriteState {
    // 当前用户收藏的 agent 列表（用 agentKey：item.dbKey || item.id）
    agentIds: string[];
    // 当前用户收藏的内容列表（存 page/meta/image key）
    contentIds: string[];
    // 记录收藏时间（毫秒时间戳），用于跨类型排序
    favoritedAtById: Record<string, number>;

    initialized: boolean; // 是否已从服务器加载过（成功或失败都算）
    loading: boolean;
    error: string | null;
}

const initialState: FavoriteState = {
    agentIds: [],
    contentIds: [],
    favoritedAtById: {},
    initialized: false,
    loading: false,
    error: null,
};

const createSliceWithThunks = buildCreateSlice({
    creators: { asyncThunk: asyncThunkCreator },
});

type FavoriteRpcMethod = "listFavorites" | "toggleFavorite" | "setFavorite";

interface FavoriteServerSnapshot {
    server: string;
    agentFavorites: ListFavoritesResult;
    contentFavorites: ListFavoritesResult;
}

interface FavoriteSyncOperation {
    server: string;
    targetType: FavoriteTargetType;
    targetKey: string;
    favoritedAt: number;
}

/** 通用 RPC 调用封装 */
async function rpcCall<T>(
    method: FavoriteRpcMethod,
    params: unknown,
    token: string,
    server: string
): Promise<T> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
    };

    const res = await fetch(`${server}/rpc/${method}`, {
        method: "POST",
        headers,
        body: JSON.stringify(params ?? {}),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${method} failed: ${res.status} ${text}`);
    }

    return (await res.json()) as T;
}

function getFavoriteServers(state: any): string[] {
    return selectRemoteServers(state);
}

function buildFavoritedMap(result: ListFavoritesResult): Record<string, number> {
    const map: Record<string, number> = {};

    if (Array.isArray(result.items) && result.items.length > 0) {
        result.items.forEach((item: FavoriteListItem) => {
            if (item?.id) {
                map[item.id] = Number(item.favoritedAt) || 0;
            }
        });
        return map;
    }

    if (Array.isArray(result.ids) && result.ids.length > 0) {
        const base = Date.now();
        result.ids.forEach((id, index) => {
            map[id] = base - index;
        });
    }

    return map;
}

function mergeFavoritedMaps(
    results: ListFavoritesResult[]
): Record<string, number> {
    const merged: Record<string, number> = {};

    results.forEach((result) => {
        const map = buildFavoritedMap(result);
        Object.entries(map).forEach(([id, favoritedAt]) => {
            if (!merged[id] || favoritedAt > merged[id]) {
                merged[id] = favoritedAt;
            }
        });
    });

    return merged;
}

function sortFavoriteIds(
    favoritedAtById: Record<string, number>
): string[] {
    return Object.entries(favoritedAtById)
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id);
}

async function loadFavoritesFromServer(
    server: string,
    token: string
): Promise<FavoriteServerSnapshot> {
    try {
        const batchResult = await rpcCall<ListFavoritesResult[]>(
            "listFavorites",
            { targetType: ["agent", "content"] },
            token,
            server
        );

        if (Array.isArray(batchResult)) {
            const agentFavorites =
                batchResult.find((result) => result?.targetType === "agent") ??
                createEmptyListResult("agent");
            const contentFavorites =
                batchResult.find((result) => result?.targetType === "content") ??
                createEmptyListResult("content");

            return {
                server,
                agentFavorites,
                contentFavorites,
            };
        }
    } catch (error) {
        // 远端旧版本还不支持 batched targetType[]，继续走 legacy 双请求。
    }

    const [agentFavoritesResult, contentFavoritesResult] =
        await Promise.allSettled([
            rpcCall<ListFavoritesResult>(
                "listFavorites",
                { targetType: "agent" },
                token,
                server
            ),
            listContentFavoritesWithFallback(token, server),
        ]);

    if (
        agentFavoritesResult.status === "rejected" &&
        contentFavoritesResult.status === "rejected"
    ) {
        throw agentFavoritesResult.reason || contentFavoritesResult.reason;
    }

    return {
        server,
        agentFavorites:
            agentFavoritesResult.status === "fulfilled"
                ? agentFavoritesResult.value
                : createEmptyListResult("agent"),
        contentFavorites:
            contentFavoritesResult.status === "fulfilled"
                ? contentFavoritesResult.value
                : createEmptyListResult("content"),
    };
}

function collectMissingFavoriteSyncOps(
    snapshots: FavoriteServerSnapshot[],
    agentFavoritedAtById: Record<string, number>,
    contentFavoritedAtById: Record<string, number>
): FavoriteSyncOperation[] {
    const operations: FavoriteSyncOperation[] = [];

    snapshots.forEach((snapshot) => {
        const agentSet = new Set(snapshot.agentFavorites.ids ?? []);
        const contentSet = new Set(snapshot.contentFavorites.ids ?? []);

        Object.entries(agentFavoritedAtById).forEach(([agentId, favoritedAt]) => {
            if (!agentSet.has(agentId)) {
                operations.push({
                    server: snapshot.server,
                    targetType: "agent",
                    targetKey: agentId,
                    favoritedAt,
                });
            }
        });

        Object.entries(contentFavoritedAtById).forEach(
            ([contentId, favoritedAt]) => {
                if (!contentSet.has(contentId)) {
                    operations.push({
                        server: snapshot.server,
                        targetType: "content",
                        targetKey: contentId,
                        favoritedAt,
                    });
                }
            }
        );
    });

    return operations;
}

/**
 * 兼容旧服务端：内容收藏优先走 content，失败时回退到 doc/page。
 * 这样前后端版本不一致时也不会导致整个收藏列表加载失败。
 */
async function listContentFavoritesWithFallback(
    token: string,
    server: string
): Promise<ListFavoritesResult> {
    const targetTypes: FavoriteTargetType[] = ["content", "doc", "page"];
    let lastError: unknown = null;

    for (const targetType of targetTypes) {
        try {
            return await rpcCall<ListFavoritesResult>(
                "listFavorites",
                { targetType },
                token,
                server
            );
        } catch (error) {
            lastError = error;
        }
    }

    if (lastError instanceof Error) throw lastError;
    throw new Error("listFavorites failed for content/doc/page");
}

async function setFavoriteOnServer(
    targetType: FavoriteTargetType,
    targetKey: string,
    isFavorite: boolean,
    token: string,
    server: string,
    favoritedAt?: number
): Promise<SetFavoriteResult> {
    return rpcCall<SetFavoriteResult>(
        "setFavorite",
        {
            targetType,
            targetKey,
            isFavorite,
            favoritedAt,
        },
        token,
        server
    );
}

async function setContentFavoriteOnServerWithFallback(
    contentKey: string,
    isFavorite: boolean,
    token: string,
    server: string,
    favoritedAt?: number
): Promise<SetFavoriteResult> {
    const targetTypes: FavoriteTargetType[] = ["content", "doc", "page"];
    let lastError: unknown = null;

    for (const targetType of targetTypes) {
        try {
            return await setFavoriteOnServer(
                targetType,
                contentKey,
                isFavorite,
                token,
                server,
                favoritedAt
            );
        } catch (error) {
            lastError = error;
        }
    }

    if (lastError instanceof Error) throw lastError;
    throw new Error("setFavorite failed for content/doc/page");
}

async function setFavoriteAcrossServers(
    targetType: FavoriteTargetType,
    targetKey: string,
    isFavorite: boolean,
    token: string,
    servers: string[],
    favoritedAt?: number
): Promise<void> {
    if (servers.length === 0) {
        throw new Error("没有可用服务器，无法同步收藏");
    }

    const syncOperation =
        targetType === "agent"
            ? (server: string) =>
                setFavoriteOnServer(
                    targetType,
                    targetKey,
                    isFavorite,
                    token,
                    server,
                    favoritedAt
                )
            : (server: string) =>
                setContentFavoriteOnServerWithFallback(
                    targetKey,
                    isFavorite,
                    token,
                    server,
                    favoritedAt
                );

    const results = await Promise.allSettled(
        servers.map((server) => syncOperation(server))
    );
    const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected"
    );

    if (failures.length === results.length) {
        throw (
            failures[0]?.reason ??
            new Error("所有服务器的收藏同步都失败了")
        );
    }

    if (failures.length > 0) {
        console.warn(
            "[Favorites] Partial favorite sync failure:",
            failures.map((failure) => failure.reason)
        );
    }
}

async function reconcileFavoriteUnion(
    operations: FavoriteSyncOperation[],
    token: string
): Promise<void> {
    if (operations.length === 0) return;

    const results = await Promise.allSettled(
        operations.map((operation) =>
            operation.targetType === "agent"
                ? setFavoriteOnServer(
                    operation.targetType,
                    operation.targetKey,
                    true,
                    token,
                    operation.server,
                    operation.favoritedAt
                )
                : setContentFavoriteOnServerWithFallback(
                    operation.targetKey,
                    true,
                    token,
                    operation.server,
                    operation.favoritedAt
                )
        )
    );
    const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected"
    );

    if (failures.length > 0) {
        console.warn(
            "[Favorites] Failed to backfill merged favorites:",
            failures.map((failure) => failure.reason)
        );
    }
}

function createEmptyListResult(
    targetType: FavoriteTargetType
): ListFavoritesResult {
    return { targetType, ids: [], items: [] };
}

export const favoriteSlice = createSliceWithThunks({
    name: "favorite",
    initialState,
    reducers: (create) => ({
        /** 首次加载当前用户收藏的所有 agents/content，并做多站点合并去重 */
        initFavorites: create.asyncThunk(
            async (_: void, thunkAPI) => {
                const state = thunkAPI.getState() as any;
                const token = selectIdentityToken(state);
                const servers = getFavoriteServers(state);

                if (!token) {
                    throw new Error("未登录，无法加载收藏列表");
                }

                const snapshotResults = await Promise.allSettled(
                    servers.map((server) => loadFavoritesFromServer(server, token))
                );
                const snapshots = snapshotResults
                    .filter(
                        (result): result is PromiseFulfilledResult<FavoriteServerSnapshot> =>
                            result.status === "fulfilled"
                    )
                    .map((result) => result.value);
                const failures = snapshotResults.filter(
                    (result): result is PromiseRejectedResult =>
                        result.status === "rejected"
                );

                if (snapshots.length === 0) {
                    throw (
                        failures[0]?.reason ??
                        new Error("所有服务器的收藏加载都失败了")
                    );
                }

                if (failures.length > 0) {
                    console.warn(
                        "[Favorites] Partial favorite load failure:",
                        failures.map((failure) => failure.reason)
                    );
                }

                const agentFavoritedAtById = mergeFavoritedMaps(
                    snapshots.map((snapshot) => snapshot.agentFavorites)
                );
                const contentFavoritedAtById = mergeFavoritedMaps(
                    snapshots.map((snapshot) => snapshot.contentFavorites)
                );
                const agentIds = sortFavoriteIds(agentFavoritedAtById);
                const contentIds = sortFavoriteIds(contentFavoritedAtById);
                const backfillOperations = collectMissingFavoriteSyncOps(
                    snapshots,
                    agentFavoritedAtById,
                    contentFavoritedAtById
                );

                void reconcileFavoriteUnion(backfillOperations, token);

                return {
                    agentIds,
                    contentIds,
                    favoritedAtById: {
                        ...agentFavoritedAtById,
                        ...contentFavoritedAtById,
                    },
                };
            },
            {
                pending: (state) => {
                    state.loading = true;
                    state.error = null;
                },
                fulfilled: (state, action) => {
                    const data = action.payload as {
                        agentIds: string[];
                        contentIds: string[];
                        favoritedAtById: Record<string, number>;
                    };
                    state.agentIds = data.agentIds || [];
                    state.contentIds = data.contentIds || [];
                    state.favoritedAtById = data.favoritedAtById || {};
                    state.initialized = true;
                    state.loading = false;
                    state.error = null;
                },
                // 失败时也认为「初始化结束」，避免前端一直以为在 loading
                rejected: (state, action) => {
                    state.loading = false;
                    state.initialized = true;
                    state.error =
                        (action.error?.message as string | undefined) ??
                        "load favorites failed";
                },
            }
        ),

        /** 切换某个 Agent 的收藏状态 */
        toggleFavorite: create.asyncThunk(
            async (agentKey: string, thunkAPI) => {
                const state = thunkAPI.getState() as any;
                const token = selectIdentityToken(state);
                const servers = getFavoriteServers(state);
                const isCurrentlyFavorite =
                    state.favorite?.agentIds?.includes(agentKey) ?? false;
                const nextFavoriteState = !isCurrentlyFavorite;
                const favoritedAt = nextFavoriteState ? Date.now() : undefined;

                if (!token) {
                    throw new Error("未登录，无法操作收藏");
                }

                await setFavoriteAcrossServers(
                    "agent",
                    agentKey,
                    nextFavoriteState,
                    token,
                    servers,
                    favoritedAt
                );

                return { agentKey, isFavorite: nextFavoriteState };
            },
            {
                fulfilled: (state, action) => {
                    const { agentKey, isFavorite } = action.payload;

                    if (isFavorite) {
                        if (!state.agentIds.includes(agentKey)) {
                            state.agentIds.unshift(agentKey);
                        }
                        state.favoritedAtById[agentKey] = Date.now();
                    } else {
                        state.agentIds = state.agentIds.filter(
                            (id) => id !== agentKey
                        );
                        delete state.favoritedAtById[agentKey];
                    }
                },
                rejected: (state, action) => {
                    state.error =
                        (action.error?.message as string | undefined) ??
                        "toggle favorite failed";
                },
            }
        ),

        /** 切换某个内容（page/meta/image）的收藏状态 */
        toggleContentFavorite: create.asyncThunk(
            async (contentKey: string, thunkAPI) => {
                const state = thunkAPI.getState() as any;
                const token = selectIdentityToken(state);
                const servers = getFavoriteServers(state);
                const isCurrentlyFavorite =
                    state.favorite?.contentIds?.includes(contentKey) ?? false;
                const nextFavoriteState = !isCurrentlyFavorite;
                const favoritedAt = nextFavoriteState ? Date.now() : undefined;

                if (!token) {
                    throw new Error("未登录，无法操作收藏");
                }

                await setFavoriteAcrossServers(
                    "content",
                    contentKey,
                    nextFavoriteState,
                    token,
                    servers,
                    favoritedAt
                );

                return { contentKey, isFavorite: nextFavoriteState };
            },
            {
                fulfilled: (state, action) => {
                    const { contentKey, isFavorite } = action.payload;

                    if (isFavorite) {
                        if (!state.contentIds.includes(contentKey)) {
                            state.contentIds.unshift(contentKey);
                        }
                        state.favoritedAtById[contentKey] = Date.now();
                    } else {
                        state.contentIds = state.contentIds.filter(
                            (id) => id !== contentKey
                        );
                        delete state.favoritedAtById[contentKey];
                    }
                },
                rejected: (state, action) => {
                    state.error =
                        (action.error?.message as string | undefined) ??
                        "toggle favorite failed";
                },
            }
        ),

        /** 清空收藏状态（例如登出时用） */
        resetFavorites: create.reducer((state) => {
            state.agentIds = [];
            state.contentIds = [];
            state.favoritedAtById = {};
            state.initialized = false;
            state.loading = false;
            state.error = null;
        }),

        /** 本地手动移除某个收藏 ID（支持多类型内容） */
        removeFavoriteLocally: create.reducer(
            (
                state,
                action: PayloadAction<{
                    targetType: "agent" | "content" | "doc" | "page" | string;
                    id: string;
                }>
            ) => {
                const { targetType, id } = action.payload;
                if (targetType === "agent") {
                    state.agentIds = state.agentIds.filter(
                        (item) => item !== id
                    );
                    delete state.favoritedAtById[id];
                } else if (
                    targetType === "doc" ||
                    targetType === "page" ||
                    targetType === "content"
                ) {
                    state.contentIds = state.contentIds.filter(
                        (item) => item !== id
                    );
                    delete state.favoritedAtById[id];
                }
            }
        ),
    }),
});

// cast: buildCreateSlice async thunks 会推断成 void|AsyncThunk|ActionCreator 联合
export const {
    initFavorites,
    toggleFavorite,
    toggleContentFavorite,
    resetFavorites,
    removeFavoriteLocally,
} = favoriteSlice.actions as any;

export default favoriteSlice.reducer;

// -------- Selectors --------

export const selectFavoriteAgentIds = (state: any) =>
    state.favorite?.agentIds || [];

export const selectFavoriteContentIds = (state: any) =>
    state.favorite?.contentIds || [];

export const selectFavoriteFavoritedAtById = (state: any) =>
    state.favorite?.favoritedAtById || {};

export const selectFavoritesLoading = (state: any) =>
    state.favorite?.loading;

export const selectFavoritesInitialized = (state: any) =>
    state.favorite?.initialized;

export const selectFavoritesError = (state: any) =>
    state.favorite?.error;

export const selectIsAgentFavorited = (state: any, agentKey: string) => {
    if (!agentKey) return false;
    const ids = state.favorite?.agentIds || [];
    return ids.includes(agentKey);
};

export const selectIsContentFavorited = (state: any, contentKey: string) => {
    if (!contentKey) return false;
    const ids = state.favorite?.contentIds || [];
    return ids.includes(contentKey);
};
