import { describe, expect, test } from "bun:test";

import {
  buildLocalDialogWritePlan,
  localDialogMessageRecordToRuntimeMessage,
} from "./localDialogRecords";

describe("CLI local dialog records", () => {
  test("converts persisted dialog message records into runtime messages", () => {
    expect(localDialogMessageRecordToRuntimeMessage({
      role: "assistant",
      content: "previous answer",
      tool_calls: [{ id: "call-1", type: "function", function: { name: "x", arguments: "{}" } }],
    })).toEqual({
      role: "assistant",
      content: "previous answer",
      tool_calls: [{ id: "call-1", type: "function", function: { name: "x", arguments: "{}" } }],
    });

    expect(localDialogMessageRecordToRuntimeMessage({
      role: "tool",
      content: "file contents",
      toolCallId: "call-1",
    })).toEqual({
      role: "tool",
      content: "file contents",
      tool_call_id: "call-1",
    });

    expect(localDialogMessageRecordToRuntimeMessage({ role: "system", content: "skip" })).toBeNull();
    expect(localDialogMessageRecordToRuntimeMessage({ role: "unknown", content: "skip" })).toBeNull();
  });

  test("builds dialog meta and message write ops for a local turn", () => {
    const plan = buildLocalDialogWritePlan({
      input: {
        agentKey: "agent-user-1-frontend",
        messages: [
          { role: "system", content: "System prompt" },
          { role: "user", content: "make it cleaner" },
          { role: "assistant", content: "done" },
        ],
        result: {
          content: "done",
          model: "custom-coder",
          provider: "custom",
          usage: { prompt_tokens: 4, completion_tokens: 3 },
          toolCallCount: 1,
        },
      },
      userId: "user-1",
      now: 1710000000000,
      createId: () => "01LOCAL",
      cwd: "/repo/.worktrees/task",
    });

    expect(plan.dialogId).toBe("01LOCAL");
    expect(plan.ops.map((op) => op.key)).toEqual([
      "dialog-user-1-01LOCAL",
      "dialog-01LOCAL-msg-1710000000000-001",
      "dialog-01LOCAL-msg-1710000000000-002",
    ]);
    expect(plan.ops[0]?.value).toMatchObject({
      id: "01LOCAL",
      dbKey: "dialog-user-1-01LOCAL",
      type: "dialog",
      userId: "user-1",
      cybots: ["agent-user-1-frontend"],
      primaryAgentKey: "agent-user-1-frontend",
      title: "make it cleaner",
      status: "done",
      triggerType: "cli-local",
      executionMode: "foreground",
      createdAt: "2024-03-09T16:00:00.000Z",
      updatedAt: "2024-03-09T16:00:00.000Z",
      finishedAt: 1710000000000,
      usage: { prompt_tokens: 4, completion_tokens: 3 },
      toolCallCount: 1,
      localRuntime: {
        host: "cli",
        worktreePath: "/repo/.worktrees/task",
      },
    });
    expect(plan.ops[1]?.value).toMatchObject({
      id: "1710000000000-001",
      dbKey: "dialog-01LOCAL-msg-1710000000000-001",
      dialogId: "01LOCAL",
      role: "user",
      content: "make it cleaner",
      userId: "user-1",
    });
    expect(plan.ops[2]?.value).toMatchObject({
      role: "assistant",
      content: "done",
      agentKey: "agent-user-1-frontend",
      cybotKey: "agent-user-1-frontend",
    });
  });

  test("preserves existing dialog title and createdAt when continuing", () => {
    const plan = buildLocalDialogWritePlan({
      input: {
        agentKey: "agent-user-1-frontend",
        continueDialogId: "dialog-existing",
        messages: [{ role: "user", content: "new task" }],
        result: { content: "ok", model: "gpt-4.1-mini", provider: "openai" },
      },
      existingDialog: {
        title: "Existing title",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      userId: "user-1",
      now: 1710000000000,
      createId: () => "unused",
    });

    expect(plan.dialogId).toBe("dialog-existing");
    expect(plan.ops[0]?.value).toMatchObject({
      title: "Existing title",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-03-09T16:00:00.000Z",
    });
  });
});
