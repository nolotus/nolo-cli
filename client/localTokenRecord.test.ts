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

function createTestAdapter(store: any, options?: {
  env?: Record<string, string>;
  fetchImpl?: any;
  now?: () => number;
}) {
  return createCliLocalRuntimeAdapter({
    env: { NOLO_LOCAL_USER_ID: "test-user-1", ...options?.env },
    cwd: "/tmp/nolo-token-test",
    store,
    now: options?.now,
    fetchImpl: options?.fetchImpl ?? (async () => new Response("{}", { status: 200 })),
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

    // Key layout is stable across time and anchored only by provider call id.
    const keyParts = tokenWrite!.key.split("-");
    // key format: token-{userId}-{timestamp}
    expect(keyParts[0]).toBe("token");
    expect(keyParts[1]).toBe("test");
    expect(keyParts[2]).toBe("user");
    expect(keyParts[3]).toBe("1");
    expect(keyParts[4]).toBe("call");
    expect(keyParts.slice(5).join("-")).toBeTruthy();

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

  test("uses the shared billing matrix for platform, custom, CLI and OAuth calls", async () => {
    const cases = [
      { billingConfig: { apiSource: "platform" }, expected: true },
      { billingConfig: { apiSource: "custom" }, expected: false },
      { billingConfig: { apiSource: "cli" }, expected: false },
      {
        billingConfig: { apiSource: "platform", apiKeyRef: "chatgpt" },
        expected: false,
      },
    ];

    for (const item of cases) {
      const { store, singleWrites } = createMockStore();
      const adapter = createTestAdapter(store);
      await adapter.saveTurn({
        ...makeSaveTurnInput({ input_tokens: 1_000_000, output_tokens: 1_000_000 }),
        result: {
          ...makeSaveTurnInput({ input_tokens: 1_000_000, output_tokens: 1_000_000 }).result,
          model: "gpt-5.5",
        },
        billingConfig: {
          model: "gpt-5.5",
          provider: "openai",
          ...item.billingConfig,
        },
      } as any);
      const tokenWrite = singleWrites.find((write) => write.key.startsWith("token-"));
      expect(tokenWrite?.value.billable).toBe(item.expected);
    }
  });

  test("uploads every provider call with unique same-ms keys for idempotent server projection", async () => {
    const { store, singleWrites } = createMockStore();
    const requests: Array<{ customKey?: string; data?: any }> = [];
    const adapter = createTestAdapter(store, {
      env: { NOLO_SERVER: "https://nolo.test", AUTH_TOKEN: "token" },
      now: () => 1710000000000,
      fetchImpl: async (_url: string, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        return new Response("{}", { status: 200 });
      },
    });

    await adapter.saveTurn({
      ...makeSaveTurnInput(),
      billingConfig: { model: "gpt-5.5", provider: "openai", apiSource: "platform" },
      usageRecords: [
        {
          callId: "server-call",
          model: "gpt-5.5",
          provider: "openai",
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            server_billed: true,
            provider_call_id: "server-call",
          },
        },
        {
          callId: "client-call",
          model: "gpt-5.5",
          provider: "openai",
          usage: { input_tokens: 20, output_tokens: 4 },
        },
      ],
    } as any);

    expect(singleWrites.filter((write) => write.key.startsWith("token-"))).toHaveLength(2);
    const remoteTokens = requests.filter((request) => request.customKey?.startsWith("token-"));
    expect(remoteTokens).toHaveLength(2);
    expect(new Set(remoteTokens.map((request) => request.customKey)).size).toBe(2);
    expect(new Set(remoteTokens.map((request) => request.data.timestamp)).size).toBe(1);
    expect(remoteTokens.map((request) => request.data.billable)).toEqual([true, true]);
  });

  test("reuses the same detail key when a call is retried at a later time", async () => {
    const { store, singleWrites } = createMockStore();
    const adapter = createTestAdapter(store);
    const originalNow = Date.now;
    try {
      Date.now = () => 1710000000000;
      const input = {
        ...makeSaveTurnInput(),
        usageRecords: [{
          callId: "retry-call",
          model: "gpt-5.5",
          provider: "openai",
          usage: { input_tokens: 10, output_tokens: 2 },
        }],
      } as any;
      await adapter.saveTurn(input);
      Date.now = () => 1710003600000;
      await adapter.saveTurn(input);
    } finally {
      Date.now = originalNow;
    }
    const tokenKeys = singleWrites
      .filter((write) => write.key.startsWith("token-"))
      .map((write) => write.key);
    expect(tokenKeys).toEqual([
      createTokenKey.recordForStableCall("test-user-1", "retry-call"),
      createTokenKey.recordForStableCall("test-user-1", "retry-call"),
    ]);
    const range = createTokenKey.rangeOfUser("test-user-1");
    expect(tokenKeys[0] >= range.start && tokenKeys[0] <= range.end).toBe(true);
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
