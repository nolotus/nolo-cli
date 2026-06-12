import { describe, expect, test } from "bun:test";

import { resolveAgentRuntimeConfigFromRecord } from "./agentConfigResolver";

describe("agent config resolver", () => {
  test("keeps complete runtime-relevant agent config while normalizing tools", () => {
    const rawRecord = {
      dbKey: "agent-user-1-frontend",
      key: "agent-user-1-frontend",
      name: "Frontend implementer",
      prompt: "Fix UI carefully.",
      model: "gpt-5.4",
      provider: "openai",
      apiSource: "platform",
      cliProvider: "codex",
      customProviderUrl: "https://provider.example/v1",
      toolNames: ["legacyTool", "readFile"],
      tools: ["readFile", "editFile"],
      runtimeBinding: { machineId: "machine-1" },
      delegation: { target: "local" },
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 4096,
      reasoning_effort: "medium",
    };

    expect(resolveAgentRuntimeConfigFromRecord("agent-user-1-frontend", rawRecord)).toEqual({
      key: "agent-user-1-frontend",
      name: "Frontend implementer",
      prompt: "Fix UI carefully.",
      model: "gpt-5.4",
      provider: "openai",
      apiSource: "platform",
      cliProvider: "codex",
      customProviderUrl: "https://provider.example/v1",
      toolNames: ["legacyTool", "readFile", "editFile"],
      runtimeBinding: { machineId: "machine-1" },
      delegation: { target: "local" },
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 4096,
      reasoning_effort: "medium",
      rawRecord,
    });
  });

  test("falls back provider to apiSource and tools to tools", () => {
    expect(resolveAgentRuntimeConfigFromRecord("agent-user-1-cli", {
      apiSource: "cli",
      tools: ["execShell"],
    })).toMatchObject({
      key: "agent-user-1-cli",
      provider: "cli",
      apiSource: "cli",
      toolNames: ["execShell"],
    });
  });

  test("returns a minimal config for sparse records", () => {
    expect(resolveAgentRuntimeConfigFromRecord("agent-user-1-empty", {
      dbKey: "agent-user-1-empty",
    })).toEqual({
      key: "agent-user-1-empty",
      rawRecord: {
        dbKey: "agent-user-1-empty",
      },
    });
  });
});
