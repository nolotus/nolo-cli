import { describe, expect, test } from "bun:test";

import { readAgentFromStore } from "./cliLocalAgentRecordReader";
import { resolveBuiltinPlatformAgentConfig } from "../agent-runtime/builtinPlatformAgentConfigs";
import {
  PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
  PUBLIC_DEEPSEEK_V4_PRO_AGENT_KEY,
  PUBLIC_GLM_52_AGENT_KEY,
  PUBLIC_KIMI_K26_IMAGE_AGENT_KEY,
  PUBLIC_KIMI_K27_CODING_AGENT_KEY,
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

  test("returns deepseek provider/model for pro tier", async () => {
    const config = await readAgentFromStore({
      store: emptyStore,
      agentRef: PUBLIC_DEEPSEEK_V4_PRO_AGENT_KEY,
      userId: "user-1",
    });
    expect(config).not.toBeNull();
    expect(config).toMatchObject({
      key: PUBLIC_DEEPSEEK_V4_PRO_AGENT_KEY,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      apiSource: "platform",
      useServerProxy: true,
    });
  });

  test("returns nolo-hosted GLM 5.2 config for the quality tier", async () => {
    const config = await readAgentFromStore({
      store: emptyStore,
      agentRef: PUBLIC_GLM_52_AGENT_KEY,
      userId: "user-1",
    });
    expect(config).not.toBeNull();
    expect(config).toMatchObject({
      key: PUBLIC_GLM_52_AGENT_KEY,
      provider: "nolo",
      model: "glm-5.2",
      apiSource: "platform",
      useServerProxy: true,
    });
  });

  test("returns ollama-cloud Kimi K2.6 config for the image tier", async () => {
    const config = await readAgentFromStore({
      store: emptyStore,
      agentRef: PUBLIC_KIMI_K26_IMAGE_AGENT_KEY,
      userId: "user-1",
    });
    expect(config).not.toBeNull();
    expect(config).toMatchObject({
      key: PUBLIC_KIMI_K26_IMAGE_AGENT_KEY,
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      apiSource: "platform",
      useServerProxy: true,
    });
  });

  test("returns ollama-cloud Kimi K2.7 Coding config", async () => {
    const config = await readAgentFromStore({
      store: emptyStore,
      agentRef: PUBLIC_KIMI_K27_CODING_AGENT_KEY,
      userId: "user-1",
    });
    expect(config).not.toBeNull();
    expect(config).toMatchObject({
      key: PUBLIC_KIMI_K27_CODING_AGENT_KEY,
      provider: "ollama-cloud",
      model: "kimi-k2.7-code",
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