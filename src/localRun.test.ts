import { describe, expect, test } from "bun:test";

import {
  LOCAL_CODEX_AGENT_KEY,
  formatLocalRunUsage,
  parseLocalRunArgs,
} from "./localRun";

describe("public no-login local run parser", () => {
  test("parses nolo run shorthand as local Codex without Nolo auth", () => {
    expect(parseLocalRunArgs(["review this repository"], { command: "run" })).toEqual({
      agentKey: LOCAL_CODEX_AGENT_KEY,
      message: "review this repository",
      runtimeMode: "local",
      requiresNoloAuth: false,
      cwd: undefined,
      eventsMode: undefined,
    });
  });

  test("parses nolo chat shorthand as local Codex without Nolo auth", () => {
    expect(parseLocalRunArgs(["triage install issues"], { command: "chat" })).toMatchObject({
      agentKey: LOCAL_CODEX_AGENT_KEY,
      message: "triage install issues",
      runtimeMode: "local",
      requiresNoloAuth: false,
    });
  });

  test("keeps explicit agent runs distinct from no-login shorthand", () => {
    expect(parseLocalRunArgs([
      "--agent",
      "frontend-implementer",
      "--msg",
      "review the UI change",
      "--cwd",
      "/repo/project",
      "--events",
      "jsonl",
    ], { command: "chat" })).toEqual({
      agentKey: "frontend-implementer",
      message: "review the UI change",
      runtimeMode: "remote-or-configured",
      requiresNoloAuth: true,
      cwd: "/repo/project",
      eventsMode: "jsonl",
    });
  });

  test("returns null for empty run input and exposes no-login usage", () => {
    expect(parseLocalRunArgs([], { command: "run" })).toBeNull();
    expect(formatLocalRunUsage("run")).toContain("Usage: nolo run <message>");
    expect(formatLocalRunUsage("run")).toContain("no Nolo login required");
  });
});
