// 文件路径: app/hooks/deleteDbKey.ts

import {
    isDialogKey,
    isPageKey,
    isTableMetaKey,
    isFileKey,
    isAgentKey,
    isAppKey,
    isTaskKey,
} from "../../database/keys";
import { deleteDialog } from "../../chat/dialog/dialogSlice";
import { deleteTable } from "../../render/table/tableSlice";
import { deleteContentFromSpace } from "../../create/space/spaceSlice";
import { read, remove, selectById } from "../../database/dbSlice";
import { removeFavoriteLocally } from "../favorite/favoriteSlice";
import { resolveDeletedFavoriteProjectionRemoval } from "../favorite/deletedFavoriteProjection";
import { asNonEmptyStringArray } from "../../core/stringArray";
import type { AppDispatch } from "../store";
import type { RootState } from "../store";
import {
    deleteAgentLocalCredentialRef,
    extractAgentLocalCredentialRef,
    isPublicAgentProjectionKey,
} from "../../agent-runtime/deleteAgentLocalCredential";

type DeleteDbKeyInput =
    | string
    | {
        contentKey?: unknown;
        dbKey?: unknown;
        key?: unknown;
        serverOrigin?: unknown;
        preferredServerOrigin?: unknown;
        spaceId?: unknown;
        includeAttachments?: unknown;
    };

type ResolvedDeleteInput = {
    contentKey: string;
    preferredServerOrigin?: string;
    inputSpaceId?: string | null;
    includeAttachments?: boolean;
};

/**
 * Authoritative entity delete (tombstone + server remove).
 * Space reference detach is a separate step in deleteDbKey and must not clear
 * global Agent credentials by itself.
 */
const performDirectDelete = async (
    dispatch: AppDispatch,
    getState: () => RootState,
    contentKey: string,
    preferredServerOrigin?: string,
    includeAttachments?: boolean
): Promise<void> => {
    if (isDialogKey(contentKey)) {
        await (dispatch as any)(
            deleteDialog({ dialogKey: contentKey, includeAttachments })
        ).unwrap();
        return;
    }

    if (isTableMetaKey(contentKey)) {
        await (dispatch as any)(deleteTable({ dbKey: contentKey })).unwrap();
        return;
    }

    if (isAgentKey(contentKey)) {
        // Peek credentialRef before DB delete — never read secrets; never use OAuth apiKeyRef.
        // Public projections share the private agent's ref and must not clear the broker key.
        // Prefer Redux when warm; cold cache (list/deep-link) falls back to existing DB read.
        let credentialRef: string | null = null;
        if (!isPublicAgentProjectionKey(contentKey)) {
            try {
                let record: unknown = selectById(getState() as any, contentKey);
                if (!record) {
                    try {
                        record = await (dispatch as any)(
                            read({
                                dbKey: contentKey,
                                preferredServerOrigin,
                            })
                        ).unwrap();
                    } catch {
                        record = null;
                    }
                }
                credentialRef = extractAgentLocalCredentialRef(record);
            } catch {
                credentialRef = null;
            }
        }

        // Order: DB/tombstone first. Broker cleanup only after success so a DB failure
        // never leaves a live Agent without its local key.
        await (dispatch as any)(
            remove({
                dbKey: contentKey,
                preferredServerOrigin,
            })
        ).unwrap();

        if (credentialRef) {
            const cleanup = await deleteAgentLocalCredentialRef(credentialRef);
            if (!cleanup.deleted && "warning" in cleanup) {
                // Sanitized: no ref/secret. Do not resurrect DB; keep delete API success.
                console.warn(
                    "[deleteDbKey] local API credential cleanup failed after agent delete:",
                    cleanup.warning
                );
            }
        }
        return;
    }

    if (
        isAppKey(contentKey) ||
        isPageKey(contentKey) ||
        isFileKey(contentKey) ||
        isTaskKey(contentKey)
    ) {
        await (dispatch as any)(
            remove({
                dbKey: contentKey,
                preferredServerOrigin,
            })
        ).unwrap();
    }
};

const resolveDeleteInput = (input: DeleteDbKeyInput): ResolvedDeleteInput => {
    if (typeof input === "string" && input.trim()) {
        return { contentKey: input };
    }

    if (input && typeof input === "object") {
        const candidates = [input.contentKey, input.dbKey, input.key];
        const preferredServerOrigin = asNonEmptyStringArray([
            input.preferredServerOrigin,
            input.serverOrigin,
        ])[0];
        const inputSpaceId =
            typeof input.spaceId === "string" && input.spaceId.trim().length > 0
                ? input.spaceId
                : null;
        const includeAttachments = input.includeAttachments === true;
        for (const candidate of candidates) {
            if (typeof candidate === "string" && candidate.trim()) {
                return {
                    contentKey: candidate,
                    preferredServerOrigin,
                    inputSpaceId,
                    includeAttachments,
                };
            }
        }
    }

    throw new Error("Invalid delete key");
};

