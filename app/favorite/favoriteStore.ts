// File: app/favorite/favoriteStore.ts
// Module store for favorites — peeled out of Redux (Wave8).
// Mirrors packages/app/notifications/notificationStore.ts +
// packages/ai/tools/toolRunStore.ts (version counter, client-only).
//
// RPC helpers below are copied verbatim from the deleted favoriteSlice.ts.
// Async ops stay dispatchable via createAsyncThunk (initFavorites /
// toggleFavorite / toggleContentFavorite); favorite state reads/writes go
// through mutators/getters, not Redux.

import { useMemo, useSyncExternalStore } from "react";
import { useAppSelector } from "../store";
import { selectIdentityToken } from "identity/selectors";
import { selectRemoteServers } from "../settings/settingSlice";
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

const createInitialState = (): FavoriteState => ({
    agentIds: [],
    contentIds: [],
    favoritedAtById: {},
    initialized: false,
    loading: false,
    error: null,
});

let state: FavoriteState = createInitialState();
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


// ===== mutators =====

export function resetFavorites(): void {
    state = createInitialState();
    notify();
}

export function removeFavoriteLocally(payload: {
    targetType: "agent" | "content" | "doc" | "page" | string;
    id: string;
}): void {
    const { targetType, id } = payload;
    if (targetType === "agent") {
        state = {
            ...state,
            agentIds: state.agentIds.filter((item) => item !== id),
            favoritedAtById: { ...state.favoritedAtById },
        };
        delete state.favoritedAtById[id];
        notify();
        return;
    }
    if (
        targetType === "doc" ||
        targetType === "page" ||
        targetType === "content"
    ) {
        state = {
            ...state,
            contentIds: state.contentIds.filter((item) => item !== id),
            favoritedAtById: { ...state.favoritedAtById },
        };
        delete state.favoritedAtById[id];
        notify();
    }
}

function markFavoritesLoading(): void {
    state = { ...state, loading: true, error: null };
    notify();
}

function replaceFavorites(data: {
    agentIds: string[];
    contentIds: string[];
    favoritedAtById: Record<string, number>;
}): void {
    state = {
        agentIds: data.agentIds || [],
        contentIds: data.contentIds || [],
        favoritedAtById: data.favoritedAtById || {},
        initialized: true,
        loading: false,
        error: null,
    };
    notify();
}

function markFavoritesInitFailed(message: string): void {
    state = {
        ...state,
        loading: false,
        initialized: true,
        error: message,
    };
    notify();
}

function applyAgentToggle(agentKey: string, isFavorite: boolean): void {
    const favoritedAtById = { ...state.favoritedAtById };
    let agentIds = state.agentIds;
    if (isFavorite) {
        if (!agentIds.includes(agentKey)) {
            agentIds = [agentKey, ...agentIds];
        }
        favoritedAtById[agentKey] = Date.now();
    } else {
        agentIds = agentIds.filter((id) => id !== agentKey);
        delete favoritedAtById[agentKey];
    }
    state = { ...state, agentIds, favoritedAtById };
    notify();
}

function applyContentToggle(contentKey: string, isFavorite: boolean): void {
    const favoritedAtById = { ...state.favoritedAtById };
    let contentIds = state.contentIds;
    if (isFavorite) {
        if (!contentIds.includes(contentKey)) {
            contentIds = [contentKey, ...contentIds];
        }
        favoritedAtById[contentKey] = Date.now();
    } else {
        contentIds = contentIds.filter((id) => id !== contentKey);
        delete favoritedAtById[contentKey];
    }
    state = { ...state, contentIds, favoritedAtById };
    notify();
}

function markToggleFavoriteFailed(message: string): void {
    state = { ...state, error: message };
    notify();
}

// ===== getters =====

export function getFavoriteAgentIds(): string[] {
    return state.agentIds;
}

export function getFavoriteContentIds(): string[] {
    return state.contentIds;
}

export function getFavoriteFavoritedAtById(): Record<string, number> {
    return state.favoritedAtById;
}

export function getFavoritesLoading(): boolean {
    return state.loading;
}

export function getFavoritesInitialized(): boolean {
    return state.initialized;
}

export function getFavoritesError(): string | null {
    return state.error;
}

export function isAgentFavorited(agentKey: string): boolean {
    if (!agentKey) return false;
    return state.agentIds.includes(agentKey);
}

export function isContentFavorited(contentKey: string): boolean {
    if (!contentKey) return false;
    return state.contentIds.includes(contentKey);
}

// ===== useSyncExternalStore =====

export function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getSnapshot(): number {
    return version;
}

