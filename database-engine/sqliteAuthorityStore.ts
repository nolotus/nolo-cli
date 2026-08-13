import { Database } from "bun:sqlite";
import type {
  AuthorityBatchOperation,
  AuthorityBatchWriter,
  AuthorityIteratorOptions,
  AuthorityStore,
} from "./authorityStoreTypes";

type IteratorResult = [string, unknown];

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  )
`;

const PRAGMAS = [
  "PRAGMA journal_mode = WAL;",
  "PRAGMA synchronous = NORMAL;",
  "PRAGMA busy_timeout = 5000;",
];

export function createSqliteAuthorityStore(dbPath: string): AuthorityStore {
  let db: Database | undefined;
  let isOpen = false;

  const ensureTable = () => {
    db.exec(CREATE_TABLE_SQL);
    for (const pragma of PRAGMAS) {
      db.exec(pragma);
    }
  };

  const encodeValue = (value: unknown): string => JSON.stringify(value);
  const decodeValue = (value: string): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      console.warn("[SQLite] Corrupted value:", value?.substring?.(0, 60));
      return null;
    }
  };

  return {
    get location() {
      return dbPath;
    },
    get status() {
      return isOpen ? "open" : "closed";
    },
    async open() {
      if (isOpen) return;
      db = new Database(dbPath, { create: true });
      ensureTable();
      isOpen = true;
    },
    async close() {
      if (!isOpen) return;
      if (db) {
        db.close(false);
        db = undefined;
      }
      isOpen = false;
    },
    async get(key: string): Promise<any> {
      const stmt = db.query("SELECT value FROM kv_store WHERE key = ?");
      const row = stmt.get(key) as { value: string } | null;
      if (!row) {
        const err = new Error("NotFound") as Error & { notFound: true };
        err.notFound = true;
        throw err;
      }
      return decodeValue(row.value);
    },
    async put(key: string, value: unknown) {
      const stmt = db.query(
        "INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)"
      );
      stmt.run(key, encodeValue(value));
    },
    async del(key: string) {
      const stmt = db.query("DELETE FROM kv_store WHERE key = ?");
      stmt.run(key);
    },
    async batchWrite(ops: AuthorityBatchOperation[]) {
      const insertStmt = db.query(
        "INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)"
      );
      const deleteStmt = db.query("DELETE FROM kv_store WHERE key = ?");

      db.transaction(() => {
        for (const op of ops) {
          if (op.type === "put") {
            insertStmt.run(op.key, encodeValue(op.value));
          } else {
            deleteStmt.run(op.key);
          }
        }
      })();
    },
    createBatch(): AuthorityBatchWriter {
      const buffered: AuthorityBatchOperation[] = [];
      return {
        put(key: string, value: unknown) {
          buffered.push({ type: "put", key, value });
        },
        del(key: string) {
          buffered.push({ type: "del", key });
        },
        async write() {
          const ops = buffered.splice(0, buffered.length);
          const insertStmt = db.query(
            "INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)"
          );
          const deleteStmt = db.query("DELETE FROM kv_store WHERE key = ?");

          db.transaction(() => {
            for (const op of ops) {
              if (op.type === "put") {
                insertStmt.run(op.key, encodeValue(op.value));
              } else {
                deleteStmt.run(op.key);
              }
            }
          })();
        },
      };
    },
    async *iterator(
      options: AuthorityIteratorOptions = {}
    ): AsyncIterableIterator<IteratorResult> {
      const conditions: string[] = [];
      const params: string[] = [];

      if (options.gte !== undefined) {
        conditions.push("key >= ?");
        params.push(options.gte);
      }
      if (options.lte !== undefined) {
        conditions.push("key <= ?");
        params.push(options.lte);
      }
      if (options.lt !== undefined) {
        conditions.push("key < ?");
        params.push(options.lt);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const orderClause = options.reverse ? "ORDER BY key DESC" : "ORDER BY key ASC";

      const stmt = db.query(`SELECT key, value FROM kv_store ${whereClause} ${orderClause}`);
      for (const row of stmt.iterate(...params)) {
        yield [(row as any).key, decodeValue((row as any).value)];
      }
    },
  };
}
