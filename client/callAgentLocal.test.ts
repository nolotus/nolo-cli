import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearCliLocalRuntimePreparedAgentCache,
  createCliCallAgentToolExecutor,
} from "./localRuntimeAdapter";
import type { AgentRuntimeHostAdapter } from "../agentRuntimeLocal";
import type { LocalAgentTurnResult } from "../agent-runtime/localLoop";

function createMockStore() {
  const records = new Map<string, any>();
  return {
    records,
    read: async (key: string) => records.get(key) ?? null,
    write: async (key: string, value: any) => {
      records.set(key, value);
      return value;
    },
    batch: async (ops: Array<{ type: "put"; key: string; value: any }>) => {
      for (const op of ops) {
        records.set(op.key, op.value);
      }
    },
    iterator: async function* () {
      for (const [key, value] of records) {
        yield [key, value];
      }
    },
  };
}

function createMockAdapter(
  overrides: Partial<AgentRuntimeHostAdapter> = {},
): AgentRuntimeHostAdapter {
  return {
    host: "cli",
    capabilities: [
      "leveldb-agent-config",
      "local-provider",
      "leveldb-persistence",
      "local-tools",
    ],
    loadAgentConfig: async () => ({
      key: "agent-child",
      name: "Child Agent",
      prompt: "You are a child agent.",
      toolNames: ["readFile"],
    }),
    loadDialogHistory: async () => [],
    saveTurn: async () => ({ dialogId: "dialog-child" }),
    resolveProvider: async (agentConfig) => ({
      model: "mock-model",
      complete: async () => ({
        content: "mock completion",
        model: "mock-model",
      }),
    }),
    executeTool: async (call) => ({
      content: JSON.stringify({ result: call.name }),
      metadata: {},
    }),
    ...overrides,
  };
}

