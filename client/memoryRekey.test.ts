import { describe, expect, test, mock } from "bun:test";
import { performLocalMemoryRekey } from "./memoryRekey";
import { createMemoryKey, createMemoryOwnerIndexKey } from "../database/keys";
import type { MemoryItem } from "../ai/memory/types";

const MACHINE_ID = "machine-test-001";
const AUTH_TOKEN = "test-token.jwt.sig";
const SERVER_URL = "https://nolo.test";

/** Build a complete MemoryItem with sensible defaults for tests. */
function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: overrides.id ?? "01TESTMEM0000000000001",
    ownerType: "user",
    ownerId: overrides.ownerId ?? MACHINE_ID,
    visibility: "private",
    subjectType: "user",
    subjectId: overrides.subjectId ?? MACHINE_ID,
    kind: "episodic",
    content: overrides.content ?? "test memory content",
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    lastActivatedAt: overrides.lastActivatedAt ?? "2024-01-01T00:00:00.000Z",
    activationCount: 1,
    importance: 0.5,
    confidence: 0.8,
    ...overrides,
  };
}

/**
 * Minimal in-memory mock of a LevelDB-like object with iterator + get + batch.
 * Stores items in a Map keyed by createMemoryKey / createMemoryOwnerIndexKey.
 */
function makeMockDb(initialItems: MemoryItem[] = []) {
  const data = new Map<string, any>();
  const deleteSpy = mock(async () => ({}));

  for (const item of initialItems) {
    data.set(
      createMemoryKey(item.ownerType, item.ownerId, item.id),
      item
    );
    data.set(
      createMemoryOwnerIndexKey(
        item.ownerType,
        item.ownerId,
        item.createdAt,
        item.id
      ),
      { memoryId: item.id }
    );
  }

  const db = {
    get: mock(async (key: string) => {
      if (!data.has(key)) {
        const err: any = new Error("NOT_FOUND");
        err.code = "LEVEL_NOT_FOUND";
        throw err;
      }
      return data.get(key);
    }),

    iterator: mock(() => {
      const entries = [...data.entries()]
        .filter(([k]) => k.startsWith("memidx-owner-"))
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .reverse();
      let idx = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              if (idx >= entries.length) return { done: true, value: undefined };
              const [, value] = entries[idx];
              idx++;
              return { done: false, value: [undefined, value] };
            },
          };
        },
      };
    }),

    batch: mock(() => ({
      del: mock((key: string) => {
        data.delete(key);
      }),
      write: deleteSpy,
    })),
  };

  return { db, data, deleteSpy };
}

function makeOkResponse(body: any): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeErrorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: { message, code: "TEST_ERROR" } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

describe("performLocalMemoryRekey", () => {
  test("(a) empty local db → returns {migrated:0, merged:0}, no fetch, no delete", async () => {
    const { db, deleteSpy } = makeMockDb([]);
    const fetchImpl = mock(async () => makeOkResponse({}));

    const result = await performLocalMemoryRekey({
      localDb: db,
      authToken: AUTH_TOKEN,
      serverUrl: SERVER_URL,
      machineId: MACHINE_ID,
      fetchImpl: fetchImpl as any,
    });

    expect(result).toEqual({ migrated: 0, merged: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test("(b) items present → POST /api/memory/rekey with auth+items; 2xx → delete by snapshotIds", async () => {
    const item1 = makeItem({ id: "01TESTMEM0000000000001" });
    const item2 = makeItem({ id: "01TESTMEM0000000000002" });
    const { db, deleteSpy } = makeMockDb([item1, item2]);

    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = mock(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return makeOkResponse({ success: true, migratedCount: 2, mergedCount: 0 });
    });

    const result = await performLocalMemoryRekey({
      localDb: db,
      authToken: AUTH_TOKEN,
      serverUrl: SERVER_URL,
      machineId: MACHINE_ID,
      fetchImpl: fetchImpl as any,
    });

    expect(result).toEqual({ migrated: 2, merged: 0 });

    // Verify fetch was called with correct URL, auth header, and items body
    expect(capturedUrl).toBe(`${SERVER_URL}/api/memory/rekey`);
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i: MemoryItem) => i.id)).toContain(item1.id);
    expect(body.items.map((i: MemoryItem) => i.id)).toContain(item2.id);

    // Delete should have been called (batch.write)
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  test("(c) upload non-2xx → does NOT delete local (data safety)", async () => {
    const item1 = makeItem({ id: "01TESTMEM0000000000001" });
    const { db, deleteSpy } = makeMockDb([item1]);

    const fetchImpl = mock(async () =>
      makeErrorResponse(500, "Internal server error")
    );

    await expect(
      performLocalMemoryRekey({
        localDb: db,
        authToken: AUTH_TOKEN,
        serverUrl: SERVER_URL,
        machineId: MACHINE_ID,
        fetchImpl: fetchImpl as any,
      })
    ).rejects.toThrow(/HTTP 500/);

    // Critical: local data must survive a failed upload
    expect(deleteSpy).not.toHaveBeenCalled();
    // The item should still be in the db
    const remaining = await db.get(
      createMemoryKey("user", MACHINE_ID, item1.id)
    );
    expect(remaining).toBeDefined();
  });

  test("(d) delete only removes snapshotIds — items added after snapshot survive", async () => {
    // Start with 2 items in the db
    const item1 = makeItem({ id: "01TESTMEM0000000000001" });
    const item2 = makeItem({ id: "01TESTMEM0000000000002" });
    const { db, data, deleteSpy } = makeMockDb([item1, item2]);

    // Simulate a background remember writing a NEW item (new ulid) between
    // scan and delete — inject it into the db's data map during the fetch
    // call (after scan has already captured snapshotIds).
    const newItem = makeItem({ id: "01NEWMEM0000000000099" });
    const fetchImpl = mock(async () => {
      // Background write happens here — after scan, before delete
      data.set(
        createMemoryKey("user", MACHINE_ID, newItem.id),
        newItem
      );
      data.set(
        createMemoryOwnerIndexKey(
          "user",
          MACHINE_ID,
          newItem.createdAt,
          newItem.id
        ),
        { memoryId: newItem.id }
      );
      return makeOkResponse({ success: true, migratedCount: 2, mergedCount: 0 });
    });

    await performLocalMemoryRekey({
      localDb: db,
      authToken: AUTH_TOKEN,
      serverUrl: SERVER_URL,
      machineId: MACHINE_ID,
      fetchImpl: fetchImpl as any,
    });

    // Delete batch should have been called once
    expect(deleteSpy).toHaveBeenCalledTimes(1);

    // The two snapshot items should be gone...
    await expect(
      db.get(createMemoryKey("user", MACHINE_ID, item1.id))
    ).rejects.toThrow();
    await expect(
      db.get(createMemoryKey("user", MACHINE_ID, item2.id))
    ).rejects.toThrow();

    // ...but the new item (not in snapshotIds) must survive
    const survivor = await db.get(
      createMemoryKey("user", MACHINE_ID, newItem.id)
    );
    expect(survivor).toBeDefined();
    expect(survivor.id).toBe(newItem.id);
  });
});