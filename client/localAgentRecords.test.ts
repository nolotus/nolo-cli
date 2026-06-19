import { describe, expect, test } from "bun:test";

import {
  buildLocalAgentLookupKeys,
  shouldReadAgentKeyRemotely,
} from "./localAgentRecords";

describe("CLI local agent records", () => {
  test("builds user-scoped agent lookup keys for handles", () => {
    expect(buildLocalAgentLookupKeys({
      agentRef: "frontend",
      userId: "user-1",
    })).toEqual([
      "agent-user-1-frontend",
      "cybot-user-1-frontend",
    ]);
  });

  test("only remote reads concrete agent or cybot keys", () => {
    expect(shouldReadAgentKeyRemotely("agent-user-1-frontend")).toBe(true);
    expect(shouldReadAgentKeyRemotely("agent-pub-01ABC")).toBe(true);
    expect(shouldReadAgentKeyRemotely("cybot-user-1-frontend")).toBe(true);
    expect(shouldReadAgentKeyRemotely("frontend")).toBe(false);
    expect(shouldReadAgentKeyRemotely("dialog-user-1-frontend")).toBe(false);
  });
});
