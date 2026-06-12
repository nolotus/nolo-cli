import { Message } from "./types";
import { fetchMessages as fetchLocalMessages } from "./fetchMessages";
import { fetchConvMsgs } from "./fetchConvMsgs";
import { swallowNonAbortError } from "../../app/utils/async";
import { createKey } from "../../database/keys";
import { DataType } from "../../create/types";
import { isTombstoneRecord, shouldReplaceWithNextRecord } from "../../database/tombstones";

type MessageRecord = Message & { deletedAt?: string };

interface FetchAndCacheOptions {
    db: any; // Local LevelDB instance
    dialogId: string;
    dialogKey?: string;
    limit?: number;
    beforeKey?: string;
    token?: string | null;
    remoteServers?: string[];
    signal?: AbortSignal;
}

export const fetchAndCacheMessages = async ({
    db,
    dialogId,
    dialogKey,
    limit = 50,
    beforeKey,
    token,
    remoteServers = [],
    signal,
}: FetchAndCacheOptions): Promise<Message[]> => {
    // 1. 本地查询
    const localPromise = fetchLocalMessages(db, dialogId, {
        limit,
        beforeKey,
        throwOnError: false,
        includeDeleted: true,
    }).catch(() => [] as MessageRecord[]);

    // 2. 远程查询
    const remotePromise = (async () => {
        if (!token || remoteServers.length === 0) return [] as MessageRecord[];

        const results = await Promise.all(
            remoteServers.map((server) =>
                swallowNonAbortError(
                    fetchConvMsgs(
                        server,
                        token,
                        { dialogId, dialogKey, limit, beforeKey },
                        { signal }
                    ),
                    [] as MessageRecord[],
                    undefined
                )
            )
        );
        return results.flat() as MessageRecord[];
    })();

    const [localMsgs, remoteMsgs] = await Promise.all([
        localPromise,
        remotePromise,
    ]);

    const uniqueMap = new Map<string, MessageRecord>();

    // 先放入本地消息
    localMsgs.forEach((m) => uniqueMap.set(m.id, m));

    const changedMessagesToCache = new Map<string, MessageRecord>();

    // 4. 合并远程消息，并标记需要缓存的新消息
    remoteMsgs.forEach((m) => {
        if (!m || !m.id) return;

        const existing = uniqueMap.get(m.id);
        if (!existing || shouldReplaceWithNextRecord(m, existing)) {
            uniqueMap.set(m.id, m);
            changedMessagesToCache.set(m.id, m);
        }
    });

    // 5. 将缺失的消息回写到本地 DB
    if (changedMessagesToCache.size > 0) {
        try {
            const ops = Array.from(changedMessagesToCache.values()).map((msg) => {
                let key = msg.dbKey || (msg as any)._key;

                if (!key) {
                    key = createKey(DataType.DIALOG, dialogId, "msg", msg.id);
                }

                return {
                    type: "put",
                    key,
                    value: {
                        ...msg,
                        dbKey: key,
                        type: DataType.MSG,
                    },
                };
            });

            await db.batch(ops);
        } catch (_error) {
            // Silently ignore cache write errors
        }
    }

    // 6. 排序并返回
    return Array.from(uniqueMap.values())
        .filter((message) => !isTombstoneRecord(message))
        .sort((a, b) => {
            const tA = new Date((a as any).createdAt || 0).getTime();
            const tB = new Date((b as any).createdAt || 0).getTime();
            return tB - tA; // 降序 (Newest First)
        });
};
