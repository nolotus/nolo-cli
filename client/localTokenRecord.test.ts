// @ts-nocheck — focused test for CLI-local token record persistence.
import { describe, expect, test } from "bun:test";
import { createCliLocalRuntimeAdapter } from "./localRuntimeAdapter";
import { createTokenKey } from "../database/keys";

/**
 * Minimal in-memory HybridRecordStore mock that captures all writes.
 */
function createMockStore(opts?: { failTokenWrite?: boolean }) {
  const records = new Map<string, any>();
  const batchOps: Array<{ type: "put"; key: string; value: any }> = [];
  const singleWrites: Array<{ key: string; value: any }> = [];

  const store = {
    read: async (key: string) => records.get(key) ?? null,
    write: async (key: string, value: any) => {
      if (opts?.failTokenWrite && key.startsWith("token-")) {
        throw new Error("simulated token write failure");
      }
      records.set(key, value);
      singleWrites.push({ key, value });
    },
    batch: async (ops: Array<{ type: "put"; key: string; value: any }>) => {
      for (const op of ops) {
        records.set(op.key, op.value);
        batchOps.push(op);
      }
    },
    iterator: async function* () {},
  };

  return { store, records, batchOps, singleWrites };
}

function createTestAdapter(store: any) {
  return createCliLocalRuntimeAdapter({
    env: { NOLO_LOCAL_USER_ID: "test-user-1" },
    cwd: "/tmp/nolo-token-test",
    store,
    fetchImpl: async () => new Response("{}", { status: 200 }),
  } as any);
}

function makeSaveTurnInput(usage?: Record<string, any>) {
  return {
    agentKey: "agent-test-user-1-test-agent",
    messages: [{ role: "user", content: "hello" }],
    result: {
      content: "world",
      model: "gpt-5.4",
      provider: "openai",
      ...(usage !== undefined ? { usage } : {}),
    },
  };
}

describe("CLI local token record persistence", () => {
  test("writes a token record with correct key layout when usage is present", async () => {
    const { store, singleWrites } = createMockStore();
    const adapter = createTestAdapter(store);

    const input = makeSaveTurnInput({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
    });

    const { dialogId } = await adapter.saveTurn(input);
    expect(dialogId).toBeTruthy();

    // Find the token record write
    const tokenWrite = singleWrites.find((w) => w.key.startsWith("token-"));
    expect(tokenWrite).toBeDefined();

    // Key layout matches createTokenKey.record(userId, timestamp)
    const keyParts = tokenWrite!.key.split("-");
    // key format: token-{userId}-{timestamp}
    expect(keyParts[0]).toBe("token");
    expect(keyParts[1]).toBe("test");
    expect(keyParts[2]).toBe("user");
    expect(keyParts[3]).toBe("1");
    // Last part is a numeric timestamp
    const timestampPart = keyParts.slice(4).join("-");
    expect(Number(timestampPart)).toBeGreaterThan(0);

    // Verify key matches createTokenKey.record layout
    const record = tokenWrite!.value;
    expect(record.type).toBe("token");
    expect(record.id).toBeTruthy();
    expect(record.userId).toBe("test-user-1");
    expect(record.dialogId).toBe(dialogId);
    expect(record.model).toBeTruthy();
    expect(record.input_tokens).toBe(100);
    expect(record.output_tokens).toBe(50);
    expect(record.cache_read_input_tokens).toBe(20);
  });

  test("billable is false for CLI local runs (apiSource=cli)", async () => {
    const { store, singleWrites } = createMockStore();
    const adapter = createTestAdapter(store);

    const input = makeSaveTurnInput({
      input_tokens: 200,
      output_tokens: 80,
      cost: 0.05,
    });

    await adapter.saveTurn(input);

    const tokenWrite = singleWrites.find((w) => w.key.startsWith("token-"));
    expect(tokenWrite).toBeDefined();
    // Critical billing safety: CLI local runs must NEVER be billable
    expect(tokenWrite!.value.billable).toBe(false);
  });

  test("entry_path is cli-local", async () => {
    const { store, singleWrites } = createMockStore();
    const adapter = createTestAdapter(store);

    const input = makeSaveTurnInput({
      input_tokens: 10,
      output_tokens: 5,
    });

    await adapter.saveTurn(input);

    const tokenWrite = singleWrites.find((w) => w.key.startsWith("token-"));
    expect(tokenWrite).toBeDefined();
    expect(tokenWrite!.value.entry_path).toBe("cli-local");
  });

  test("skips token record when usage is missing, dialog still saves", async () => {
    const { store, singleWrites, batchOps } = createMockStore();
    const adapter = createTestAdapter(store);

    // No usage field at all
    const input = makeSaveTurnInput(undefined);
    const { dialogId } = await adapter.saveTurn(input);

    expect(dialogId).toBeTruthy();
    // Dialog was written via batch
    expect(batchOps.length).toBeGreaterThan(0);
    // No token record written
    const tokenWrite = singleWrites.find((w) => w.key.startsWith("token-"));
    expect(tokenWrite).toBeUndefined();
  });

  test("skips token record when usage is empty object, dialog still saves", async () => {
    const { store, singleWrites, batchOps } = createMockStore();
    const adapter = createTestAdapter(store);

    const input = makeSaveTurnInput({});
    const { dialogId } = await adapter.saveTurn(input);

    expect(dialogId).toBeTruthy();
    expect(batchOps.length).toBeGreaterThan(0);
    const tokenWrite = singleWrites.find((w) => w.key.startsWith("token-"));
    expect(tokenWrite).toBeUndefined();
  });

  test("token write failure does not prevent dialog save", async () => {
    const { store, batchOps } = createMockStore({ failTokenWrite: true });
    const adapter = createTestAdapter(store);

    const input = makeSaveTurnInput({
      input_tokens: 100,
      output_tokens: 50,
    });

    // Must not throw despite token write failure
    const { dialogId } = await adapter.saveTurn(input);
    expect(dialogId).toBeTruthy();
    // Dialog batch still succeeded
    expect(batchOps.length).toBeGreaterThan(0);
  });
});
