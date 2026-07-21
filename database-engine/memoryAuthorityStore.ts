import type {
  AuthorityBatchOperation,
  AuthorityBatchWriter,
  AuthorityIteratorOptions,
  AuthorityStore,
} from "./authorityStoreTypes";

type MemoryEntry = {
  key: string;
  value: unknown;
};

const createNotFoundError = () => {
  const error = new Error("NotFound") as Error & { notFound: true };
  error.notFound = true;
  return error;
};

class MemoryAuthorityBacking {
  readonly location: string;
  status: "closed" | "open" = "closed";
  private readonly data = new Map<string, unknown>();

  constructor(location: string) {
    this.location = location;
  }

  async open() {
    this.status = "open";
  }

  async close() {
    this.status = "closed";
  }

  async get(key: string): Promise<any> {
    if (!this.data.has(key)) {
      throw createNotFoundError();
    }
    return this.data.get(key);
  }

  async put(key: string, value: unknown) {
    this.data.set(key, value);
  }

  async del(key: string) {
    this.data.delete(key);
  }

  async batchWrite(ops: AuthorityBatchOperation[]) {
    for (const op of ops) {
      if (op.type === "put") {
        this.data.set(op.key, op.value);
      } else {
        this.data.delete(op.key);
      }
    }
  }

  createBatch(): AuthorityBatchWriter {
    const buffered: AuthorityBatchOperation[] = [];
    return {
      put(key: string, value: unknown) {
        buffered.push({ type: "put", key, value });
      },
      del(key: string) {
        buffered.push({ type: "del", key });
      },
      write: async () => {
        await this.batchWrite(buffered);
      },
    };
  }

  async *iterator(
    options: AuthorityIteratorOptions = {}
  ): AsyncIterableIterator<[string, unknown]> {
    const entries: MemoryEntry[] = Array.from(this.data.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value }));

    if (options.reverse) {
      entries.reverse();
    }

    for (const entry of entries) {
      if (options.gte && entry.key < options.gte) continue;
      if (options.lte && entry.key > options.lte) continue;
      if (options.lt && entry.key >= options.lt) continue;
      yield [entry.key, entry.value];
    }
  }
}

export function createMemoryAuthorityStore(
  location = ":memory:"
): AuthorityStore {
  const backing = new MemoryAuthorityBacking(location);

  return {
    get location() {
      return backing.location;
    },
    get status() {
      return backing.status;
    },
    async open() {
      await backing.open();
    },
    async close() {
      await backing.close();
    },
    async get(key: string): Promise<any> {
      return backing.get(key);
    },
    async put(key: string, value: unknown) {
      await backing.put(key, value);
    },
    async del(key: string) {
      await backing.del(key);
    },
    async batchWrite(ops: AuthorityBatchOperation[]) {
      await backing.batchWrite(ops);
    },
    createBatch() {
      return backing.createBatch();
    },
    iterator(options: AuthorityIteratorOptions = {}) {
      return backing.iterator(options);
    },
  };
}
