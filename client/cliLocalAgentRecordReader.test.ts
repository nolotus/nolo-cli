import { describe, expect, test } from "bun:test";

import { readAgentFromStore } from "./cliLocalAgentRecordReader";
import { resolveBuiltinPlatformAgentConfig } from "../agent-runtime/builtinPlatformAgentConfigs";
import {
  PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
  PUBLIC_KIMI_K26_IMAGE_AGENT_KEY,
} from "../core/builtinAgents";
import { NOLO_DEFAULT_AGENT_KEY } from "../agentAliases";

const emptyStore = {
  read: async () => null,
  iterator: async function* () {},
} as any;

describe("readAgentFromStore builtin platform agent fallback", () => {
  test("returns nolo-hosted flash config when store misses the flash tier key", async () => {
    const config = await readAgentFromStore({
      store: emptyStore,
      agentRef: PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
      userId: "user-1",
    });
    expect(config).not.toBeNull();
    expect(config).toMatchObject({
      key: PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
      provider: "nolo",
      model: "deepseek-v4-flash",
      apiSource: "platform",
      useServerProxy: true,
    });
  });

  test("returns nolo-hosted Kimi K2.6 config for the image tier", async () => {
    const config = await readAgentFromStore({
      store: emptyStore,
      agentRef: PUBLIC_KIMI_K26_IMAGE_AGENT_KEY,
      userId: "user-1",
    });
    expect(config).not.toBeNull();
    expect(config).toMatchObject({
      key: PUBLIC_KIMI_K26_IMAGE_AGENT_KEY,
      provider: "nolo",
      model: "kimi-k2.6",
      apiSource: "platform",
      useServerProxy: true,
    });
  });

  test("returns platform config for the builtin nolo agent key", async () => {
    const config = await readAgentFromStore({
      store: emptyStore,
      agentRef: NOLO_DEFAULT_AGENT_KEY,
      userId: "user-1",
    });
    expect(config).not.toBeNull();
    expect(config).toMatchObject({
      key: NOLO_DEFAULT_AGENT_KEY,
      apiSource: "platform",
      useServerProxy: true,
    });
  });

  test("returns null for unknown non-builtin agent refs when store misses", async () => {
    const config = await readAgentFromStore({
      store: emptyStore,
      agentRef: "agent-unknown-custom",
      userId: "user-1",
    });
    expect(config).toBeNull();
  });
});

describe("resolveBuiltinPlatformAgentConfig", () => {
  test("returns null for unknown agent keys", () => {
    expect(resolveBuiltinPlatformAgentConfig("agent-unknown")).toBeNull();
    expect(resolveBuiltinPlatformAgentConfig("")).toBeNull();
  });
});

describe("readAgentFromStore key lookup", () => {
  test("returns config from store when a candidate key matches", async () => {
    const key = "agent-user-1-my-helper";
    const record = {
      type: "agent",
      id: "my-helper",
      userId: "user-1",
      name: "My Helper",
      model: "deepseek-v4-flash",
      apiSource: "cli",
      provider: "cli",
    };
    const store = {
      read: async (k: string) => (k === key ? record : null),
      iterator: async function* () {
        throw new Error("iterator should not be touched on key-hit");
      },
    } as any;
    const config = await readAgentFromStore({
      store,
      agentRef: key,
      userId: "user-1",
    });
    expect(config).not.toBeNull();
    expect(config).toMatchObject({
      key,
      name: "My Helper",
      model: "deepseek-v4-flash",
    });
  });

  test("misses handle-matched record whose key segment differs (handle scan removed)", async () => {
    // Key lookup for a concrete ref misses; the record is only reachable via
    // the old handle-scan path. With the scan removed it must NOT be found,
    // and the iterator must never be consulted.
    const ref = "agent-user-1-some-alias";
    const handleMatchedRecord = {
      type: "agent",
      id: "other-key",
      name: "Handle Only Agent",
      handle: "some-alias",
      model: "deepseek-v4-flash",
      apiSource: "cli",
      provider: "cli",
    };
    const store = {
      read: async () => null,
      iterator: async function* () {
        throw new Error("iterator should not be touched: handle scan removed");
      },
    } as any;
    const config = await readAgentFromStore({
      store,
      agentRef: ref,
      userId: "user-1",
    });
    // Key miss + not a builtin ref → null (fallback also null). The record
    // whose handle matches but whose dbKey segment differs is deliberately
    // no longer reachable.
    expect(config).toBeNull();
  });

  test("reads agent records local-first (no forced remote flag on read)", async () => {
    // Execution must not force remote reads for agent keys: local cache hits
    // are used directly, and on local miss the hybrid store's default
    // (remote fallback + local caching) applies. So read must be called
    // WITHOUT { remote: true }.
    const calls: Array<{ key: string; remote?: boolean }> = [];
    const store = {
      read: async (key: string, options?: { remote?: boolean }) => {
        calls.push({ key, remote: options?.remote });
        return null;
      },
      iterator: async function* () {},
    } as any;
    await readAgentFromStore({
      store,
      agentRef: "agent-user-1-my-helper",
      userId: "user-1",
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.remote).toBeUndefined();
    }
  });

  test("uses the local cached record on local-first hit", async () => {
    const key = "agent-user-1-my-helper";
    const localRecord = {
      type: "agent",
      id: "my-helper",
      userId: "user-1",
      name: "Cached Helper",
      model: "deepseek-v4-flash",
      apiSource: "cli",
      provider: "cli",
    };
    const store = {
      read: async (k: string) => (k === key ? localRecord : null),
      iterator: async function* () {},
    } as any;
    const config = await readAgentFromStore({
      store,
      agentRef: key,
      userId: "user-1",
    });
    expect(config).not.toBeNull();
    expect(config).toMatchObject({
      key,
      name: "Cached Helper",
      model: "deepseek-v4-flash",
    });
  });
});