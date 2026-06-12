import { Level } from "level";

import type {
  AuthorityBatchOperation,
  AuthorityBatchWriter,
  AuthorityIteratorOptions,
  AuthorityStore,
} from "./authorityStoreTypes";

const safeJsonEncoding = {
  name: "safe-json",
  format: "utf8" as const,
  encode: (data: any) => JSON.stringify(data),
  decode: (data: string) => {
    try {
      return JSON.parse(data);
    } catch {
      console.warn("[LevelDB] Corrupted value:", data?.substring?.(0, 60));
      return null;
    }
  },
};

type LevelBatchWriterLike = {
  put(key: string, value: unknown): void;
  del(key: string): void;
  write(): Promise<void>;
};

type LevelLike = {
  readonly location?: string;
  readonly status?: string;
  open(): Promise<void>;
  close(): Promise<void>;
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  batch(ops: AuthorityBatchOperation[]): Promise<void>;
  batch(): LevelBatchWriterLike;
  iterator(
    options?: AuthorityIteratorOptions
  ): AsyncIterableIterator<[string, unknown]>;
};

export function createLevelAuthorityStore(
  source: string | LevelLike
): AuthorityStore {
  const levelDb: LevelLike = typeof source === "string"
    ? new Level<string, any>(source, { valueEncoding: safeJsonEncoding })
    : source;
  const writeBatchOps = async (ops: AuthorityBatchOperation[]) => {
    const result = levelDb.batch(ops);
    if (result && typeof (result as any).then === "function") {
      await result;
      return;
    }
    if (result && typeof (result as any).write === "function") {
      for (const op of ops) {
        if (op.type === "put") {
          (result as LevelBatchWriterLike).put(op.key, op.value);
        } else {
          (result as LevelBatchWriterLike).del(op.key);
        }
      }
      await (result as LevelBatchWriterLike).write();
      return;
    }
    throw new Error("Level backing does not support batch writes");
  };

  return {
    get location() {
      return levelDb.location;
    },
    get status() {
      return (levelDb as any).status;
    },
    async open() {
      await levelDb.open();
    },
    async close() {
      await levelDb.close();
    },
    async get<T = any>(key: string) {
      return levelDb.get(key) as Promise<T>;
    },
    async put(key: string, value: unknown) {
      await levelDb.put(key, value);
    },
    async del(key: string) {
      await levelDb.del(key);
    },
    async batchWrite(ops: AuthorityBatchOperation[]) {
      await writeBatchOps(ops);
    },
    createBatch(): AuthorityBatchWriter {
      const batch = levelDb.batch();
      return {
        put(key: string, value: unknown) {
          batch.put(key, value);
        },
        del(key: string) {
          batch.del(key);
        },
        async write() {
          await batch.write();
        },
      };
    },
    iterator(options: AuthorityIteratorOptions = {}) {
      return levelDb.iterator(options) as AsyncIterableIterator<[string, unknown]>;
    },
  };
}
