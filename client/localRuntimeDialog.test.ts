import { describe, expect, test } from "bun:test";
import { writeDialog, createLocalDialogTitleGenerator } from "./localRuntimeDialog";

/**
 * Helper: flush pending microtasks so fire-and-forget title patches settle.
 * writeDialog returns as soon as the dialog + messages are persisted; the
 * LLM title (when a titleGenerator is wired) lands via an unawaited background
 * patch. Tests that assert the final title must flush the microtask queue.
 */
const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("localRuntimeDialog writeDialog title behavior", () => {
  const createMockStore = (initialData: Record<string, any> = {}) => {
    const data: Record<string, any> = { ...initialData };
    return {
      read: async (key: string) => data[key] ?? null,
      write: async (key: string, val: any) => { data[key] = val; },
      batch: async (ops: Array<{ type: string; key: string; value: any }>) => {
        for (const op of ops) {
          if (op.type === "put") data[op.key] = op.value;
        }
      },
      getData: () => data,
    };
  };

  test("uses fallback title normalized down to <= 24 chars when titleGenerator returns null without logging in", async () => {
    const store = createMockStore();
    let nowCounter = 1710000000000;
    const longUserMessage = "请帮我重构 UI 组件代码：清理冗余样式，重构 DOM 层级，确保响应式布局正确运作，不要修改全局变值";

    await writeDialog({
      store: store as any,
      input: {
        agentKey: "agent-local",
        messages: [{ role: "user", content: longUserMessage }],
        result: { content: "Done", model: "test-model" },
      },
      userId: "local-user",
      now: () => nowCounter,
      createId: () => "d1",
      env: {}, // Unauthenticated env
      fetchImpl: (async () => ({})) as any,
      titleGenerator: async () => null,
    });
    await flushMicrotasks();

    const dialogRecord = store.getData()["dialog-local-user-d1"];
    expect(dialogRecord).toBeDefined();
    expect(dialogRecord.title).toBe("请帮我重构 UI 组件代码");
    expect(Array.from(dialogRecord.title).length).toBeLessThanOrEqual(24);
  });

  test("generates title when titleGenerator succeeds even without platform auth", async () => {
    const store = createMockStore();
    let nowCounter = 1710000000000;

    await writeDialog({
      store: store as any,
      input: {
        agentKey: "agent-local",
        messages: [{ role: "user", content: "重构样式系统" }],
        result: { content: "Done", model: "test-model" },
      },
      userId: "local-user",
      now: () => nowCounter,
      createId: () => "d2",
      env: {},
      fetchImpl: (async () => ({})) as any,
      titleGenerator: async () => "UI 样式系统重构",
    });
    await flushMicrotasks();

    // The dialog is persisted; the LLM title lands via the background patch.
    const dialogRecord = store.getData()["dialog-local-user-d2"];
    expect(dialogRecord).toBeDefined();
    expect(dialogRecord.title).toBe("UI 样式系统重构");
  });

  test("HIGH-2: writeDialog returns immediately with fallback; LLM title patches in background", async () => {
    const store = createMockStore();
    const nowCounter = 1710000000000;

    // titleGenerator that resolves only when we release the gate — proving
    // writeDialog no longer waits (PERF: fire-and-forget avoids 2.5s stall).
    let releaseTitle: (() => void) | null = null;
    const titleGate = new Promise<string>((resolve) => {
      releaseTitle = () => resolve("延迟生成标题");
    });

    const writePromise = writeDialog({
      store: store as any,
      input: {
        agentKey: "agent-local",
        messages: [{ role: "user", content: "测试等待标题" }],
        result: { content: "Done", model: "test-model" },
      },
      userId: "local-user",
      now: () => nowCounter,
      createId: () => "d-block",
      env: {},
      fetchImpl: (async () => ({})) as any,
      titleGenerator: async () => titleGate,
      // Long timeout so the gate (not the timeout) resolves the race.
      titleTimeoutMs: 5000,
    });

    // writeDialog resolves immediately (before gate release) with fallback.
    const result = await writePromise;
    expect(typeof result.title).toBe("string");
    expect(result.title.length).toBeGreaterThan(0);

    // Before gate release: dialog record has fallback title.
    let dialogRecord = store.getData()["dialog-local-user-d-block"];
    expect(dialogRecord.title).not.toBe("延迟生成标题");

    // Release the gate; titlePatchPromise settles with the LLM title.
    releaseTitle!();
    await result.titlePatchPromise;
    dialogRecord = store.getData()["dialog-local-user-d-block"];
    expect(dialogRecord.title).toBe("延迟生成标题");
  });

  test("HIGH-2: title timeout → returns fallback, persists fallback, does not hang", async () => {
    const store = createMockStore();
    const nowCounter = 1710000000000;

    // A titleGenerator that never resolves within the (short, injected) timeout.
    // Using a deferred gate (not setTimeout(0)) keeps the test deterministic.
    let releaseTitle: (() => void) | null = null;
    const neverResolvingGate = new Promise<string>(() => {
      // intentionally never resolves unless released; release is a safety
      // valve so the test can clean up.
    });
    releaseTitle = () => {
      /* no-op: the gate has no resolver; kept for symmetry/safety */
    };

    const start = Date.now();
    const result = await writeDialog({
      store: store as any,
      input: {
        agentKey: "agent-local",
        messages: [{ role: "user", content: "测试超时降级" }],
        result: { content: "Done", model: "test-model" },
      },
      userId: "local-user",
      now: () => nowCounter,
      createId: () => "d-timeout",
      env: {},
      fetchImpl: (async () => ({})) as any,
      titleGenerator: async () => neverResolvingGate,
      // Short injected timeout — exercises the timeout path without real timers.
      titleTimeoutMs: 30,
    });
    const elapsed = Date.now() - start;

    // The timeout fired: writeDialog returned with the fallback title, not the
    // never-resolving gate. Bounded elapsed time proves it does not hang.
    expect(elapsed).toBeLessThan(500);
    expect(result.title).toBe("测试超时降级");
    const dialogRecord = store.getData()["dialog-local-user-d-timeout"];
    expect(dialogRecord.title).toBe("测试超时降级");
    // Suppress unused-var lint for the safety release.
    void releaseTitle;
  });

  test("HIGH-2: returned title and persisted record both reflect the LLM title when it resolves in time", async () => {
    const store = createMockStore();
    const nowCounter = 1710000000000;

    const result = await writeDialog({
      store: store as any,
      input: {
        agentKey: "agent-local",
        messages: [{ role: "user", content: "重构样式系统" }],
        result: { content: "Done", model: "test-model" },
      },
      userId: "local-user",
      now: () => nowCounter,
      createId: () => "d-llm",
      env: {},
      fetchImpl: (async () => ({})) as any,
      titleGenerator: async () => "UI 样式系统重构",
      titleTimeoutMs: 5000,
    });

    // PERF: title 现在是 fire-and-forget——writeDialog 返回时 result.title
    // 是 fallback（从用户首句提取），LLM title 后台 patch 进 dialog record。
    expect(typeof result.title).toBe("string");
    expect(result.title.length).toBeGreaterThan(0);
    // 等 patch 完成后，持久化记录里的 title 才是 LLM 生成的。
    await result.titlePatchPromise;
    const dialogRecord = store.getData()["dialog-local-user-d-llm"];
    expect(dialogRecord.title).toBe("UI 样式系统重构");
  });

  test("MEDIUM-1: throttle uses titleUpdatedAt; missing titleUpdatedAt is conservative (keeps existing non-empty title)", async () => {
    const creationTimeIso = new Date(1710000000000).toISOString();
    const store = createMockStore({
      "dialog-local-user-d-cons": {
        id: "d-cons",
        dbKey: "dialog-local-user-d-cons",
        title: "旧标题",
        // NOTE: no titleUpdatedAt — old record predating the field.
        createdAt: creationTimeIso,
        updatedAt: creationTimeIso,
      },
    });

    let generatorCalled = false;
    const titleGenerator = async () => {
      generatorCalled = true;
      return "不该生成的标题";
    };

    // 35 minutes later: previously (updatedAt-based) this would regenerate.
    // MEDIUM-1: missing titleUpdatedAt → conservative → do NOT regenerate
    // because a non-empty title already exists. Old records are not retried
    // every turn.
    const ThirtyFiveMinutesMs = 35 * 60 * 1000;
    await writeDialog({
      store: store as any,
      input: {
        agentKey: "agent-local",
        continueDialogId: "d-cons",
        messages: [{ role: "user", content: "35 分钟后" }],
        result: { content: "Done", model: "test-model" },
      },
      userId: "local-user",
      now: () => 1710000000000 + ThirtyFiveMinutesMs,
      createId: () => "d-cons",
      env: {},
      fetchImpl: (async () => ({})) as any,
      titleGenerator,
      titleTimeoutMs: 100,
    });

    expect(generatorCalled).toBe(false);
    const dialogRecord = store.getData()["dialog-local-user-d-cons"];
    expect(dialogRecord.title).toBe("旧标题");
    // The record now carries titleUpdatedAt (seeded from createdAt on the
    // preserve path) so subsequent turns use the real throttle.
    expect(typeof dialogRecord.titleUpdatedAt).toBe("string");
  });

  test("MEDIUM-1: throttle regenerates when titleUpdatedAt is >= 30 min old", async () => {
    const creationTimeIso = new Date(1710000000000).toISOString();
    const oldTitleUpdatedAtIso = new Date(1710000000000).toISOString();
    const store = createMockStore({
      "dialog-local-user-d-throttle": {
        id: "d-throttle",
        dbKey: "dialog-local-user-d-throttle",
        title: "旧标题",
        titleSource: "generated",
        titleUpdatedAt: oldTitleUpdatedAtIso,
        createdAt: creationTimeIso,
        updatedAt: creationTimeIso,
      },
    });

    let generatorCalled = false;
    const titleGenerator = async () => {
      generatorCalled = true;
      return "更新后的新标题";
    };

    // 5 minutes later (< 30 min): do NOT regenerate.
    const FiveMinutesMs = 5 * 60 * 1000;
    await writeDialog({
      store: store as any,
      input: {
        agentKey: "agent-local",
        continueDialogId: "d-throttle",
        messages: [{ role: "user", content: "5 分钟后" }],
        result: { content: "Done", model: "test-model" },
      },
      userId: "local-user",
      now: () => 1710000000000 + FiveMinutesMs,
      createId: () => "d-throttle",
      env: {},
      fetchImpl: (async () => ({})) as any,
      titleGenerator,
      titleTimeoutMs: 100,
    });

    expect(generatorCalled).toBe(false);
    expect(store.getData()["dialog-local-user-d-throttle"].title).toBe("旧标题");

    // 35 minutes later (>= 30 min): regenerate.
    const ThirtyFiveMinutesMs = 35 * 60 * 1000;
    const result35 = await writeDialog({
      store: store as any,
      input: {
        agentKey: "agent-local",
        continueDialogId: "d-throttle",
        messages: [{ role: "user", content: "35 分钟后" }],
        result: { content: "Done", model: "test-model" },
      },
      userId: "local-user",
      now: () => 1710000000000 + ThirtyFiveMinutesMs,
      createId: () => "d-throttle",
      env: {},
      fetchImpl: (async () => ({})) as any,
      titleGenerator,
      titleTimeoutMs: 100,
    });

    expect(generatorCalled).toBe(true);
    // title 现在是 fire-and-forget patch，等它完成再检查持久化记录。
    await result35.titlePatchPromise;
    const dialogRecord = store.getData()["dialog-local-user-d-throttle"];
    expect(dialogRecord.title).toBe("更新后的新标题");
    // titleUpdatedAt is refreshed to the new turn time.
    expect(dialogRecord.titleUpdatedAt).toBe(
      new Date(1710000000000 + ThirtyFiveMinutesMs).toISOString(),
    );
  });

  test("MEDIUM-1: a manual title is never regenerated, even after 30+ minutes", async () => {
    const creationTimeIso = new Date(1710000000000).toISOString();
    const oldTitleUpdatedAtIso = new Date(1710000000000 - 2 * 60 * 60 * 1000).toISOString();
    const store = createMockStore({
      "dialog-local-user-d-manual": {
        id: "d-manual",
        dbKey: "dialog-local-user-d-manual",
        title: "用户手动命名",
        titleSource: "manual",
        titleUpdatedAt: oldTitleUpdatedAtIso,
        createdAt: creationTimeIso,
        updatedAt: creationTimeIso,
      },
    });

    let generatorCalled = false;
    const titleGenerator = async () => {
      generatorCalled = true;
      return "LLM 想覆盖的标题";
    };

    // 2 hours after the (old) titleUpdatedAt — well past the 30-min window.
    await writeDialog({
      store: store as any,
      input: {
        agentKey: "agent-local",
        continueDialogId: "d-manual",
        messages: [{ role: "user", content: "很久以后" }],
        result: { content: "Done", model: "test-model" },
      },
      userId: "local-user",
      now: () => 1710000000000 + 2 * 60 * 60 * 1000,
      createId: () => "d-manual",
      env: {},
      fetchImpl: (async () => ({})) as any,
      titleGenerator,
      titleTimeoutMs: 100,
    });

    expect(generatorCalled).toBe(false);
    const dialogRecord = store.getData()["dialog-local-user-d-manual"];
    expect(dialogRecord.title).toBe("用户手动命名");
    expect(dialogRecord.titleSource).toBe("manual");
  });

  test("updates existing title when dialog is updated after 30 minutes, but leaves recent (<30m) titles unchanged without calling generator", async () => {
    const creationTimeIso = new Date(1710000000000).toISOString();
    const store = createMockStore({
      "dialog-local-user-d3": {
        id: "d3",
        dbKey: "dialog-local-user-d3",
        title: "旧标题",
        createdAt: creationTimeIso,
        updatedAt: creationTimeIso,
      },
    });

    let generatorCalled = false;
    const titleGenerator = async () => {
      generatorCalled = true;
      return "更新后的新标题";
    };

    // 5 minutes later (< 30 min): titleGenerator should NOT be called and title stays "旧标题"
    const FiveMinutesMs = 5 * 60 * 1000;
    await writeDialog({
      store: store as any,
      input: {
        agentKey: "agent-local",
        continueDialogId: "d3",
        messages: [{ role: "user", content: "新一轮讨论 5 分钟后" }],
        result: { content: "Done", model: "test-model" },
      },
      userId: "local-user",
      now: () => 1710000000000 + FiveMinutesMs,
      createId: () => "d3",
      env: {},
      fetchImpl: (async () => ({})) as any,
      titleGenerator,
    });
    await flushMicrotasks();

    let dialogRecord = store.getData()["dialog-local-user-d3"];
    expect(generatorCalled).toBe(false);
    expect(dialogRecord.title).toBe("旧标题");

    // 35 minutes later (>= 30 min): titleGenerator SHOULD be called
    const ThirtyFiveMinutesMs = 35 * 60 * 1000;
    await writeDialog({
      store: store as any,
      input: {
        agentKey: "agent-local",
        continueDialogId: "d3",
        messages: [{ role: "user", content: "新一轮讨论 35 分钟后" }],
        result: { content: "Done", model: "test-model" },
      },
      userId: "local-user",
      now: () => 1710000000000 + ThirtyFiveMinutesMs,
      createId: () => "d3",
      env: {},
      fetchImpl: (async () => ({})) as any,
      titleGenerator,
    });
    await flushMicrotasks();

    dialogRecord = store.getData()["dialog-local-user-d3"];
    expect(generatorCalled).toBe(true);
    expect(dialogRecord.title).toBe("更新后的新标题");
  });

  test("createLocalDialogTitleGenerator is null when neither platform auth nor direct provider env is configured", () => {
    const generator = createLocalDialogTitleGenerator(
      { env: {} } as any,
      { apiKeyRefResolver: null, credentialBroker: null },
    );
    expect(generator).toBeNull();
  });

  test("createLocalDialogTitleGenerator is non-null when a direct OpenAI-compatible provider env is configured", () => {
    const generator = createLocalDialogTitleGenerator(
      { env: { OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "http://localhost:11434/v1" } } as any,
      { apiKeyRefResolver: null, credentialBroker: null },
    );
    expect(generator).not.toBeNull();
  });
});