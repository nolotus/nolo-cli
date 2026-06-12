// 文件路径: database/actions/fileContent.ts

import type { AppThunkApi } from "../../app/store";
import { API_ENDPOINTS } from "../config";
import { getRuntimeServerContext } from "../runtimeServerContext";
import {
    loadFileFromIndexedDb,
    saveFileToIndexedDb,
    StoredFileRecord,
} from "../fileStorage";
import { getFileIdFromKey } from "../keys";

/**
 * 从 dbKey 中提取裸 ULID（用于 IndexedDB 查找）
 *
 * 如果传入的是完整 dbKey（如 file-{userId}-{fileId}），返回 fileId（ULID）。
 * 如果传入的已经是裸 ULID，则原样返回。
 */
const resolveLocalFileId = (fileId: string): string => {
    if (fileId.startsWith("file-")) {
        return getFileIdFromKey(fileId) || fileId;
    }
    return fileId;
};

/**
 * 读取文件内容（优先本地 IndexedDB，缺失时从服务器拉取并写入本地缓存）
 *
 * fileId 支持两种格式：
 * - 完整 dbKey：file-{userId}-{fileId}（推荐，服务端可直接查询）
 * - 裸 ULID：{fileId}（需要服务端 file-id 索引）
 *
 * 返回：
 * - fileId: string
 * - blob: Blob
 * - source: "local" | "remote"
 */
export const readFileContentAction = async (
    {
        fileId,
        useServerFallback = true,
    }: { fileId: string; useServerFallback?: boolean },
    thunkApi: AppThunkApi
): Promise<{ fileId: string; blob: Blob; source: "local" | "remote" }> => {
    if (!fileId || typeof fileId !== "string") {
        throw new Error("readFileContentAction requires a valid fileId string.");
    }

    // IndexedDB 以裸 ULID 为 key 存储文件
    const localId = resolveLocalFileId(fileId);

    // 1. 先尝试从 IndexedDB 读取（使用裸 ULID）
    const localRecord: StoredFileRecord | null =
        await loadFileFromIndexedDb(localId);
    if (localRecord) {
        return {
            fileId: localId,
            blob: localRecord.blob,
            source: "local",
        };
    }

    // 2. 根据参数决定是否回退到服务器
    if (!useServerFallback) {
        throw new Error(
            `Local file not found for id "${fileId}", and server fallback is disabled.`
        );
    }

    // 3. 从服务器拉取文件内容（使用原始 fileId，完整 dbKey 可直接查询）
    const state = thunkApi.getState();
    const { currentServer, remoteServers: serversToTry } =
        getRuntimeServerContext(state);

    if (!currentServer) {
        throw new Error(
            `No current server configured. Cannot fetch remote file for id "${fileId}".`
        );
    }

    let lastError = "";

    for (const server of serversToTry) {
        const url = `${server}${API_ENDPOINTS.DATABASE}/file/content/${fileId}`;
        console.debug("[readFileContentAction] trying server:", url);

        try {
            const res = await fetch(url);
            if (!res.ok) {
                lastError = `HTTP ${res.status} from ${server}`;
                console.debug("[readFileContentAction] server returned:", lastError);
                continue;
            }

            const blob = await res.blob();

            // 将从服务器获取的文件写入 IndexedDB，以裸 ULID 为 key 缓存
            if (typeof indexedDB !== "undefined") {
                void saveFileToIndexedDb(localId, blob).catch((err) => {
                    console.warn(
                        "[readFileContentAction] Failed to cache remote file into IndexedDB:",
                        err
                    );
                });
            }

            return {
                fileId: localId,
                blob,
                source: "remote" as const,
            };
        } catch (err: any) {
            lastError = err?.message || "Network error";
            console.debug(
                "[readFileContentAction] fetch error from",
                server,
                lastError
            );
        }
    }

    throw new Error(
        `Failed to fetch remote file content from all servers for id "${fileId}". Last error: ${lastError}`
    );
};