export function useFavoriteAgentIds(): string[] {
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return getFavoriteAgentIds();
}

export function useFavoriteContentIds(): string[] {
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return getFavoriteContentIds();
}

export function useFavoriteFavoritedAtById(): Record<string, number> {
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return getFavoriteFavoritedAtById();
}

export function useFavoritesLoading(): boolean {
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return getFavoritesLoading();
}

export function useFavoritesInitialized(): boolean {
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return getFavoritesInitialized();
}

export function useFavoritesError(): string | null {
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return getFavoritesError();
}

export function useIsAgentFavorited(agentKey: string): boolean {
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return isAgentFavorited(agentKey);
}

export function useIsContentFavorited(contentKey: string): boolean {
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return isContentFavorited(contentKey);
}

export function resetFavoriteStoreForTests(): void {
    state = createInitialState();
    notify();
}

/** Test-only seed — not for product call sites. */
export function seedFavoriteStoreForTests(seed: {
    agentIds?: string[];
    contentIds?: string[];
    favoritedAtById?: Record<string, number>;
    initialized?: boolean;
}): void {
    state = {
        ...createInitialState(),
        agentIds: seed.agentIds ?? [],
        contentIds: seed.contentIds ?? [],
        favoritedAtById: seed.favoritedAtById ?? {},
        initialized: seed.initialized ?? true,
    };
    notify();
}

// ===== 依赖注入（Wave2 剥离：不再从 redux getState 取 token/servers）=====

export interface FavoriteDeps {
    token: string;
    /** 与 selectRemoteServers 等价的同步目标服务器列表 */
    servers: string[];
}

/** 组件内获取 favorite API 依赖（settings/auth 尚未剥离 redux，仍走 selector）。 */
export function useFavoriteDeps(): FavoriteDeps | null {
    const token = useAppSelector(selectIdentityToken) ?? "";
    const servers = useAppSelector(selectRemoteServers) ?? [];
    return useMemo(() => ({ token, servers }), [token, servers]);
}

// ===== async 操作（纯 async 函数，不再 dispatchable）=====

export async function initFavorites(deps: FavoriteDeps): Promise<unknown> {
        markFavoritesLoading();
        try {
            const { token, servers } = deps;

            if (!token) {
                throw new Error("未登录，无法加载收藏列表");
            }

            const snapshotResults = await Promise.allSettled(
                servers.map((server) => loadFavoritesFromServer(server, token))
            );
            const snapshots = snapshotResults
                .filter(
                    (
                        result
                    ): result is PromiseFulfilledResult<FavoriteServerSnapshot> =>
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

            const payload = {
                agentIds,
                contentIds,
                favoritedAtById: {
                    ...agentFavoritedAtById,
                    ...contentFavoritedAtById,
                },
            };
            replaceFavorites(payload);
            return payload;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "load favorites failed";
            markFavoritesInitFailed(message);
            throw error;
        }
    }

export async function toggleFavorite(
    deps: FavoriteDeps,
    agentKey: string
): Promise<{ agentKey: string; isFavorite: boolean }> {
    const { token, servers } = deps;
    const isCurrentlyFavorite = isAgentFavorited(agentKey);
    const nextFavoriteState = !isCurrentlyFavorite;
    const favoritedAt = nextFavoriteState ? Date.now() : undefined;

    if (!token) {
        throw new Error("未登录，无法操作收藏");
    }

    try {
        await setFavoriteAcrossServers(
            "agent",
            agentKey,
            nextFavoriteState,
            token,
            servers,
            favoritedAt
        );
        applyAgentToggle(agentKey, nextFavoriteState);
        return { agentKey, isFavorite: nextFavoriteState };
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : "toggle favorite failed";
        markToggleFavoriteFailed(message);
        throw error;
    }
}

export async function toggleContentFavorite(
    deps: FavoriteDeps,
    contentKey: string
): Promise<{ contentKey: string; isFavorite: boolean }> {
    const { token, servers } = deps;
    const isCurrentlyFavorite = isContentFavorited(contentKey);
    const nextFavoriteState = !isCurrentlyFavorite;
    const favoritedAt = nextFavoriteState ? Date.now() : undefined;

    if (!token) {
        throw new Error("未登录，无法操作收藏");
    }

    try {
        await setFavoriteAcrossServers(
            "content",
            contentKey,
            nextFavoriteState,
            token,
            servers,
            favoritedAt
        );
        applyContentToggle(contentKey, nextFavoriteState);
        return { contentKey, isFavorite: nextFavoriteState };
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : "toggle favorite failed";
        markToggleFavoriteFailed(message);
        throw error;
    }
}