const extractDeleteErrorMessage = (
    error: unknown,
    seen = new Set<object>(),
    depth = 0
): string | null => {
    if (depth > 8) {
        return null;
    }

    if (error instanceof Error && error.message.trim()) {
        return error.message;
    }

    if (typeof error === "string" && error.trim()) {
        return error;
    }

    if (!error || typeof error !== "object") {
        return null;
    }

    if (seen.has(error)) {
        return null;
    }

    seen.add(error);

    const record = error as Record<string, unknown>;
    const directKeys = ["message", "error", "detail", "title"] as const;
    for (const key of directKeys) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) {
            return value;
        }
    }

    const nestedKeys = ["payload", "data", "cause"] as const;
    for (const key of nestedKeys) {
        const message = extractDeleteErrorMessage(record[key], seen, depth + 1);
        if (message) {
            return message;
        }
    }

    if (Array.isArray(record.errors)) {
        const messages = record.errors
            .map((item) => extractDeleteErrorMessage(item, seen, depth + 1))
            .filter((item): item is string => Boolean(item));
        if (messages.length > 0) {
            return messages.join("\n");
        }
    }

    try {
        const serialized = JSON.stringify(error);
        if (serialized && serialized !== "{}") {
            return serialized;
        }
    } catch {
        return null;
    }

    return null;
};

export const getDeleteErrorMessage = (
    error: unknown,
    fallback = "Delete failed"
): string => {
    return extractDeleteErrorMessage(error) ?? fallback;
};

const normalizeDeleteError = (error: unknown): Error => {
    if (error instanceof Error && error.message.trim()) {
        return error;
    }

    return new Error(getDeleteErrorMessage(error));
};

/**
 * 根据 db key 删除对应资源，并同步移除 space 中的引用
 */
export const deleteDbKey =
    (input: DeleteDbKeyInput, spaceId?: string | null) =>
        async (dispatch: AppDispatch, getState: () => RootState): Promise<boolean> => {
            try {
                const {
                    contentKey,
                    preferredServerOrigin,
                    inputSpaceId,
                    includeAttachments,
                } = resolveDeleteInput(input);
                const effectiveSpaceId =
                    typeof spaceId === "string" && spaceId.trim().length > 0
                        ? spaceId
                        : inputSpaceId ?? null;
                console.log("[deleteDbKey] START", {
                    contentKey,
                    preferredServerOrigin,
                    effectiveSpaceId,
                    rawInput: typeof input === "string" ? input : JSON.stringify(input),
                });
                // 1. 始终先执行实体的直接删除（写 tombstone + 尝试服务器删除）
                // 无论 space 操作结果如何，实体都必须被标记为已删除，
                // 否则 deleteContentFromSpace 成功但跳过实体删除时，
                // 远端活记录会在下一次 merge 时回流。
                // Agent local credentialRef is cleared only on this authoritative path
                // (after successful remove) — not when merely detaching a Space reference.
                await performDirectDelete(
                    dispatch,
                    getState,
                    contentKey,
                    preferredServerOrigin,
                    includeAttachments
                );

                // 2. 如果有 spaceId，先完成本地 space 引用清理，再返回给 UI。
                // 这仍然是 local-first 语义：
                // - 实体 tombstone 已先写入
                // - space.contents 的本地 patch 也要在导航前落稳
                // 但不要求等待远端强一致。
                // Space unlink alone must never delete per-Agent broker secrets.
                if (effectiveSpaceId) {
                    await (dispatch as any)(
                        (deleteContentFromSpace as any)({
                            contentKey,
                            spaceId: effectiveSpaceId,
                            ...(preferredServerOrigin
                                ? { sourceServerOrigin: preferredServerOrigin }
                                : {}),
                        })
                    ).unwrap().catch((err: unknown) => {
                        console.warn("[deleteDbKey] space cleanup failed (entity already tombstoned):", err);
                    });
                }

                const favoriteProjectionRemoval =
                    resolveDeletedFavoriteProjectionRemoval(contentKey);
                if (favoriteProjectionRemoval) {
                    dispatch(removeFavoriteLocally(favoriteProjectionRemoval));
                }

                if (typeof window !== "undefined") {
                    window.dispatchEvent(
                        new CustomEvent("nolo-user-data-updated", {
                            detail: { deletedDbKey: contentKey },
                        })
                    );
                }

                // 3. 返回值：让上层可以 await
                return true;
            } catch (error) {
                throw normalizeDeleteError(error);
            }
        };
