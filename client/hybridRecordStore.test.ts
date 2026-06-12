import { describe, expect, test } from "bun:test";

import {
  createCliHybridRecordStore,
  shouldCacheRemoteRecord,
} from "./hybridRecordStore";

function createMemoryDb(initial: Record<string, any> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    db: {
      get: async (key: string) => {
        if (!store.has(key)) throw new Error(`not found: ${key}`);
        return store.get(key);
      },
      put: async (key: string, value: any) => {
        store.set(key, value);
      },
      batch: async (ops: Array<{ type: "put"; key: string; value: any }>) => {
        for (const op of ops) {
          if (op.type === "put") store.set(op.key, op.value);
        }
      },
      iterator: ({ gte, lte }: { gte: string; lte?: string }) => (async function* () {
        for (const entry of [...store.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          if (entry[0] >= gte && (!lte || entry[0] <= lte)) yield entry;
        }
      })(),
    },
  };
}

describe("CLI hybrid record store", () => {
  test("returns a local record without requiring a server", async () => {
    const { db } = createMemoryDb({
      "agent-user-1-a": { dbKey: "agent-user-1-a", name: "local" },
    });
    const store = createCliHybridRecordStore({
      db,
      env: {},
      fetchImpl: async () => {
        throw new Error("network should not be used for local hits");
      },
    });

    await expect(store.read("agent-user-1-a")).resolves.toMatchObject({
      name: "local",
    });
  });

  test("reads through to the configured server on local miss and caches the record with serverOrigin", async () => {
    const { db, store: memory } = createMemoryDb();
    const requests: Array<{ url: string; auth: string | null }> = [];
    const hybrid = createCliHybridRecordStore({
      db,
      env: {
        NOLO_SERVER: "https://us.nolo.chat/",
        AUTH_TOKEN: "token-1",
      },
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          auth: new Headers(init?.headers).get("Authorization"),
        });
        return Response.json({
          data: {
            dbKey: "agent-user-1-remote",
            name: "remote",
            updatedAt: "2026-05-13T00:00:00.000Z",
          },
        });
      },
    });

    await expect(hybrid.read("agent-user-1-remote")).resolves.toMatchObject({
      name: "remote",
      serverOrigin: "https://us.nolo.chat",
    });
    expect(requests).toEqual([{
      url: "https://us.nolo.chat/api/v1/db/read/agent-user-1-remote",
      auth: "Bearer token-1",
    }]);
    expect(memory.get("agent-user-1-remote")).toMatchObject({
      name: "remote",
      serverOrigin: "https://us.nolo.chat",
    });
  });

  test("falls back across known cluster servers on local miss and caches the first remote hit", async () => {
    const { db, store: memory } = createMemoryDb();
    const requests: string[] = [];
    const hybrid = createCliHybridRecordStore({
      db,
      env: {
        NOLO_SERVER: "http://127.0.0.1:38123",
        AUTH_TOKEN: "token-1",
      },
      fetchImpl: async (url) => {
        const target = String(url);
        requests.push(target);
        if (target.startsWith("http://127.0.0.1:38123/")) {
          throw new Error("ConnectionRefused");
        }
        if (target.startsWith("https://nolo.chat/")) {
          return Response.json({
            data: {
              dbKey: "agent-user-1-cluster",
              name: "cluster remote",
              updatedAt: "2026-05-24T00:00:00.000Z",
            },
          });
        }
        return new Response(null, { status: 404 });
      },
    });

    await expect(hybrid.read("agent-user-1-cluster")).resolves.toMatchObject({
      name: "cluster remote",
      serverOrigin: "https://nolo.chat",
    });
    expect(requests).toEqual([
      "http://127.0.0.1:38123/api/v1/db/read/agent-user-1-cluster",
      "https://nolo.chat/api/v1/db/read/agent-user-1-cluster",
    ]);
    expect(memory.get("agent-user-1-cluster")).toMatchObject({
      name: "cluster remote",
      serverOrigin: "https://nolo.chat",
    });
  });

  test("keeps newer local records over stale remote records", () => {
    expect(shouldCacheRemoteRecord(
      { updatedAt: "2026-05-12T00:00:00.000Z" },
      { updatedAt: "2026-05-13T00:00:00.000Z" }
    )).toBe(false);
    expect(shouldCacheRemoteRecord(
      { updatedAt: "2026-05-14T00:00:00.000Z" },
      { updatedAt: "2026-05-13T00:00:00.000Z" }
    )).toBe(true);
  });

  test("writes and batches through the same store interface used by runtime adapters", async () => {
    const { db, store: memory } = createMemoryDb();
    const hybrid = createCliHybridRecordStore({ db, env: {} });

    await hybrid.write("dialog-user-1-a", { id: "a" });
    await hybrid.batch([
      { type: "put", key: "dialog-a-msg-001", value: { role: "user" } },
      { type: "put", key: "dialog-a-msg-002", value: { role: "assistant" } },
    ]);

    expect(memory.get("dialog-user-1-a")).toEqual({ id: "a", dbKey: "dialog-user-1-a" });
    expect(memory.get("dialog-a-msg-001")).toEqual({ role: "user", dbKey: "dialog-a-msg-001" });
    expect(memory.get("dialog-a-msg-002")).toEqual({ role: "assistant", dbKey: "dialog-a-msg-002" });
  });
});
