import { describe, expect, test } from "bun:test";

import {
  createLocalRuntimeBoundary,
  summarizeRuntimeBoundary,
} from "./runtimeBoundary";

describe("public local runtime boundary", () => {
  test("describes a no-login repository-local runtime boundary", () => {
    expect(createLocalRuntimeBoundary({
      command: "run",
      workspace: "/repo/project",
      shell: "prompted",
      provider: "codex-cli",
    })).toEqual({
      command: "run",
      workspace: "/repo/project",
      provider: "codex-cli",
      requiresNoloAuth: false,
      credentialBoundary: "local-provider",
      shell: {
        policy: "prompted",
        scope: "workspace",
      },
      persistence: {
        localDialog: true,
        remoteSync: false,
      },
    });
  });

  test("summarizes desktop local mode without implying hosted sync", () => {
    expect(summarizeRuntimeBoundary(createLocalRuntimeBoundary({
      command: "desktop",
      workspace: "/repo/project",
      shell: "disabled",
      provider: "openai",
    }))).toContain("desktop uses openai locally in /repo/project without Nolo auth");
  });
});
