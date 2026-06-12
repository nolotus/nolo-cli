import { describe, expect, test } from "bun:test";

import { executeLocalToolWithPolicy, resolveLocalToolPolicy } from "./localToolPolicy";

describe("CLI local tool policy", () => {
  test("allows execShell by default", () => {
    expect(resolveLocalToolPolicy({
      env: {},
      agentToolNames: [],
      toolName: "execShell",
    })).toEqual({ allowed: true, toolName: "execShell" });
  });

  test("allows execShell even without env allowlist", () => {
    expect(resolveLocalToolPolicy({
      env: { NOLO_LOCAL_ALLOWED_TOOLS: "execShell" },
      agentToolNames: ["execShell"],
      toolName: "execShell",
    })).toEqual({ allowed: true, toolName: "execShell" });
  });

  test("requires both env allowlist and agent declaration", () => {
    expect(resolveLocalToolPolicy({
      env: { NOLO_LOCAL_ALLOWED_TOOLS: "readFile" },
      agentToolNames: ["readFile"],
      toolName: "readFile",
    })).toEqual({ allowed: true, toolName: "readFile" });

    expect(resolveLocalToolPolicy({
      env: { NOLO_LOCAL_ALLOWED_TOOLS: "readFile" },
      agentToolNames: [],
      toolName: "readFile",
    })).toMatchObject({ allowed: false });
  });

  test("executes only registered tools after policy allows them", async () => {
    const result = await executeLocalToolWithPolicy({
      env: { NOLO_LOCAL_ALLOWED_TOOLS: "readFile" },
      agentToolNames: ["readFile"],
      call: { id: "call-1", name: "readFile", arguments: "{\"path\":\"README.md\"}" },
      executors: {
        readFile: async (call) => ({ content: `read:${call.arguments}` }),
      },
    });

    expect(result.content).toContain("README.md");
  });
});
