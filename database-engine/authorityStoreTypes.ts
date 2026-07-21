export type AuthorityBatchOperation =
  | { type: "put"; key: string; value: unknown }
  | { type: "del"; key: string };

export type AuthorityIteratorOptions = {
  gte?: string;
  lte?: string;
  lt?: string;
  reverse?: boolean;
};

export interface AuthorityBatchWriter {
  put(key: string, value: unknown): void;
  del(key: string): void;
  write(): Promise<void>;
}

export interface AuthorityStore {
  readonly location?: string;
  readonly status?: string;
  open(): Promise<void>;
  close(): Promise<void>;
  /**
   * Schema-free KV payloads.
   * Non-generic overload first so bare `get(key)` stays `Promise<any>`
   * (generic-only `get<T=any>` collapses under expect/NoInfer to `undefined`).
   */
  get(key: string): Promise<any>;
  get<T>(key: string): Promise<T>;
  put(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  batchWrite(ops: AuthorityBatchOperation[]): Promise<void>;
  createBatch(): AuthorityBatchWriter;
  iterator(
    options?: AuthorityIteratorOptions
  ): AsyncIterableIterator<[string, unknown]>;
}
