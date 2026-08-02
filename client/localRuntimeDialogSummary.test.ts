import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearCliLocalRuntimePreparedAgentCache,
  createCliLocalRuntimeAdapter,
} from "./localRuntimeAdapter";
import { asTestKvDb } from "../cliTestMocks";

function createMemoryDb(initial: Record<string, any> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    db: asTestKvDb({
      get: async (key: string) => {
        if (!store.has(key)) throw new Error(`not found: ${key}`);
        return store.get(key);
      },
      put: async (key: string, value: any) => {
        store.set(key, value);
      },
      del: async (key: string) => {
        store.delete(key);
      },
      batch: async (ops: Array<{ type: "put"; key: string; value: any }>) => {
        for (const op of ops) {
          if (op.type === "put") store.set(op.key, op.value);
        }
      },
      iterator: ({ gte, lte }: { gte: string; lte?: string }) =>
        (async function* () {
          for (const entry of [...store.entries()].sort(([a], [b]) =>
            a.localeCompare(b),
          )) {
            if (entry[0] >= gte && (!lte || entry[0] <= lte)) yield entry;
          }
        })(),
    }),
  };
}

describe("CLI local runtime adapter dialog summary persistence", () => {
  beforeEach(() => {
    clearCliLocalRuntimePreparedAgentCache();
  });

  afterEach(() => {
    clearCliLocalRuntimePreparedAgentCache();
  });

  test("loadDialogSummary / saveDialogSummary round-trip on dialog record key", async () => {
    const { db, store } = createMemoryDb({
      "dialog-user-1-d1": {
        id: "d1",
        dbKey: "dialog-user-1-d1",
        type: "dialog",
        userId: "user-1",
        title: "existing",
      },
    });

    const adapter = createCliLocalRuntimeAdapter({
      env: { NOLO_LOCAL_USER_ID: "user-1" },
      db,
      fetchImpl: async () => new Response("not found", { status: 404 }),
    } as any);

    expect(await adapter.loadDialogSummary?.("d1")).toBeNull();

    await adapter.saveDialogSummary?.({
      dialogId: "d1",
      summary: "关键事实档案\n- path/a.ts",
      summarizedBeforeId: "local-12",
    });

    expect(await adapter.loadDialogSummary?.("d1")).toEqual({
      summary: "关键事实档案\n- path/a.ts",
      summarizedBeforeId: "local-12",
    });

    const record = store.get("dialog-user-1-d1");
    expect(record.title).toBe("existing");
    expect(record.summary).toBe("关键事实档案\n- path/a.ts");
    expect(record.summarizedBeforeId).toBe("local-12");
    expect(record.compressionCount).toBe(1);
    expect(record.summaryPending).toBe(false);
  });

  test("saveDialogSummary creates dialog record when missing", async () => {
    const { db, store } = createMemoryDb();
    const adapter = createCliLocalRuntimeAdapter({
      env: { NOLO_LOCAL_USER_ID: "user-1" },
      db,
      fetchImpl: async () => new Response("not found", { status: 404 }),
    } as any);

    await adapter.saveDialogSummary?.({
      dialogId: "fresh",
      summary: "new summary",
      summarizedBeforeId: "local-3",
    });

    expect(store.get("dialog-user-1-fresh")).toMatchObject({
      id: "fresh",
      dbKey: "dialog-user-1-fresh",
      type: "dialog",
      summary: "new summary",
      summarizedBeforeId: "local-3",
    });
  });
});