describe("CLI local callAgent inheritance", () => {
  beforeEach(() => {
    clearCliLocalRuntimePreparedAgentCache();
  });

  const source = readFileSync(
    join(import.meta.dir, "localRuntimeAdapter.ts"),
    "utf8",
  );
  const agentRunSource = readFileSync(
    join(import.meta.dir, "agentRun.ts"),
    "utf8",
  );

  it("exposes callAgent schema in the local tool surface", () => {
    expect(source).toMatch(
      /toolNameSet\.has\("callAgent"\)\s*\?\s*prepareTools\(\["callAgent"\]\)/,
    );
  });

  it("includes callAgent in local policy tool names when declared", () => {
    expect(source).toContain(
      'if (name === "callAgent") extra.push("callAgent")',
    );
  });

  it("preallocates the parent dialog id and builds a fresh child adapter", () => {
    expect(agentRunSource).toContain(
      "const currentDialogId = options.continueDialogId ?? ulid();",
    );
    expect(agentRunSource).toContain("continueDialogId: currentDialogId");
    expect(agentRunSource).toContain("createFreshChildBaseAdapter");
    expect(agentRunSource).toContain("base: createFreshChildBaseAdapter()");
    expect(source).toContain("createChildAdapter:");
    expect(source).toContain("adapter: childAdapter");
  });

  it("callAgent executor requires agentKey and task", async () => {
    const store = createMockStore();
    const adapter = createMockAdapter();
    const executor = createCliCallAgentToolExecutor(
      {
        env: { NOLO_LOCAL_USER_ID: "user-test" },
        cwd: "/workspace",
        store: store as any,
      },
      {
        createChildAdapter: () => adapter,
        runChildTurn: async () =>
          ({ content: "ok", dialogId: "dialog-child" }) as LocalAgentTurnResult,
      },
    );

    const missingAgentKey = await executor({
      id: "call-1",
      name: "callAgent",
      arguments: JSON.stringify({ task: "do something" }),
    });
    expect(JSON.parse(missingAgentKey.content)).toEqual({
      error: "callAgent: agentKey is required",
    });

    const missingTask = await executor({
      id: "call-2",
      name: "callAgent",
      arguments: JSON.stringify({ agentKey: "agent-child" }),
    });
    expect(JSON.parse(missingTask.content)).toEqual({
      error: "callAgent: task is required",
    });
  });

  it("callAgent executor rejects agents outside allowedChildAgentKeys", async () => {
    const store = createMockStore();
    const adapter = createMockAdapter();
    const executor = createCliCallAgentToolExecutor(
      {
        env: { NOLO_LOCAL_USER_ID: "user-test" },
        cwd: "/workspace",
        store: store as any,
      },
      {
        createChildAdapter: () => adapter,
        runChildTurn: async () =>
          ({ content: "ok", dialogId: "dialog-child" }) as LocalAgentTurnResult,
        runtimeContext: {
          allowedChildAgentKeys: ["agent-allowed"],
        },
      },
    );

    const result = await executor({
      id: "call-1",
      name: "callAgent",
      arguments: JSON.stringify({
        agentKey: "agent-disallowed",
        task: "do something",
      }),
    });
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("not allowed");
    expect(parsed.agentKey).toBe("agent-disallowed");
    expect(parsed.allowedChildAgentKeys).toEqual(["agent-allowed"]);
  });

  it("foreground callAgent creates a pending child dialog, runs the child, and returns the result", async () => {
    const store = createMockStore();
    const parentAdapter = createMockAdapter();
    const childAdapter = createMockAdapter();
    let childInput: any = null;
    let childAdapterContext: any = null;
    const executor = createCliCallAgentToolExecutor(
      {
        env: { NOLO_LOCAL_USER_ID: "user-test" },
        cwd: "/workspace",
        store: store as any,
        createId: () => "dialog-child-123",
      },
      {
        createChildAdapter: (context) => {
          childAdapterContext = context;
          return childAdapter;
        },
        dialogId: "dialog-parent",
        spaceId: "space-parent",
        runtimeContext: {
          allowedChildAgentKeys: ["agent-child"],
          parentThreadId: "dialog-parent",
          rootThreadId: "dialog-root",
        },
        runChildTurn: async (input) => {
          childInput = input;
          return {
            content: "child done",
            model: "mock-model",
            provider: "mock-provider",
            usage: { input_tokens: 10, output_tokens: 5 },
            dialogId: "dialog-child-123",
          } as LocalAgentTurnResult;
        },
      },
    );

    const result = await executor({
      id: "call-1",
      name: "callAgent",
      arguments: JSON.stringify({
        agentKey: "agent-child",
        task: "child task",
        input: { key: "value" },
      }),
    });

    // Pending dialog was persisted before the child run.
    const pendingRecord = store.records.get(
      "dialog-user-test-dialog-child-123",
    );
    expect(pendingRecord).toBeDefined();
    expect(pendingRecord.status).toBe("pending");
    expect(pendingRecord.executionMode).toBe("foreground");
    expect(pendingRecord.primaryAgentKey).toBe("agent-child");
    expect(pendingRecord.parentDialogId).toBe("dialog-parent");
    expect(pendingRecord.rootDialogId).toBe("dialog-root");
    expect(pendingRecord.spaceId).toBe("space-parent");
    expect(pendingRecord.localRuntime).toMatchObject({
      host: "cli",
      workspaceRoot: "/workspace",
      workspaceKind: "current",
      workspaceAccess: "inherited",
    });

    // Child run inherited workspace and lineage context.
    expect(childInput).not.toBeNull();
    expect(childInput.adapter).toBe(childAdapter);
    expect(childInput.adapter).not.toBe(parentAdapter);
    expect(childAdapterContext).toMatchObject({
      dialogId: "dialog-child-123",
      spaceId: "space-parent",
    });
    expect(childInput.agentRef).toBe("agent-child");
    expect(childInput.continueDialogId).toBe("dialog-child-123");
    expect(childInput.spaceId).toBe("space-parent");
    expect(childInput.runtimeContext.surface).toBe("cli");
    expect(childInput.runtimeContext.entrypoint).toBe("agent-tool:callAgent");
    expect(childInput.runtimeContext.parentThreadId).toBe("dialog-parent");
    expect(childInput.runtimeContext.rootThreadId).toBe("dialog-root");
    expect(childInput.runtimeContext.workspaceRoot).toBe("/workspace");
    expect(childInput.runtimeContext.allowedChildAgentKeys).toEqual([
      "agent-child",
    ]);
    expect(childInput.input).toContain("child task");
    expect(childInput.input).toContain('"key": "value"');

    // Result returned to the parent.
    const parsedResult = JSON.parse(result.content);
    expect(parsedResult.success).toBe(true);
    expect(parsedResult.agentKey).toBe("agent-child");
    expect(parsedResult.dialogId).toBe("dialog-child-123");
    expect(parsedResult.content).toBe("child done");
    expect(result.metadata).toMatchObject({
      callAgent: true,
      background: false,
      localRuntime: true,
    });
  });

  it("background callAgent persists a pending dialog and returns the child id immediately", async () => {
    const store = createMockStore();
    const adapter = createMockAdapter();
    let childInput: any = null;
    const executor = createCliCallAgentToolExecutor(
      {
        env: { NOLO_LOCAL_USER_ID: "user-test" },
        cwd: "/workspace",
        store: store as any,
        createId: () => "dialog-child-bg",
      },
      {
        createChildAdapter: () => adapter,
        dialogId: "dialog-parent",
        spaceId: "space-parent",
        runtimeContext: {
          allowedChildAgentKeys: ["agent-child"],
        },
        runChildTurn: async (input) => {
          childInput = input;
          return {
            content: "child done",
            dialogId: "dialog-child-bg",
          } as LocalAgentTurnResult;
        },
      },
    );

    const result = await executor({
      id: "call-1",
      name: "callAgent",
      arguments: JSON.stringify({
        agentKey: "agent-child",
        task: "background task",
        background: true,
      }),
    });

    const pendingRecord = store.records.get("dialog-user-test-dialog-child-bg");
    expect(pendingRecord).toBeDefined();
    expect(pendingRecord.status).toBe("pending");
    expect(pendingRecord.executionMode).toBe("background");

    const parsedResult = JSON.parse(result.content);
    expect(parsedResult.success).toBe(true);
    expect(parsedResult.status).toBe("pending");
    expect(parsedResult.childDialogId).toBe("dialog-child-bg");
    expect(result.metadata).toMatchObject({
      callAgent: true,
      background: true,
      localRuntime: true,
    });

    // Background child is started asynchronously; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(childInput).not.toBeNull();
    expect(childInput.runtimeContext.threadKind).toBe("background");
    expect(childInput.runtimeContext.presentationIntent).toBe(
      "background_handoff",
    );
  });

  it("persists a failed child dialog when the child run throws", async () => {
    const store = createMockStore();
    const adapter = createMockAdapter();
    const executor = createCliCallAgentToolExecutor(
      {
        env: { NOLO_LOCAL_USER_ID: "user-test" },
        cwd: "/workspace",
        store: store as any,
        createId: () => "dialog-child-fail",
      },
      {
        createChildAdapter: () => adapter,
        dialogId: "dialog-parent",
        runtimeContext: {
          allowedChildAgentKeys: ["agent-child"],
        },
        runChildTurn: async () => {
          throw new Error("child explosion");
        },
      },
    );

    const result = await executor({
      id: "call-1",
      name: "callAgent",
      arguments: JSON.stringify({ agentKey: "agent-child", task: "fail task" }),
    });

    const failedRecord = store.records.get(
      "dialog-user-test-dialog-child-fail",
    );
    expect(failedRecord).toBeDefined();
    expect(failedRecord.status).toBe("failed");
    expect(failedRecord.errorMessage).toContain("child explosion");
    expect(failedRecord.finishedAt).toBeDefined();

    const parsedResult = JSON.parse(result.content);
    expect(parsedResult.success).toBe(false);
    expect(parsedResult.error).toContain("child explosion");
  });

  it("inherits the same canonical workspace root in child runtime context", async () => {
    const store = createMockStore();
    const adapter = createMockAdapter();
    let childInput: any = null;
    const executor = createCliCallAgentToolExecutor(
      {
        env: { NOLO_LOCAL_USER_ID: "user-test" },
        cwd: "/canonical/workspace",
        store: store as any,
        createId: () => "dialog-child-ws",
      },
      {
        createChildAdapter: () => adapter,
        dialogId: "dialog-parent",
        runtimeContext: {},
        runChildTurn: async (input) => {
          childInput = input;
          return {
            content: "ok",
            dialogId: "dialog-child-ws",
          } as LocalAgentTurnResult;
        },
      },
    );

    await executor({
      id: "call-1",
      name: "callAgent",
      arguments: JSON.stringify({ agentKey: "agent-child", task: "ws task" }),
    });

    expect(childInput.runtimeContext.workspaceRoot).toBe(
      "/canonical/workspace",
    );
    expect(childInput.runtimeContext.workspaceKind).toBe("current");
    expect(childInput.runtimeContext.workspaceAccess).toBe("inherited");

    const pendingRecord = store.records.get("dialog-user-test-dialog-child-ws");
    expect(pendingRecord.localRuntime.workspaceRoot).toBe(
      "/canonical/workspace",
    );
  });
});
