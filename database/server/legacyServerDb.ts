import type {
  AuthorityBatchOperation,
  AuthorityBatchWriter,
  AuthorityIteratorOptions,
  AuthorityStore,
} from "./authorityStoreTypes";

export type LegacyServerDb = {
  readonly location?: string;
  readonly status?: string;
  open(): Promise<void>;
  close(): Promise<void>;
  get<T = any>(key: string): Promise<T>;
  put(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  batch(ops: AuthorityBatchOperation[]): Promise<void>;
  batch(): AuthorityBatchWriter;
  iterator(
    options?: AuthorityIteratorOptions
  ): AsyncIterableIterator<[string, unknown]>;
};

export function createLegacyServerDb(store: AuthorityStore): LegacyServerDb {
  const batch = (ops?: AuthorityBatchOperation[]) => {
    if (Array.isArray(ops)) {
      return store.batchWrite(ops);
    }
    return store.createBatch();
  };

  return {
    get location() {
      return store.location;
    },
    get status() {
      return store.status;
    },
    async open() {
      await store.open();
    },
    async close() {
      await store.close();
    },
    async get<T = any>(key: string) {
      return store.get<T>(key);
    },
    async put(key: string, value: unknown) {
      await store.put(key, value);
    },
    async del(key: string) {
      await store.del(key);
    },
    batch: batch as LegacyServerDb["batch"],
    iterator(options: AuthorityIteratorOptions = {}) {
      return store.iterator(options);
    },
  };
}
