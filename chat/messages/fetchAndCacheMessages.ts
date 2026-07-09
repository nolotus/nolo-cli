import { Message } from "./types";
import { fetchMessages as fetchLocalMessages } from "./fetchMessages";
import { fetchConvMsgs } from "./fetchConvMsgs";
import { swallowNonAbortError } from "../../app/utils/async";
import { createKey } from "../../database/keys";
import { DataType } from "../../create/types";
import {
  isTombstoneRecord,
  shouldReplaceWithNextRecord,
} from "../../database/tombstones";

type MessageRecord = Message & { deletedAt?: string; createdAt?: string | number | Date };

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

interface FetchAndCacheMessagesLocalFirstResult {
  localMessages: MessageRecord[];
  remotePromise: Promise<MessageRecord[]>;
  earlyReturned: boolean;
}

export const fetchAndCacheMessagesLocalFirst = async ({
  db,
  dialogId,
  dialogKey,
  limit = 50,
  beforeKey,
  token,
  remoteServers = [],
  signal,
}: FetchAndCacheOptions): Promise<FetchAndCacheMessagesLocalFirstResult> => {
  const startedAt =
    typeof performance !== "undefined" ? performance.now() : Date.now();

  // 1. local query
  const localPromise = fetchLocalMessages(db, dialogId, {
    limit,
    beforeKey,
    throwOnError: false,
    includeDeleted: true,
  }).catch(() => [] as MessageRecord[]);

  // 2. remote query
  const remotePromise = (async () => {
    if (!token || remoteServers.length === 0) return [] as MessageRecord[];

    const results = await Promise.all(
      remoteServers.map((server) =>
        swallowNonAbortError(
          fetchConvMsgs(
            server,
            token,
            { dialogId, dialogKey, limit, beforeKey },
            { signal },
          ),
          [] as MessageRecord[],
          undefined,
        ),
      ),
    );
    return results.flat() as MessageRecord[];
  })();

  let localSettledAt: number | null = null;
  const localTimingPromise = localPromise.then((value) => {
    localSettledAt =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    return value;
  });

  const localMsgs = await localTimingPromise;
  const localMs =
    localSettledAt !== null ? Math.round(localSettledAt - startedAt) : null;
  const earlyReturned = localMsgs.length > 0;

  // 3. background remote merge + persist
  const remotePromiseWithMerge = (async () => {
    let remoteSettledAt: number | null = null;
    const remoteMsgs = await remotePromise.then((value) => {
      remoteSettledAt =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      return value;
    });

    // Re-read local after remote settles so concurrent messageStreamEnd writes
    // (quick-chat first turn) are not lost when remote is empty/stale.
    const freshLocalMsgs = await fetchLocalMessages(db, dialogId, {
      limit,
      beforeKey,
      throwOnError: false,
      includeDeleted: true,
    }).catch(() => [] as MessageRecord[]);

    const uniqueMap = new Map<string, MessageRecord>();
    const changedMessagesToCache = new Map<string, MessageRecord>();
    const put = (m: MessageRecord | null | undefined, trackChange = false) => {
      if (!m || !m.id) return;
      const existing = uniqueMap.get(m.id);
      if (existing && !shouldReplaceWithNextRecord(m, existing)) return;
      uniqueMap.set(m.id, m);
      if (trackChange) changedMessagesToCache.set(m.id, m);
    };
    // Seed with initial local, then fresher local, then remote (remote may track cache writes).
    localMsgs.forEach((m) => put(m));
    freshLocalMsgs.forEach((m) => put(m));
    remoteMsgs.forEach((m) => put(m, true));

    if (changedMessagesToCache.size > 0) {
      try {
        const ops = Array.from(changedMessagesToCache.values()).map((msg) => {
          let key = msg.dbKey || (msg as MessageRecord).dbKey;

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
      } catch {
        // Silently ignore cache write errors
      }
    }

    console.info("[fetchAndCacheMessages-perf]", {
      dialogId,
      localMs,
      remoteMs:
        remoteSettledAt !== null
          ? Math.round(remoteSettledAt - startedAt)
          : null,
      totalMs: Math.round(
        (typeof performance !== "undefined" ? performance.now() : Date.now()) -
          startedAt,
      ),
      localCount: localMsgs.length,
      remoteCount: remoteMsgs.length,
      remoteServerCount: remoteServers.length,
      hasToken: !!token,
      earlyReturned,
    });

    return Array.from(uniqueMap.values())
      .filter((message) => !isTombstoneRecord(message))
      .sort((a, b) => {
        const aCreated =
          a && typeof a === "object" && "createdAt" in a
            ? a.createdAt
            : undefined;
        const bCreated =
          b && typeof b === "object" && "createdAt" in b
            ? b.createdAt
            : undefined;
        const tA = new Date((aCreated as string | number | Date | undefined) || 0).getTime();
        const tB = new Date((bCreated as string | number | Date | undefined) || 0).getTime();
        return tB - tA;
      });
  })();

  if (!earlyReturned) {
    const mergedMessages = await remotePromiseWithMerge;
    return {
      localMessages: mergedMessages,
      remotePromise: Promise.resolve(mergedMessages),
      earlyReturned: false,
    };
  }

  return {
    localMessages: localMsgs,
    remotePromise: remotePromiseWithMerge,
    earlyReturned: true,
  };
};

export const fetchAndCacheMessages = async (
  options: FetchAndCacheOptions,
): Promise<Message[]> => {
  const { remotePromise } = await fetchAndCacheMessagesLocalFirst(options);
  return remotePromise;
};
