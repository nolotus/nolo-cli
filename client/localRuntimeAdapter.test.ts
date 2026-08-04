// @ts-nocheck — mock-heavy local runtime adapter suite; stubs intentionally incomplete vs HybridRecordKvDb/fetch.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getCredentialPath, writeOAuthCredential } from "../agent-runtime/oauthTokenStore";

import { runLocalAgentTurn } from "../agent-runtime/localLoop";
import { resolveCliEffectiveEnabledPacks } from "./localRuntimeAdapter";
import { expandEnabledPacks, applyDisabledTools } from "../ai/tools/toolPacks";
import type { PermissionRequest } from "../agent-runtime/actionGate";
import {
  clearCliLocalRuntimePreparedAgentCache,
  createCliLocalRuntimeAdapter,
  postRemoteRecord,
  setRemoteDialogSyncTimeoutForTest,
  // 导出供测试：policy 名单派生回归用。
  buildOpenAiTools,
  buildLocalPolicyToolNames,
  resolveCliRequestedToolNames,
} from "./localRuntimeAdapter";
import { resolveLocalToolPolicy } from "./localToolPolicy";
import { buildLocalToolExecutors } from "./cliLocalToolExecutors";
import { LOCAL_CODEX_AGENT_KEY } from "../agentAliases";
import {
  allocateCollapsedPaste,
  createCollapsedPasteStore,
} from "../core/collapsedPaste";

const FULLSTACK_TEST_AGENT_KEY = "fullstack";

/** Test-only: incomplete fetch/db stubs need a loose deps surface. */
function createAdapter(deps: any) {
  return createCliLocalRuntimeAdapter(deps);
}

describe("CLI local runtime adapter source contract (credential broker)", () => {
  const source = readFileSync(join(import.meta.dir, "localRuntimeAdapter.ts"), "utf8");

  test("wires createFileCredentialBroker into resolveProvider paths", () => {
    // Broker is lazy-loaded for cold-start (require path), not top-level import.
    expect(source).toContain("../../agent-runtime/fileCredentialBroker");
    expect(source).toContain("createFileCredentialBroker");
    expect(source).toContain("const credentialBroker = createFileCredentialBroker()");
    expect(source).toContain("credentialBroker,");
  });

  test("passes credentialBroker to platform and direct OpenAI-compatible resolvers", () => {
    expect(source).toContain("resolvePlatformChatProviderConfig({");
    expect(source).toContain("resolveCliOpenAiProviderConfig({");
    // Both call sites must include credentialBroker next to apiKeyRefResolver.
    const platformBlock = source.slice(
      source.indexOf("resolvePlatformChatProviderConfig({"),
      source.indexOf("resolvePlatformChatProviderConfig({") + 280,
    );
    const directBlock = source.slice(
      source.indexOf("resolveCliOpenAiProviderConfig({"),
      source.indexOf("resolveCliOpenAiProviderConfig({") + 280,
    );
    expect(platformBlock).toContain("apiKeyRefResolver");
    expect(platformBlock).toContain("credentialBroker");
    expect(directBlock).toContain("apiKeyRefResolver");
    expect(directBlock).toContain("credentialBroker");
  });
});

describe("CLI local runtime adapter", () => {
  beforeEach(() => {
    clearCliLocalRuntimePreparedAgentCache();
  });

  const DEFAULT_LOCAL_CODING_TOOL_NAMES = [
    "listFiles",
    "readFile",
    "writeFile",
    "editFile",
    "globFiles",
    "searchFiles",
    "execShell",
    "launchProcess",
    "listProcesses",
  ];
  const LEGACY_WRITE_LOCAL_CODING_TOOL_NAMES = [
    "listFiles",
    "readFile",
    "writeFile",
    "editFile",
    "globFiles",
    "searchFiles",
    "execShell",
    "launchProcess",
    "listProcesses",
  ];
  const SHELL_LOCAL_CODING_TOOL_NAMES = [
    ...DEFAULT_LOCAL_CODING_TOOL_NAMES,
  ];
  const DEFAULT_PRIVATE_NOLO_WORKSPACE_TOOL_NAMES = [
    "listDialogs",
    "readDialog",
    "queryDialogsBySubjectRef",
    "listAgents",
    "readAgent",
    "listSpaces",
    "readSpace",
    "readDoc",
    "readSkillDoc",
    "loadSkill",
    "listTables",
    "queryTableRows",
    "cliWhoami",
    "cliDoctor",
  ];
  const DEFAULT_PRIVATE_LOCAL_TOOL_NAMES = [
    "ui_ask_choice",
    ...DEFAULT_LOCAL_CODING_TOOL_NAMES,
    // long-term-memory 是 always-on 能力包：CLI 每个未 ablation 的 agent 都能看到
    // rememberMemory，TUI 的「记住 X」才会走 tool call 而非 shell 兜底。
    "rememberMemory",
    "exa_search",
    "fetchWebpage",
    ...DEFAULT_PRIVATE_NOLO_WORKSPACE_TOOL_NAMES,
    "startAgentRun",
    "controlAgentRun",
  ];

  function toolNamesFromRequest(request: any) {
    return request?.body?.tools?.map((tool: any) => tool.function.name) ?? [];
  }

  function expectMessagesWithEnrichedSystem(
    request: any,
    expected: Array<{ role: string; content?: string; contains?: string }>,
  ) {
    const messages = request?.body?.messages ?? [];
    expect(messages).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(messages[i].role).toBe(expected[i].role);
      if (expected[i].contains !== undefined) {
        expect(messages[i].content).toContain(expected[i].contains);
      } else {
        expect(messages[i].content).toBe(expected[i].content);
      }
    }
  }

  function publicSchemaKeys(schema: any) {
    return Object.keys(schema.parameters.properties).filter((key) => key !== "_activity");
  }

  function authTokenForUser(userId: string) {
    return [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(JSON.stringify({ userId })).toString("base64url"),
      "sig",
    ].join(".");
  }

  test("reuses prepared agent runtime for repeated loadAgentConfig calls", async () => {
    clearCliLocalRuntimePreparedAgentCache();
    let storeReads = 0;
    const adapter = createAdapter({
      env: { NOLO_LOCAL_USER_ID: "user-1" },
      cwd: "/tmp/nolo-cache-test",
      db: {
        get: async (key) => {
          storeReads += 1;
          if (key === "agent-user-1-test") {
            return {
              dbKey: "agent-user-1-test",
              id: "test",
              name: "Cached Agent",
              prompt: "cached",
              provider: "custom",
              model: "MiniMax-M3",
              customProviderUrl: "https://api.minimaxi.com/v1",
              tools: ["readFile"],
            };
          }
          // systemBuiltinSkills 设置 record 读取：返回空 record（默认全开），
          // 让 loadAgentConfig 的 best-effort settings 读取不 throw。首次调用
          // 会多读一次 settings key，第二次走缓存命中分支不再读。
          if (key === "user-1-settings") return {};
          throw new Error(`not found: ${key}`);
        },
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async () => new Response("not found", { status: 404 }),
    } as any);

    await adapter.loadAgentConfig("agent-user-1-test");
    await adapter.loadAgentConfig("agent-user-1-test");

    // 每次调用都读取 settings 以检测全局 Skill 开关变化；agent config
    // 本身仍只读取一次，第二次复用 prepared runtime。
    expect(storeReads).toBe(3);
  });

  test("loads stored local CLI agent records before falling back to built-ins", async () => {
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "0e95801d90",
      },
      db: {
        get: async (key) => {
          if (key !== LOCAL_CODEX_AGENT_KEY) throw new Error(`not found: ${key}`);
          return {
            dbKey: LOCAL_CODEX_AGENT_KEY,
            id: "01LOCALCODEXCLI000000NEW",
            name: "User Edited Local Codex",
            prompt: "User-owned local Codex prompt.",
            apiSource: "cli",
            provider: "cli",
            cliProvider: "codex",
            model: "gpt-5.4",
          };
        },
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async () => new Response("not found", { status: 404 }),
    } as any);

    await expect(adapter.loadAgentConfig(LOCAL_CODEX_AGENT_KEY)).resolves.toMatchObject({
      key: LOCAL_CODEX_AGENT_KEY,
      name: "User Edited Local Codex",
      prompt: "User-owned local Codex prompt.",
      apiSource: "cli",
      provider: "cli",
      cliProvider: "codex",
      model: "gpt-5.4",
    });
  });

  test("loads local CLI agent records by their handle", async () => {
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
      },
      db: {
        get: async () => {
          throw new Error("not found");
        },
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {
          yield ["agent-user-1-frontend", {
            dbKey: "agent-user-1-frontend",
            id: "frontend",
            name: "Frontend Implementer",
            handle: "frontend-implementer",
            prompt: "Fix product UI.",
            apiSource: "cli",
            provider: "agy",
            cliProvider: "agy",
          }];
        })(),
      },
      fetchImpl: async () => new Response("not found", { status: 404 }),
    } as any);

    await expect(adapter.loadAgentConfig("frontend-implementer")).resolves.toMatchObject({
      key: "agent-user-1-frontend",
      name: "Frontend Implementer",
      cliProvider: "agy",
    });
  });

  test("falls back to built-in local Codex CLI agent without machine binding", async () => {
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
      },
      db: {
        get: async (key) => {
          throw new Error(`not found: ${key}`);
        },
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async () => new Response("not found", { status: 404 }),
    } as any);

    const codex = await adapter.loadAgentConfig(LOCAL_CODEX_AGENT_KEY);

    expect(codex).toMatchObject({
      key: LOCAL_CODEX_AGENT_KEY,
      name: "Local Codex",
      apiSource: "cli",
      provider: "cli",
      cliProvider: "codex",
    });
    expect((codex as any)?.runtimeBinding).toBeUndefined();
    expect((codex as any)?.rawRecord?.runtimeBinding).toBeUndefined();
  });

  test("runs cli-provider agents through the local CLI executor instead of OpenAI-compatible direct mode", async () => {
    const cliExecutions: Array<{ provider: string; prompt: string; options: any }> = [];
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        OPENAI_API_KEY: "sk-should-not-be-used",
      },
      db: {
        get: async (key) => {
          if (key !== "agent-user-1-frontend") throw new Error(`not found: ${key}`);
          return {
            dbKey: "agent-user-1-frontend",
            id: "frontend",
            name: "Frontend",
            prompt: "You are the frontend implementer.",
            apiSource: "cli",
            cliProvider: "agy",
            model: "gemini-3.1-pro",
          };
        },
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      cwd: "/repo/worktree",
      now: () => 1710000000000,
      createId: () => "01CLI",
      fetchImpl: async () => {
        throw new Error("OpenAI-compatible fetch should not be used for cli providers");
      },
      executeCli: async (provider, prompt, options) => {
        cliExecutions.push({ provider, prompt, options });
        return { text: "cli ok", raw: "cli ok", elapsed: 1 };
      },
    } as any);

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "frontend",
      input: "add tooltip",
      timeoutMs: 600_000,
    });

    expect(result).toMatchObject({
      content: "cli ok",
      model: "gemini-3.1-pro",
    });
    expect(cliExecutions).toHaveLength(1);
    expect(cliExecutions[0]).toMatchObject({
      provider: "agy",
      options: {
        model: "gemini-3.1-pro",
        timeout: 600_000,
        cwd: "/repo/worktree",
        yolo: true,
      },
    });
    expect(cliExecutions[0].prompt).toContain("You are the frontend implementer.");
    expect(cliExecutions[0].prompt).toContain("add tooltip");
  });

  test("syncs subjectRef local CLI dialog evidence to the configured server", async () => {
    const remoteWrites: Array<{ url: string; auth: string | null; body: any }> = [];
    const store = new Map<string, any>([
      ["agent-user-1-frontend", {
        dbKey: "agent-user-1-frontend",
        id: "frontend",
        name: "Frontend",
        prompt: "You are the frontend implementer.",
        apiSource: "cli",
        cliProvider: "agy",
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_SERVER: "https://us.nolo.chat",
        AUTH_TOKEN: "token-1",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      cwd: "/repo/worktree",
      now: () => 1710000000000,
      createId: () => "01LOCAL",
      fetchImpl: async (url, init) => {
        remoteWrites.push({
          url: String(url),
          auth: new Headers(init?.headers).get("Authorization"),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({ ok: true });
      },
      executeCli: async () => ({ text: "cli ok", raw: "cli ok", elapsed: 1 }),
    } as any);

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "frontend",
      input: "fix tabs",
      runtimeContext: {
        subjectRefs: [{ kind: "table-row", id: "row-user-1-board-task", role: "task" }],
      },
    });

    expect(result.dialogId).toBe("01LOCAL");
    expect(remoteWrites.map((write) => write.url)).toEqual([
      "https://us.nolo.chat/api/v1/db/write/",
      "https://us.nolo.chat/api/v1/db/write/",
      "https://us.nolo.chat/api/v1/db/write/",
    ]);
    expect(remoteWrites.every((write) => write.auth === "Bearer token-1")).toBe(true);
    expect(remoteWrites[0].body).toMatchObject({
      customKey: "dialog-01LOCAL-msg-1710000000000-001",
      userId: "user-1",
      data: {
        type: "msg",
        dialogId: "01LOCAL",
        role: "user",
        content: "fix tabs",
      },
    });
    expect(remoteWrites[1].body).toMatchObject({
      customKey: "dialog-01LOCAL-msg-1710000000000-002",
      userId: "user-1",
      data: {
        type: "msg",
        dialogId: "01LOCAL",
        role: "assistant",
        content: "cli ok",
      },
    });
    expect(remoteWrites[2].body).toMatchObject({
      customKey: "dialog-user-1-01LOCAL",
      userId: "user-1",
      data: {
        id: "01LOCAL",
        type: "dialog",
        userId: "user-1",
        primaryAgentKey: "agent-user-1-frontend",
        subjectRefs: [{ kind: "table-row", id: "row-user-1-board-task", role: "task" }],
        localRuntime: {
          host: "cli",
          worktreePath: "/repo/worktree",
        },
      },
    });
  });

  test("wakes the parent dialog after a local subjectRef child run reaches done", async () => {
    const remoteRequests: Array<{ url: string; method: string; body?: any; auth: string | null }> = [];
    const store = new Map<string, any>([
      ["agent-user-1-fullstack", {
        dbKey: "agent-user-1-fullstack",
        id: "fullstack",
        name: "Fullstack",
        prompt: "Implement the task.",
        apiSource: "cli",
        cliProvider: "codex",
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_SERVER: "https://us.nolo.chat",
        AUTH_TOKEN: "token-1",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      cwd: "/repo/worktree",
      now: () => 1710000000000,
      createId: () => "01LOCAL",
      fetchImpl: async (url, init) => {
        const target = String(url);
        const method = String(init?.method ?? "GET");
        const rawBody = typeof init?.body === "string" ? init.body : "";
        const body = rawBody ? JSON.parse(rawBody) : undefined;
        remoteRequests.push({
          url: target,
          method,
          ...(body ? { body } : {}),
          auth: new Headers(init?.headers).get("Authorization"),
        });
        if (target.endsWith("/api/v1/db/read/dialog-user-1-parent-1")) {
          return Response.json({
            data: {
              id: "parent-1",
              dbKey: "dialog-user-1-parent-1",
              primaryAgentKey: "agent-user-1-pm",
            },
          });
        }
        if (target.endsWith("/api/agent/run")) {
          expect(body).toMatchObject({
            agentKey: "agent-user-1-pm",
            background: true,
            continueDialogId: "parent-1",
            runtimeContext: {
              entrypoint: "agent-runtime:parent-child-terminal-wake",
              subjectRefs: expect.arrayContaining([
                { kind: "table-row", id: "row-user-1-board-task", role: "task" },
                { kind: "dialog", id: "01LOCAL", role: "completed-child-dialog" },
              ]),
            },
          });
          expect(body.userInput).toContain("A child agent dialog you started has reached a terminal status.");
          expect(body.userInput).toContain("childDialogId: 01LOCAL");
          expect(body.userInput).toContain("status: done");
          expect(body.userInput).toContain("childEvidenceSummary:");
          expect(body.userInput).toContain("implemented locally");
          return Response.json({ dialogId: "parent-1", status: "pending" }, { status: 202 });
        }
        return Response.json({ ok: true });
      },
      executeCli: async () => ({ text: "implemented locally", raw: "implemented locally", elapsed: 1 }),
    } as any);

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "fullstack",
      input: "fix the prompt contract",
      parentDialogId: "parent-1",
      runtimeContext: {
        parentWakeOnTerminal: true,
        subjectRefs: [{ kind: "table-row", id: "row-user-1-board-task", role: "task" }],
      },
    });

    expect(result.dialogId).toBe("01LOCAL");
    expect(remoteRequests.map((request) => request.url)).toContain(
      "https://us.nolo.chat/api/v1/db/read/dialog-user-1-parent-1",
    );
    expect(remoteRequests.map((request) => request.url)).toContain(
      "https://us.nolo.chat/api/agent/run",
    );
    const wakeWrite = remoteRequests.find((request) =>
      request.body?.customKey === "dialog-user-1-01LOCAL" &&
      request.body?.data?.parentWake?.terminalStatus === "done"
    );
    expect(wakeWrite?.body?.data?.parentWake).toMatchObject({
      terminalStatus: "done",
      parentDialogId: "parent-1",
      childDialogId: "01LOCAL",
    });
  });

  test("uses the auth token user id for remote subjectRef evidence when local user id is unset", async () => {
    const remoteWrites: Array<{ body: any }> = [];
    const store = new Map<string, any>([
      ["agent-token-user-frontend", {
        dbKey: "agent-token-user-frontend",
        id: "frontend",
        name: "Frontend",
        prompt: "You are the frontend implementer.",
        apiSource: "cli",
        cliProvider: "agy",
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_SERVER: "https://us.nolo.chat",
        AUTH_TOKEN: authTokenForUser("token-user"),
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      now: () => 1710000000000,
      createId: () => "01LOCAL",
      fetchImpl: async (_url, init) => {
        remoteWrites.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({ ok: true });
      },
      executeCli: async () => ({ text: "cli ok", raw: "cli ok", elapsed: 1 }),
    } as any);

    await runLocalAgentTurn({
      adapter,
      agentRef: "frontend",
      input: "fix tabs",
      runtimeContext: {
        subjectRefs: [{ kind: "table-row", id: "row-token-user-board-task", role: "task" }],
      },
    });

    expect(remoteWrites.at(-1)?.body).toMatchObject({
      customKey: "dialog-token-user-01LOCAL",
      userId: "token-user",
    });
  });

  test("fails subjectRef local CLI runs when remote evidence cannot be written", async () => {
    const store = new Map<string, any>([
      ["agent-user-1-frontend", {
        dbKey: "agent-user-1-frontend",
        id: "frontend",
        name: "Frontend",
        prompt: "You are the frontend implementer.",
        apiSource: "cli",
        cliProvider: "agy",
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_SERVER: "https://us.nolo.chat",
        AUTH_TOKEN: "token-1",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      createId: () => "01LOCAL",
      fetchImpl: async () => new Response("nope", { status: 500 }),
      executeCli: async () => ({ text: "cli ok", raw: "cli ok", elapsed: 1 }),
    } as any);

    await expect(runLocalAgentTurn({
      adapter,
      agentRef: "frontend",
      input: "fix tabs",
      runtimeContext: {
        subjectRefs: [{ kind: "table-row", id: "row-user-1-board-task", role: "task" }],
      },
    })).rejects.toThrow("remote dialog evidence write failed");
  });

  test("syncs a normal turn (no subjectRefs) to the configured server when serverUrl+authToken are set", async () => {
    const remoteWrites: Array<{ url: string; body: any }> = [];
    const store = new Map<string, any>([
      ["agent-user-1-frontend", {
        dbKey: "agent-user-1-frontend",
        id: "frontend",
        name: "Frontend",
        prompt: "You are the frontend implementer.",
        apiSource: "cli",
        cliProvider: "agy",
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_SERVER: "https://us.nolo.chat",
        AUTH_TOKEN: "token-1",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      createId: () => "01NORMAL",
      fetchImpl: async (url, init) => {
        remoteWrites.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({ ok: true });
      },
      executeCli: async () => ({ text: "cli ok", raw: "cli ok", elapsed: 1 }),
    } as any);

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "frontend",
      input: "hello",
    });

    expect(result.dialogId).toBe("01NORMAL");
    // All plan.ops should be POSTed to /api/v1/db/write/
    expect(remoteWrites.length).toBeGreaterThan(0);
    for (const write of remoteWrites) {
      expect(write.url).toBe("https://us.nolo.chat/api/v1/db/write/");
    }
  });

  test("does not push any write requests when userId is local (even with subjectRefs)", async () => {
    const remoteWrites: Array<{ url: string }> = [];
    const store = new Map<string, any>([
      ["agent-local-frontend", {
        dbKey: "agent-local-frontend",
        id: "frontend",
        name: "Frontend",
        prompt: "You are the frontend implementer.",
        apiSource: "cli",
        cliProvider: "agy",
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "local",
        NOLO_SERVER: "https://us.nolo.chat",
        AUTH_TOKEN: "token-1",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      createId: () => "01LOCALUSER",
      fetchImpl: async (url) => {
        remoteWrites.push({ url: String(url) });
        return Response.json({ ok: true });
      },
      executeCli: async () => ({ text: "cli ok", raw: "cli ok", elapsed: 1 }),
    } as any);

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "frontend",
      input: "hello",
      runtimeContext: {
        subjectRefs: [{ kind: "table-row", id: "row-local-board-task", role: "task" }],
      },
    });

    expect(result.dialogId).toBe("01LOCALUSER");
    // No write requests should be made when userId is "local"
    const writeRequests = remoteWrites.filter((r) => r.url.includes("/api/v1/db/write/"));
    expect(writeRequests).toEqual([]);
  });

  test("write push HTTP failure on a normal turn does not affect turn result", async () => {
    const remoteWrites: Array<{ url: string }> = [];
    const store = new Map<string, any>([
      ["agent-user-1-frontend", {
        dbKey: "agent-user-1-frontend",
        id: "frontend",
        name: "Frontend",
        prompt: "You are the frontend implementer.",
        apiSource: "cli",
        cliProvider: "agy",
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_SERVER: "https://us.nolo.chat",
        AUTH_TOKEN: "token-1",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      createId: () => "01WRITEFAIL",
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.includes("/api/v1/db/write/")) {
          remoteWrites.push({ url: target });
          throw new Error("Server unreachable");
        }
        return Response.json({ ok: true });
      },
      executeCli: async () => ({ text: "cli ok", raw: "cli ok", elapsed: 1 }),
    } as any);

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "frontend",
      input: "hello",
    });

    // Turn result must be unaffected by write failure
    expect(result.content).toBe("cli ok");
    expect(result.dialogId).toBe("01WRITEFAIL");
    // Verify that write requests were actually attempted (proves sync happened)
    expect(remoteWrites.length).toBeGreaterThan(0);
  });

  test("fails cli-provider local runs clearly when the requested local CLI is unavailable", async () => {
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        OPENAI_API_KEY: "sk-should-not-be-used",
      },
      db: {
        get: async (key) => {
          if (key !== "agent-user-1-frontend") throw new Error(`not found: ${key}`);
          return {
            dbKey: "agent-user-1-frontend",
            id: "frontend",
            name: "Frontend",
            prompt: "You are the frontend implementer.",
            apiSource: "cli",
            cliProvider: "agy",
          };
        },
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async () => {
        throw new Error("OpenAI-compatible fetch should not be used for cli providers");
      },
      executeCli: async () => {
        throw new Error("agy: command not found");
      },
    } as any);

    await expect(runLocalAgentTurn({
      adapter,
      agentRef: "frontend",
      input: "add tooltip",
    })).rejects.toThrow("Local CLI provider \"agy\" is unavailable");
  });

  test("creates read-compatible ULID dialog ids for local CLI runs by default", async () => {
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
      },
      db: {
        get: async (key) => {
          if (key !== "agent-user-1-cli") throw new Error(`not found: ${key}`);
          return {
            dbKey: "agent-user-1-cli",
            id: "cli",
            name: "CLI",
            prompt: "You are local.",
            apiSource: "cli",
            cliProvider: "codex",
          };
        },
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async () => new Response("not found", { status: 404 }),
      executeCli: async () => ({ text: "ok", raw: "ok", elapsed: 1 }),
    } as any);

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "agent-user-1-cli",
      input: "ping",
    });

    expect(result.dialogId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("forwards reasoningEffort camelCase to the CLI executor", async () => {
    let cliCalledWith: any = null;
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
      },
      db: {
        get: async (key) => {
          if (key !== "agent-user-1-grok") throw new Error(`not found: ${key}`);
          return {
            dbKey: "agent-user-1-grok",
            id: "grok",
            name: "Grok",
            prompt: "You are Grok.",
            apiSource: "cli",
            cliProvider: "grok",
            reasoningEffort: "high",
          };
        },
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      executeCli: async (provider, prompt, options) => {
        cliCalledWith = { provider, prompt, options };
        return { text: "grok ok", raw: "", elapsed: 1 };
      },
    } as any);

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "grok",
      input: "hello",
    });

    expect(result.content).toBe("grok ok");
    expect(cliCalledWith?.options?.reasoningEffort).toBe("high");
  }, 15_000);

  test("passes cli-provider image inputs to the CLI executor instead of rejecting", async () => {
    let cliCalledWith: any = null;
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
      },
      db: {
        get: async (key) => {
          if (key !== "agent-user-1-frontend") throw new Error(`not found: ${key}`);
          return {
            dbKey: "agent-user-1-frontend",
            id: "frontend",
            name: "Frontend",
            prompt: "You are the frontend implementer.",
            apiSource: "cli",
            cliProvider: "agy",
          };
        },
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      executeCli: async (provider, prompt, options) => {
        cliCalledWith = { provider, prompt, options };
        return { text: "image handled", raw: "", elapsed: 1 };
      },
    } as any);

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "frontend",
      input: [
        { type: "text", text: "look at this screenshot" },
        { type: "image_url", image_url: { url: "https://example.com/screen.png" } },
      ],
    });

    expect(result.content).toBe("image handled");
    expect(cliCalledWith).not.toBeNull();
    expect(cliCalledWith.provider).toBe("agy");
    expect(cliCalledWith.prompt).toContain("look at this screenshot");
    expect(cliCalledWith.options.imageInputs).toEqual([
      { source: "https://example.com/screen.png" },
    ]);
  });

  test("loads agent/history from LevelDB and saves dialog/message records back to LevelDB", async () => {
    const requests: Array<{ url: string; body: any; auth: string | null }> = [];
    const store = new Map<string, any>([
      ["agent-user-1-frontend", {
        dbKey: "agent-user-1-frontend",
        id: "frontend",
        name: "Frontend",
        prompt: "Fix UI",
        model: "gpt-4.1-mini",
        provider: "openai-compatible",
      }],
      ["dialog-user-1-dialog-existing", {
        dbKey: "dialog-user-1-dialog-existing",
        id: "dialog-existing",
        type: "dialog",
        userId: "user-1",
      }],
      ["dialog-dialog-existing-msg-001", {
        dbKey: "dialog-dialog-existing-msg-001",
        id: "msg-001",
        dialogId: "dialog-existing",
        role: "assistant",
        content: "previous answer",
      }],
    ]);
    const batchOps: any[] = [];
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          batchOps.push(...ops);
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: ({ gte, lte }) => (async function* () {
          for (const entry of [...store.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            if (entry[0] >= gte && entry[0] <= lte) yield entry;
          }
        })(),
      },
      now: () => 1710000000000,
      createId: () => "01LOCAL",
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          auth: new Headers(init?.headers).get("Authorization"),
        });
        return Response.json({
          choices: [{ message: { content: "local adapter ok" } }],
          usage: { prompt_tokens: 4, completion_tokens: 3 },
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "frontend",
      input: "make it cleaner",
      continueDialogId: "dialog-existing",
    });

    expect(result).toMatchObject({
      content: "local adapter ok",
      model: "gpt-4.1-mini",
      dialogId: "dialog-existing",
    });
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:11434/v1/chat/completions",
      auth: "Bearer sk-local",
      body: {
        model: "gpt-4.1-mini",
        stream: false,
      },
    });
    expectMessagesWithEnrichedSystem(requests[0], [
      { role: "system", contains: "Fix UI" },
      { role: "assistant", content: "previous answer" },
      { role: "user", content: "make it cleaner" },
    ]);
    expect(toolNamesFromRequest(requests[0])).toEqual(DEFAULT_PRIVATE_LOCAL_TOOL_NAMES);
    expect(batchOps.map((op) => op.key)).toEqual([
      "dialog-user-1-dialog-existing",
      "dialog-dialog-existing-msg-1710000000000-001",
      "dialog-dialog-existing-msg-1710000000000-002",
    ]);
    expect(store.get("dialog-user-1-dialog-existing")).toMatchObject({
      id: "dialog-existing",
      dbKey: "dialog-user-1-dialog-existing",
      type: "dialog",
      primaryAgentKey: "agent-user-1-frontend",
      status: "done",
    });
    expect(store.get("dialog-dialog-existing-msg-1710000000000-001")).toMatchObject({
      dialogId: "dialog-existing",
      role: "user",
      content: "make it cleaner",
    });
    expect(store.get("dialog-dialog-existing-msg-1710000000000-002")).toMatchObject({
      dialogId: "dialog-existing",
      role: "assistant",
      content: "local adapter ok",
    });
  });

  test("loads a missing explicit agent key through the hybrid store remote cache", async () => {
    const memory = new Map<string, any>();
    const requests: string[] = [];
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_SERVER: "https://us.nolo.chat",
        AUTH_TOKEN: "token-1",
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async (key) => {
          if (!memory.has(key)) throw new Error(`not found: ${key}`);
          return memory.get(key);
        },
        put: async (key, value) => {
          memory.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") memory.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      createId: () => "01REMOTE",
      fetchImpl: async (url, init) => {
        requests.push(String(url));
        if (String(url).includes("/api/v1/db/read/")) {
          expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-1");
          return Response.json({
            data: {
              dbKey: "agent-user-1-remote",
              name: "Remote cached",
              prompt: "Remote prompt",
              model: "gpt-4.1-mini",
            },
          });
        }
        return Response.json({
          choices: [{ message: { content: "remote cache ok" } }],
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "agent-user-1-remote",
      input: "hello",
    });

    expect(result.content).toBe("remote cache ok");
    expect(requests[0]).toBe("https://us.nolo.chat/api/v1/db/read/agent-user-1-remote");
    expect(memory.get("agent-user-1-remote")).toMatchObject({
      name: "Remote cached",
      serverOrigin: "https://us.nolo.chat",
    });
  });

  test("keeps local runtime runnable when the configured local server is down but a cluster server can provide agent config", async () => {
    const memory = new Map<string, any>();
    const requests: string[] = [];
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_SERVER: "http://127.0.0.1:38123",
        AUTH_TOKEN: "token-1",
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async (key) => {
          if (!memory.has(key)) throw new Error(`not found: ${key}`);
          return memory.get(key);
        },
        put: async (key, value) => {
          memory.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") memory.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      createId: () => "01CLUSTER",
      fetchImpl: async (url, init) => {
        const target = String(url);
        requests.push(target);
        if (target === "http://127.0.0.1:38123/api/v1/db/read/agent-user-1-cluster") {
          throw new Error("ConnectionRefused");
        }
        if (target === "https://nolo.chat/api/v1/db/read/agent-user-1-cluster") {
          expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-1");
          return Response.json({
            data: {
              dbKey: "agent-user-1-cluster",
              name: "Cluster cached",
              prompt: "Use cached config",
              model: "gpt-4.1-mini",
            },
          });
        }
        if (target === "http://127.0.0.1:11434/v1/chat/completions") {
          return Response.json({
            choices: [{ message: { content: "cluster cache ok" } }],
          });
        }
        if (target.includes("/api/v1/db/write/")) {
          return Response.json({ ok: true });
        }
        return new Response(null, { status: 404 });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "agent-user-1-cluster",
      input: "hello",
    });

    expect(result.content).toBe("cluster cache ok");
    expect(requests).toEqual([
      "http://127.0.0.1:38123/api/v1/db/read/agent-user-1-cluster",
      "https://nolo.chat/api/v1/db/read/agent-user-1-cluster",
      "http://127.0.0.1:11434/v1/chat/completions",
      "http://127.0.0.1:38123/api/v1/db/write/",
      "http://127.0.0.1:38123/api/v1/db/write/",
      "http://127.0.0.1:38123/api/v1/db/write/",
    ]);
    expect(memory.get("agent-user-1-cluster")).toMatchObject({
      name: "Cluster cached",
      serverOrigin: "https://nolo.chat",
    });
  });

  test("uses agent-owned custom credentials for local OpenAI-compatible requests", async () => {
    const requests: Array<{ url: string; auth: string | null; apiKeyHeader: string | null; body: any }> = [];
    const store = new Map<string, any>([
      ["agent-user-1-custom", {
        dbKey: "agent-user-1-custom",
        id: "custom",
        prompt: "Use custom provider.",
        model: "custom-coder",
        provider: "custom-openai-compatible",
        apiSource: "custom",
        customProviderUrl: "https://provider.example/v1/chat/completions",
        apiKey: "sk-agent-custom",
        apiKeyHeader: "api-key",
        temperature: 0.2,
        max_tokens: 4096,
        reasoning_effort: "medium",
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        OPENAI_API_KEY: "sk-custom",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          auth: new Headers(init?.headers).get("Authorization"),
          apiKeyHeader: new Headers(init?.headers).get("api-key"),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({
          choices: [{ message: { content: "custom ok" } }],
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "custom",
      input: "hello",
    });

    expect(result.content).toBe("custom ok");
    expect(result.provider).toBe("custom-openai-compatible");
    expect(requests[0]).toMatchObject({
      url: "https://provider.example/v1/chat/completions",
      auth: null,
      apiKeyHeader: "sk-agent-custom",
      body: {
        model: "custom-coder",
        stream: false,
        temperature: 0.2,
        max_tokens: 4096,
        reasoning_effort: "medium",
      },
    });
    expectMessagesWithEnrichedSystem(requests[0], [
      { role: "system", contains: "Use custom provider." },
      { role: "user", content: "hello" },
    ]);
    expect(toolNamesFromRequest(requests[0])).toEqual(DEFAULT_PRIVATE_LOCAL_TOOL_NAMES);
  });

  test("uses loopback transport for localhost custom providers when the default fetch path cannot connect", async () => {
    const store = new Map<string, any>([
      ["agent-user-1-localhost", {
        dbKey: "agent-user-1-localhost",
        id: "localhost",
        prompt: "Use localhost provider.",
        model: "Qwen3.6-27B-MTP-Q3_K_M.gguf",
        provider: "custom-openai-compatible",
        apiSource: "custom",
        customProviderUrl: "http://127.0.0.1:8080/v1/chat/completions",
      }],
    ]);
    const loopbackRequests: Array<{ url: string; body: any }> = [];
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async () => {
        throw new TypeError("Unable to connect. Is the computer able to access the url?");
      },
      loopbackRequest: async (url, init) => {
        loopbackRequests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({
          choices: [{ message: { content: "loopback ok" } }],
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "localhost",
      input: "hello",
    });

    expect(result.content).toBe("loopback ok");
    expect(loopbackRequests).toHaveLength(1);
    expect(loopbackRequests[0]).toMatchObject({
      url: "http://127.0.0.1:8080/v1/chat/completions",
      body: {
        model: "Qwen3.6-27B-MTP-Q3_K_M.gguf",
        stream: false,
      },
    });
    expectMessagesWithEnrichedSystem(loopbackRequests[0], [
      { role: "system", contains: "Use localhost provider." },
      { role: "user", content: "hello" },
    ]);
    expect(toolNamesFromRequest(loopbackRequests[0])).toEqual(DEFAULT_PRIVATE_LOCAL_TOOL_NAMES);
  });

  test("uses the Nolo chat proxy when local provider keys are absent", async () => {
    const requests: Array<{ url: string; auth: string | null; body: any }> = [];
    const store = new Map<string, any>([
      ["agent-user-1-frontend", {
        dbKey: "agent-user-1-frontend",
        id: "frontend",
        prompt: "Fix UI.",
        model: "accounts/fireworks/models/kimi-k2p6",
        provider: "fireworks",
        tools: ["writeFile"],
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_SERVER: "https://us.nolo.chat",
        AUTH_TOKEN: "token-1",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          auth: new Headers(init?.headers).get("Authorization"),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({
          choices: [{ message: { content: "platform ok" } }],
          usage: { prompt_tokens: 7, completion_tokens: 2 },
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "frontend",
      input: "make notifications cleaner",
    });

    expect(result.content).toBe("platform ok");
    expect(result.provider).toBe("fireworks");
    expect(requests[0]).toMatchObject({
      url: "https://us.nolo.chat/api/v1/chat",
      auth: "Bearer token-1",
      body: {
        model: "accounts/fireworks/models/kimi-k2p6",
        stream: false,
        tool_choice: "auto",
        url: "https://api.fireworks.ai/inference/v1/chat/completions",
        provider: "fireworks",
        agentKey: "agent-user-1-frontend",
      },
    });
    expectMessagesWithEnrichedSystem(requests[0], [
      { role: "system", contains: "Fix UI." },
      { role: "user", content: "make notifications cleaner" },
    ]);
    expect(toolNamesFromRequest(requests[0])).toEqual([
      "ui_ask_choice",
      ...LEGACY_WRITE_LOCAL_CODING_TOOL_NAMES,
      "rememberMemory",
      "exa_search",
      "fetchWebpage",
      ...DEFAULT_PRIVATE_NOLO_WORKSPACE_TOOL_NAMES,
      "startAgentRun",
      "controlAgentRun",
    ]);
  });

  test("uses the Nolo chat proxy for platform agents even when direct provider env exists", async () => {
    const requests: Array<{ url: string; auth: string | null; body: any }> = [];
    const store = new Map<string, any>([
      ["agent-user-1-frontend", {
        dbKey: "agent-user-1-frontend",
        id: "frontend",
        prompt: "Fix UI.",
        model: "accounts/fireworks/models/kimi-k2p6",
        provider: "fireworks",
        apiSource: "platform",
        useServerProxy: true,
        tools: ["readFile"],
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_SERVER: "https://us.nolo.chat",
        AUTH_TOKEN: "token-1",
        OPENAI_API_KEY: "sk-direct",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          auth: new Headers(init?.headers).get("Authorization"),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({
          choices: [{ message: { content: "platform ok" } }],
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "frontend",
      input: "inspect",
    });

    expect(result.content).toBe("platform ok");
    expect(requests[0]).toMatchObject({
      url: "https://us.nolo.chat/api/v1/chat",
      auth: "Bearer token-1",
      body: {
        provider: "fireworks",
        apiSource: "platform",
        agentKey: "agent-user-1-frontend",
      },
    });
  });

  test("retries DeepSeek Responses as Chat Completions through an older platform proxy", async () => {
    const requests: Array<{ url: string; body: any }> = [];
    const store = new Map<string, any>([
      ["agent-user-1-deepseek", {
        dbKey: "agent-user-1-deepseek",
        id: "deepseek",
        prompt: "Reply exactly as requested.",
        model: "deepseek-v4-flash",
        provider: "deepseek",
        apiSource: "platform",
        useServerProxy: true,
        tools: ["readFile"],
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_SERVER: "https://nolo.chat",
        AUTH_TOKEN: "token-1",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
        });
        if (requests.length === 1) {
          return Response.json(
            {
              error: {
                message:
                  "Failed to deserialize the JSON body into the target type: tools[0]: missing field `function`",
                code: "UPSTREAM_400",
              },
            },
            { status: 400 },
          );
        }
        return Response.json({
          choices: [{ message: { content: "PONG" } }],
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "deepseek",
      input: "Reply PONG",
    });

    expect(result.content).toBe("PONG");
    const turnRequests = requests.filter(
      (request) => request.body.agentKey === "agent-user-1-deepseek",
    );
    expect(turnRequests).toHaveLength(2);
    expect(turnRequests[0].body).toMatchObject({
      url: "https://api.deepseek.com/v1/responses",
      input: expect.any(Array),
    });
    expect(turnRequests[0].body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function", name: "readFile" }),
      ]),
    );
    expect(turnRequests[1].body).toMatchObject({
      url: "https://api.deepseek.com/chat/completions",
      messages: expect.any(Array),
    });
    expect(turnRequests[1].body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({ name: "readFile" }),
        }),
      ]),
    );
    expect(turnRequests[1].body.input).toBeUndefined();
  });

  test("retries transient certificate failures from the platform chat proxy", async () => {
    let attempts = 0;
    const store = new Map<string, any>([
      ["agent-user-1-frontend", {
        dbKey: "agent-user-1-frontend",
        id: "frontend",
        prompt: "Fix UI.",
        model: "accounts/fireworks/models/kimi-k2p6",
        provider: "fireworks",
        apiSource: "platform",
        useServerProxy: true,
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_SERVER: "https://us.nolo.chat",
        AUTH_TOKEN: "token-1",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.includes("/api/v1/db/write/")) {
          return Response.json({ ok: true });
        }
        if (target.includes("/api/v1/db/read/")) {
          return Response.json({
            data: store.get("agent-user-1-frontend"),
          });
        }
        attempts += 1;
        if (attempts <= 2) {
          throw new Error("unknown certificate verification error");
        }
        return Response.json({
          choices: [{ message: { content: "platform retry ok" } }],
        });
      },
      sleep: async () => {},
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "frontend",
      input: "inspect",
    });

    expect(result.content).toBe("platform retry ok");
    expect(attempts).toBe(3);
  });

  test("waits through repeated platform drain responses before starting the provider turn", async () => {
    let attempts = 0;
    const retryDelays: number[] = [];
    const store = new Map<string, any>([
      ["agent-user-1-frontend", {
        dbKey: "agent-user-1-frontend",
        id: "frontend",
        prompt: "Fix UI.",
        model: "accounts/fireworks/models/kimi-k2p6",
        provider: "fireworks",
        apiSource: "platform",
        useServerProxy: true,
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_SERVER: "https://us.nolo.chat",
        AUTH_TOKEN: "token-1",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.includes("/api/v1/db/write/")) {
          return Response.json({ ok: true });
        }
        if (target.includes("/api/v1/db/read/")) {
          return Response.json({
            data: store.get("agent-user-1-frontend"),
          });
        }
        attempts += 1;
        if (attempts <= 4) {
          return Response.json(
            {
              error: "Server draining",
              reason: "core_draining",
              retryable: true,
              retryAfterMs: 0,
            },
            { status: 503, headers: { "Retry-After": "0" } },
          );
        }
        return Response.json({
          choices: [{ message: { content: "platform resumed" } }],
        });
      },
      sleep: async (ms) => {
        retryDelays.push(ms);
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "frontend",
      input: "inspect",
    });

    expect(result.content).toBe("platform resumed");
    expect(attempts).toBe(5);
    expect(retryDelays).toEqual([0, 0, 0, 0]);
  });

  test("keeps retrying repeated transient certificate failures with backoff hooks", async () => {
    let attempts = 0;
    const retryDelays: number[] = [];
    const store = new Map<string, any>([
      ["agent-user-1-frontend", {
        dbKey: "agent-user-1-frontend",
        id: "frontend",
        prompt: "Fix UI.",
        model: "accounts/fireworks/models/kimi-k2p6",
        provider: "fireworks",
        apiSource: "platform",
        useServerProxy: true,
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_SERVER: "https://us.nolo.chat",
        AUTH_TOKEN: "token-1",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.includes("/api/v1/db/write/")) {
          return Response.json({ ok: true });
        }
        attempts += 1;
        if (attempts <= 3) {
          throw new Error("unknown certificate verification error");
        }
        return Response.json({
          choices: [{ message: { content: "platform longer retry ok" } }],
        });
      },
      sleep: async (ms) => {
        retryDelays.push(ms);
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "frontend",
      input: "inspect",
    });

    expect(result.content).toBe("platform longer retry ok");
    expect(attempts).toBe(4);
    expect(retryDelays.length).toBe(1);
    expect(retryDelays[0]).toBeGreaterThan(0);
  });

  test("saves local tool call trace and shell metadata into the local dialog", async () => {
    const store = new Map<string, any>([
      ["agent-user-1-shell", {
        dbKey: "agent-user-1-shell",
        id: "shell",
        prompt: "Use shell.",
        model: "gpt-4.1-mini",
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      cwd: import.meta.dir,
      now: () => 1710000000000,
      createId: () => "01TRACE",
      localToolExecutors: {
        execShell: async () => ({
          content: "stdout:\ntrace-ok\n\nexitCode: 0",
          metadata: { exitCode: 0, timedOut: false },
        }),
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const hasToolResult = body.messages.some((message: any) => message.role === "tool");
        if (!hasToolResult) {
          return Response.json({
            choices: [{
              message: {
                content: "",
                tool_calls: [{
                  id: "call-shell",
                  type: "function",
                  function: {
                    name: "execShell",
                    arguments: JSON.stringify({
                      cmd: process.platform === "win32"
                        ? "Write-Output trace-ok"
                        : "printf trace-ok",
                    }),
                  },
                }],
              },
            }],
          });
        }
        return Response.json({
          choices: [{ message: { content: "done" } }],
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "shell",
      input: "inspect",
    });

    expect(result.dialogId).toBe("01TRACE");
    expect(store.get("dialog-user-1-01TRACE")).toMatchObject({
      toolCallCount: 1,
      localRuntime: expect.objectContaining({
        host: "cli",
        worktreePath: import.meta.dir,
      }),
    });
    const messages = [...store.entries()]
      .filter(([key]) => key.startsWith("dialog-01TRACE-msg-"))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(messages[1]).toMatchObject({
      tool_calls: [{
        id: "call-shell",
        function: { name: "execShell" },
      }],
    });
    expect(messages[2]).toMatchObject({
      role: "tool",
      toolCallId: "call-shell",
      metadata: { exitCode: 0 },
    });
    expect(messages[2].content).toContain("trace-ok");
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: "done",
    });
  });

  test("builds provider OpenAI tools once per resolveProvider across tool rounds", async () => {
    let buildOpenAiToolsCalls = 0;
    const store = new Map<string, any>([
      ["agent-user-1-shell", {
        dbKey: "agent-user-1-shell",
        id: "shell",
        prompt: "Use shell.",
        model: "gpt-4.1-mini",
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      cwd: import.meta.dir,
      now: () => 1710000000000,
      createId: () => "01TOOLCACHE",
      buildProviderOpenAiTools: (args) => {
        buildOpenAiToolsCalls += 1;
        return [
          {
            type: "function",
            function: {
              name: "execShell",
              description: "Run shell",
              parameters: {
                type: "object",
                properties: {
                  cmd: { type: "string" },
                },
                required: ["cmd"],
              },
            },
          },
        ];
      },
      localToolExecutors: {
        execShell: async () => ({
          content: "stdout:\ncached-tools-ok\n\nexitCode: 0",
          metadata: { exitCode: 0, timedOut: false },
        }),
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const hasToolResult = body.messages.some((message: any) => message.role === "tool");
        if (!hasToolResult) {
          return Response.json({
            choices: [{
              message: {
                content: "",
                tool_calls: [{
                  id: "call-shell-cache",
                  type: "function",
                  function: {
                    name: "execShell",
                    arguments: JSON.stringify({
                      cmd: process.platform === "win32"
                        ? "Write-Output cached-tools-ok"
                        : "printf cached-tools-ok",
                    }),
                  },
                }],
              },
            }],
          });
        }
        return Response.json({
          choices: [{ message: { content: "cached tools done" } }],
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "shell",
      input: "inspect",
    });

    expect(result.content).toBe("cached tools done");
    expect(buildOpenAiToolsCalls).toBe(1);
  });

  test("returns tool budget errors to the local loop", async () => {
    const store = new Map<string, any>([
      ["agent-user-1-reader", {
        dbKey: "agent-user-1-reader",
        id: "reader",
        prompt: "Read narrowly",
        model: "gpt-4.1-mini",
        provider: "openai-compatible",
        tools: ["readFile"],
      }],
    ]);
    let requestCount = 0;
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_LOCAL_OPENAI_BASE_URL: "https://llm.example/v1",
        NOLO_LOCAL_OPENAI_API_KEY: "sk-test",
        NOLO_LOCAL_TOOL_BUDGETS: "readFile=1",
      },
      store: {
        read: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: () => (async function* () {})(),
      },
      cwd: import.meta.dir,
      now: () => 1710000000000,
      createId: () => "01BUDGET",
      localToolExecutors: {
        readFile: async () => ({ content: "file content" }),
      },
      fetchImpl: async (_url, init) => {
        requestCount += 1;
        const body = JSON.parse(String(init?.body));
        const toolMessages = body.messages.filter((message: any) => message.role === "tool");
        if (toolMessages.some((message: any) => String(message.content).includes("exceeded local tool budget"))) {
          return Response.json({ choices: [{ message: { content: "budget handled" } }] });
        }
        return Response.json({
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: `call-read-${requestCount}`,
                type: "function",
                function: {
                  name: "readFile",
                  arguments: JSON.stringify({ path: "file.ts" }),
                },
              }],
            },
          }],
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "agent-user-1-reader",
      input: "inspect",
    });

    expect(result.content).toBe("budget handled");
    const messages = [...store.values()];
    expect(messages.some((message) => String(message.content).includes("exceeded local tool budget 1"))).toBe(true);
  });

  test("continues a local dialog instead of creating a new one", async () => {
    const store = new Map<string, any>([
      ["agent-user-1-frontend", {
        dbKey: "agent-user-1-frontend",
        id: "frontend",
        prompt: "Fix UI",
        model: "gpt-4.1-mini",
      }],
      ["dialog-user-1-dialog-existing", {
        dbKey: "dialog-user-1-dialog-existing",
        id: "dialog-existing",
        type: "dialog",
        userId: "user-1",
        title: "Existing dialog",
      }],
      ["dialog-dialog-existing-msg-001", {
        dbKey: "dialog-dialog-existing-msg-001",
        id: "msg-001",
        dialogId: "dialog-existing",
        role: "assistant",
        content: "previous answer",
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key, value) => {
          store.set(key, value);
        },
        batch: async (ops) => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.key, op.value);
          }
        },
        iterator: ({ gte, lte }) => (async function* () {
          for (const entry of [...store.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            if (entry[0] >= gte && entry[0] <= lte) yield entry;
          }
        })(),
      },
      now: () => 1710000000000,
      createId: () => "SHOULDNOTUSE",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.messages).toContainEqual({
          role: "assistant",
          content: "previous answer",
        });
        return Response.json({
          choices: [{ message: { content: "continued" } }],
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "frontend",
      input: "continue",
      continueDialogId: "dialog-existing",
    });

    expect(result.dialogId).toBe("dialog-existing");
    expect(store.has("dialog-user-1-SHOULDNOTUSE")).toBe(false);
    expect(store.get("dialog-user-1-dialog-existing")).toMatchObject({
      id: "dialog-existing",
      title: "Existing dialog",
      status: "done",
    });
    expect([...store.keys()].filter((key) => key.startsWith("dialog-dialog-existing-msg-"))).toContain(
      "dialog-dialog-existing-msg-1710000000000-001"
    );
  });

  test("passes image_url message parts through to OpenAI-compatible providers", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-vision",
          prompt: "Describe images.",
          model: "gpt-4.1-mini",
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          choices: [{ message: { content: "image ok" } }],
        });
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: "vision",
      input: [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ],
    });

    expect(requests[0]?.body.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ],
    });
  });

  test("allows registered execShell by default", async () => {
    const adapter = createAdapter({
      env: {},
      db: {
        get: async () => ({
          dbKey: "shell",
          prompt: "Use shell.",
          toolNames: ["execShell"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      localToolExecutors: {
        execShell: async (call) => ({ content: `shell:${call.arguments}` }),
      },
      fetchImpl: async () => Response.json({}),
    });
    await adapter.loadAgentConfig("shell");

    const result = await adapter.executeTool({
      id: "call-1",
      name: "execShell",
      arguments: "{\"cmd\":\"pwd\"}",
    });

    expect(result.content).toContain("\"cmd\":\"pwd\"");
  });

  test("executes explicitly allowed registered local tools declared by the agent", async () => {
    const store = new Map<string, any>([
      ["agent-user-1-reader", {
        dbKey: "agent-user-1-reader",
        id: "reader",
        prompt: "Read files.",
        toolNames: ["readFile"],
      }],
    ]);
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_LOCAL_ALLOWED_TOOLS: "readFile",
      },
      db: {
        get: async (key) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      localToolExecutors: {
        readFile: async (call) => ({ content: `read:${call.arguments}` }),
      },
      fetchImpl: async () => Response.json({}),
    });

    await adapter.loadAgentConfig("reader");
    const result = await adapter.executeTool({
      id: "call-1",
      name: "readFile",
      arguments: "{\"path\":\"README.md\"}",
    });

    expect(result.content).toContain("README.md");
  });

  test("advertises execShell to OpenAI-compatible providers by default", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-shell",
          prompt: "Use shell.",
          model: "gpt-4.1-mini",
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          choices: [{ message: { content: "done" } }],
        });
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: "shell",
      input: "pwd",
    });

    expect(toolNamesFromRequest(requests[0])).toEqual([
      "ui_ask_choice",
      ...SHELL_LOCAL_CODING_TOOL_NAMES,
      "rememberMemory",
      "exa_search",
      "fetchWebpage",
      ...DEFAULT_PRIVATE_NOLO_WORKSPACE_TOOL_NAMES,
      // CLI 空配置默认补 agent-orchestration 能力包：编排工具本地执行器已接入
      // （MED-1 修复），注册进工具面。
      "startAgentRun",
      "controlAgentRun",
    ]);
  });

  test("keeps fullstack local model tools to the compact coding surface", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: FULLSTACK_TEST_AGENT_KEY,
          prompt: "Use local coding tools.",
          model: "mimo-v2.5-pro",
          provider: "custom",
          tools: [
            "read",
            "searchDialogMessages",
            "searchFiles",
            "codeSearch",
            "listFiles",
            "readFile",
            "writeFile",
            "editFile",
            "searchFiles",
            "legacyLocalAlias",
            "applyPatch",
            "execShell",
            "checkEnv",
            "queryTableRows",
          ],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          choices: [{ message: { content: "done" } }],
        });
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: FULLSTACK_TEST_AGENT_KEY,
      input: "inspect cwd",
    });

    expect(toolNamesFromRequest(requests[0])).toEqual([
      "ui_ask_choice",
      ...SHELL_LOCAL_CODING_TOOL_NAMES,
      "rememberMemory",
      "exa_search",
      "fetchWebpage",
      // CLI 空配置默认补 agent-orchestration 能力包：listAgents 候选发现 +
      // 本地 --bg 编排执行器（MED-1 修复）。
      "listAgents",
      // skills 能力包默认启用：readSkillDoc/loadSkill 进入 CLI 工具面。
      "readSkillDoc",
      "loadSkill",
      "queryTableRows",
      "startAgentRun",
      "controlAgentRun",
    ]);
  });

  test("can expose only declared local workspace tools for tool ablations", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
        NOLO_LOCAL_WORKSPACE_TOOLSET: "declared-only",
      },
      db: {
        get: async () => ({
          dbKey: FULLSTACK_TEST_AGENT_KEY,
          prompt: "Use exactly the declared local tools.",
          model: "mimo-v2.5-pro",
          provider: "custom",
          tools: ["listFiles", "readFile", "execShell"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          choices: [{ message: { content: "done" } }],
        });
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: FULLSTACK_TEST_AGENT_KEY,
      input: "inspect cwd",
    });

    expect(toolNamesFromRequest(requests[0])).toEqual(["ui_ask_choice", "listFiles", "readFile", "execShell"]);
  });

  test("defaults local workspace tools to strategy descriptions and rich parameters", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
        NOLO_LOCAL_WORKSPACE_TOOLSET: "declared-only",
      },
      db: {
        get: async () => ({
          dbKey: FULLSTACK_TEST_AGENT_KEY,
          prompt: "Use local coding tools.",
          model: "mimo-v2.5-pro",
          provider: "custom",
          tools: ["listFiles", "readFile", "globFiles", "searchFiles"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          choices: [{ message: { content: "done" } }],
        });
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: FULLSTACK_TEST_AGENT_KEY,
      input: "inspect cwd",
    });

    const tools = new Map(
      requests[0]?.body.tools.map((tool: any) => [tool.function.name, tool.function]),
    );
    const listFiles = tools.get("listFiles") as any;
    const readFile = tools.get("readFile") as any;
    const globFiles = tools.get("globFiles") as any;
    const searchFiles = tools.get("searchFiles") as any;

    expect(listFiles.description).toContain("not for path-pattern discovery across the repo");
    expect(publicSchemaKeys(listFiles)).toEqual([
      "path",
      "maxDepth",
      "maxResults",
      "entryType",
    ]);
    expect(readFile.description).toContain("Use lines ranges");
    expect(publicSchemaKeys(readFile)).toEqual(["path", "lines"]);
    expect(globFiles.description).toContain("any file discovery task");
    expect(publicSchemaKeys(globFiles)).toEqual([
      "pattern",
      "path",
      "exclude",
      "includeIgnored",
      "maxResults",
    ]);
    expect(searchFiles.description).toContain("using ripgrep when available");
    expect(publicSchemaKeys(searchFiles)).toEqual([
      "query",
      "path",
      "exclude",
      "includeIgnored",
      "maxResults",
      "literal",
      "caseSensitive",
      "contextLines",
    ]);
  });

  test("exposes and executes readPastedText for a paste-aware local turn", async () => {
    const requests: Array<{ body: any }> = [];
    const pasteStore = createCollapsedPasteStore();
    const { id } = allocateCollapsedPaste(
      pasteStore,
      Array.from({ length: 220 }, (_, index) => `paste-line-${index + 1}`).join("\n"),
    );
    let providerCalls = 0;
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      pastedTextStore: pasteStore,
      db: {
        get: async () => ({
          dbKey: "paste-agent",
          prompt: "Use the paste reader when a paste reference is present.",
          model: "fake-local",
          provider: "custom",
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push({ body });
        providerCalls += 1;
        if (providerCalls === 1) {
          return Response.json({
            choices: [{
              message: {
                content: "",
                tool_calls: [{
                  id: "call-paste",
                  type: "function",
                  function: {
                    name: "readPastedText",
                    arguments: JSON.stringify({ pasteId: id }),
                  },
                }],
              },
            }],
          });
        }
        return Response.json({
          choices: [{ message: { content: "paste read" } }],
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "paste-agent",
      input: "inspect the pasted reference",
    });

    expect(result.content).toBe("paste read");
    const tools = new Map(
      requests[0]?.body.tools.map((tool: any) => [tool.function.name, tool.function]),
    );
    expect(tools.has("readPastedText")).toBe(true);
    expect((tools.get("readPastedText") as any).parameters.required).toEqual(["pasteId"]);
    const toolMessage = requests[1]?.body.messages.find((message: any) => message.role === "tool");
    expect(toolMessage?.content).toContain("paste-line-1");
    expect(toolMessage?.content).toContain("totalLines");
  });

  test("can vary globFiles schema through local runtime env", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
        NOLO_GLOBFILES_DESCRIPTION_VARIANT: "antiShell",
        NOLO_GLOBFILES_PARAMETER_VARIANT: "rich",
      },
      db: {
        get: async () => ({
          dbKey: FULLSTACK_TEST_AGENT_KEY,
          prompt: "Use local coding tools.",
          model: "mimo-v2.5-pro",
          provider: "custom",
          tools: ["globFiles"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          choices: [{ message: { content: "done" } }],
        });
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: FULLSTACK_TEST_AGENT_KEY,
      input: "find tests",
    });

    const globFiles = requests[0]?.body.tools.find((tool: any) => tool.function.name === "globFiles")?.function;
    expect(globFiles.description).toContain("Do not use execShell or listFiles for path discovery");
    expect(publicSchemaKeys(globFiles)).toEqual([
      "pattern",
      "path",
      "exclude",
      "includeIgnored",
      "maxResults",
    ]);
  });

  test("can vary listFiles schema through local runtime env", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
        NOLO_LISTFILES_DESCRIPTION_VARIANT: "antiShell",
        NOLO_LISTFILES_PARAMETER_VARIANT: "rich",
      },
      db: {
        get: async () => ({
          dbKey: FULLSTACK_TEST_AGENT_KEY,
          prompt: "Use local coding tools.",
          model: "mimo-v2.5-pro",
          provider: "custom",
          tools: ["listFiles"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          choices: [{ message: { content: "done" } }],
        });
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: FULLSTACK_TEST_AGENT_KEY,
      input: "list directories",
    });

    const listFiles = requests[0]?.body.tools.find((tool: any) => tool.function.name === "listFiles")?.function;
    expect(listFiles.description).toContain("Do not use execShell with ls/find/tree");
    expect(publicSchemaKeys(listFiles)).toEqual([
      "path",
      "maxDepth",
      "maxResults",
      "entryType",
    ]);
  });

  test("can vary readFile schema through local runtime env", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
        NOLO_READFILE_DESCRIPTION_VARIANT: "strategy",
        NOLO_READFILE_PARAMETER_VARIANT: "rich",
      },
      db: {
        get: async () => ({
          dbKey: FULLSTACK_TEST_AGENT_KEY,
          prompt: "Use local coding tools.",
          model: "mimo-v2.5-pro",
          provider: "custom",
          tools: ["readFile"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          choices: [{ message: { content: "done" } }],
        });
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: FULLSTACK_TEST_AGENT_KEY,
      input: "read a file range",
    });

    const readFile = requests[0]?.body.tools.find((tool: any) => tool.function.name === "readFile")?.function;
    expect(readFile.description).toContain("Use lines ranges");
    expect(readFile.parameters.properties.lines.description).toContain("each readFile preview consumes one budget slot");
    expect(publicSchemaKeys(readFile)).toEqual(["path", "lines"]);
  });

  test("can vary searchFiles schema through local runtime env", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
        NOLO_SEARCHFILES_DESCRIPTION_VARIANT: "antiShell",
        NOLO_SEARCHFILES_PARAMETER_VARIANT: "rich",
      },
      db: {
        get: async () => ({
          dbKey: FULLSTACK_TEST_AGENT_KEY,
          prompt: "Use local coding tools.",
          model: "mimo-v2.5-pro",
          provider: "custom",
          tools: ["searchFiles"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          choices: [{ message: { content: "done" } }],
        });
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: FULLSTACK_TEST_AGENT_KEY,
      input: "find TODO",
    });

    const searchFiles = requests[0]?.body.tools.find((tool: any) => tool.function.name === "searchFiles")?.function;
    expect(searchFiles.description).toContain("Do not use execShell for content search");
    expect(publicSchemaKeys(searchFiles)).toEqual([
      "query",
      "path",
      "exclude",
      "includeIgnored",
      "maxResults",
      "literal",
      "caseSensitive",
      "contextLines",
    ]);
  });

  test("allows default semantic workspace tools without legacy agent tool declarations", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "nolo-cli-runtime-"));
    try {
      await Bun.write(join(workspaceRoot, "README.md"), "local ok\n");
      const adapter = createAdapter({
        env: {},
        cwd: workspaceRoot,
        db: {
          get: async () => ({
            dbKey: "agent-local-default-tools",
            prompt: "Use local workspace tools.",
            model: "gpt-4.1-mini",
          }),
          put: async () => {},
          batch: async () => {},
          iterator: () => (async function* () {})(),
        },
        fetchImpl: async () => Response.json({}),
      });

      await adapter.loadAgentConfig("default-tools");
      await expect(adapter.executeTool({
        id: "call-read",
        name: "readFile",
        arguments: JSON.stringify({ path: "README.md" }),
      })).resolves.toMatchObject({
        content: "local ok\n",
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("exposes declared server table write tools in local runtime requests", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-table",
          prompt: "Use table tools.",
          model: "gpt-4.1-mini",
          toolNames: ["createTable", "addTableRow", "addTableRows"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          choices: [{ message: { content: "done" } }],
        });
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: "table",
      input: "采集并写入 table",
    });

    const toolNames = toolNamesFromRequest(requests[0]);
    expect(toolNames).toContain("createTable");
    expect(toolNames).toContain("addTableRow");
    expect(toolNames).toContain("addTableRows");
  });

  test("executes declared createTable through the server table bridge when capture is explicit", async () => {
    const requests: Array<{ url: string; auth: string | null; body: any }> = [];
    const adapter = createAdapter({
      env: {
        NOLO_SERVER: "https://us.nolo.chat",
        AUTH_TOKEN: "token-1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-table-write",
          toolNames: ["createTable"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          auth: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({
          ok: true,
          tenantId: "user-1",
          tableId: "table-1",
        });
      },
    });

    await adapter.loadAgentConfig("table-write");
    const result = await adapter.executeTool({
      id: "call-create-table",
      name: "createTable",
      userInput: "采集这个用户并写入 table",
      arguments: JSON.stringify({
        title: "XHS profile",
        purpose: "agent_eval_workbench",
        columns: [{ name: "nickname" }],
      }),
    });

    expect(requests).toEqual([
      {
        url: "https://us.nolo.chat/api/table/create",
        auth: "Bearer token-1",
        body: {
          title: "XHS profile",
          purpose: "agent_eval_workbench",
          columns: [{ name: "nickname" }],
        },
      },
    ]);
    expect(result.content).toContain("\"tableId\":\"table-1\"");
    expect(result.metadata).toMatchObject({
      serverPlatformTool: true,
      tableWrite: true,
    });
  });

  test("blocks local table writes when the current user request is not explicit capture", async () => {
    const adapter = createAdapter({
      env: {
        NOLO_SERVER: "https://us.nolo.chat",
        AUTH_TOKEN: "token-1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-table-blocked",
          toolNames: ["createTable"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async () => {
        throw new Error("blocked createTable must not reach the server");
      },
    });

    await adapter.loadAgentConfig("table-blocked");
    const result = await adapter.executeTool({
      id: "call-create-table-blocked",
      name: "createTable",
      userInput: "总结这个用户画像",
      arguments: JSON.stringify({
        title: "XHS profile",
        columns: [{ name: "nickname" }],
      }),
    });

    const parsed = JSON.parse(result.content);
    expect(parsed.error).toBe("knowledge_capture_requires_confirmation");
    expect(result.metadata).toMatchObject({
      serverPlatformTool: true,
      tableWriteBlocked: true,
    });
  });

  test("adds typed CLI workspace tools to the default nolo local agent request", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-pub-01NOLOAPPBLD000000019KCKT0",
          id: "01NOLOAPPBLD000000019KCKT0",
          name: "nolo",
          prompt: "Route through typed tools.",
          model: "gpt-4.1-mini",
          tools: ["fetchWebpage"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          choices: [{ message: { content: "done" } }],
        });
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: "agent-pub-01NOLOAPPBLD000000019KCKT0",
      input: "帮我总结最近 10 个对话",
    });

    const toolNames = toolNamesFromRequest(requests[0]);
    expect(toolNames).toContain("listDialogs");
    expect(toolNames).toContain("readDialog");
    expect(toolNames).toContain("listAgents");
    expect(toolNames).toContain("readSpace");
    expect(toolNames).toContain("queryTableRows");
  });

  test("executes typed CLI workspace tools through whitelisted nolo commands", async () => {
    const spawnCalls: Array<{ cmd: string[]; env: NodeJS.ProcessEnv }> = [];
    const originalSpawn = Bun.spawn;
    Bun.spawn = ((options: { cmd: string[]; env: NodeJS.ProcessEnv }) => {
      spawnCalls.push(options);
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("dialog output\n"));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;

    try {
      const adapter = createAdapter({
        env: {
          NOLO_LOCAL_USER_ID: "user-1",
          AUTH_TOKEN: "token-1",
        },
        db: {
          get: async () => ({
            dbKey: "agent-pub-01NOLOAPPBLD000000019KCKT0",
            id: "01NOLOAPPBLD000000019KCKT0",
          }),
          put: async () => {},
          batch: async () => {},
          iterator: () => (async function* () {})(),
        },
        fetchImpl: async () => Response.json({}),
      });

      await adapter.loadAgentConfig("agent-pub-01NOLOAPPBLD000000019KCKT0");
      const result = await adapter.executeTool({
        id: "call-list-dialogs",
        name: "listDialogs",
        arguments: JSON.stringify({ limit: 3 }),
      });

      expect(result.content).toBe("dialog output\n");
      expect(result.metadata).toMatchObject({
        cliWorkspaceTool: true,
        exitCode: 0,
      });
      const cliEntrypoint = spawnCalls[0]?.cmd.at(-5) ?? "";
      expect(
        cliEntrypoint.endsWith("packages/cli/index.ts") ||
          cliEntrypoint.endsWith("packages/cli/dist/index.ts"),
      ).toBe(true);
      expect(spawnCalls[0]?.cmd.slice(-4)).toEqual([
        "dialog",
        "list",
        "--limit",
        "3",
      ]);
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  test("runs execShell locally by default", async () => {
    const adapter = createAdapter({
      env: {},
      db: {
        get: async () => ({
          dbKey: "agent-local-shell",
          toolNames: ["execShell"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      cwd: import.meta.dir,
      localToolExecutors: {
        execShell: async () => ({
          content: import.meta.dir,
          metadata: { exitCode: 0, timedOut: false },
        }),
      },
      fetchImpl: async () => Response.json({}),
    });

    await adapter.loadAgentConfig("shell");
    const result = await adapter.executeTool({
      id: "call-1",
      name: "execShell",
      arguments: "{\"cmd\":\"pwd\"}",
    });

    expect(result.content).toContain(import.meta.dir);
    expect(result.metadata).toMatchObject({ exitCode: 0 });
  });

  test("confirms destructive shell command and retries when callback returns true", async () => {
    const permissionRequests: PermissionRequest[] = [];
    const shellCalls: { args: any; confirmed?: boolean }[] = [];
    const adapter = createAdapter({
      env: {},
      db: {
        get: async () => ({
          dbKey: "agent-local-shell-destructive",
          toolNames: ["execShell"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      cwd: import.meta.dir,
      localToolExecutors: {
        execShell: async (call: any) => {
          shellCalls.push({ args: call.arguments, confirmed: call.confirmed });
          return {
            content: "deleted",
            metadata: { exitCode: 0, timedOut: false },
          };
        },
      },
      confirmDestructiveAction: async (request) => {
        permissionRequests.push(request);
        return true;
      },
      fetchImpl: async () => Response.json({}),
    });

    await adapter.loadAgentConfig("shell-destructive");
    const result = await adapter.executeTool({
      id: "call-1",
      name: "execShell",
      arguments: JSON.stringify({ cmd: "rm -rf tmp" }),
    });
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]).toMatchObject({
      tool: "execShell",
      action: "destructive_shell_command",
    });
    expect(shellCalls).toHaveLength(1);
    expect(result.content).toBe("deleted");
    expect(result.metadata).toMatchObject({ exitCode: 0 });
  });

  test("rejects destructive shell command when confirmation callback returns false", async () => {
    const adapter = createAdapter({
      env: {},
      db: {
        get: async () => ({
          dbKey: "agent-local-shell-destructive-deny",
          toolNames: ["execShell"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      cwd: import.meta.dir,
      localToolExecutors: {
        execShell: async () => ({ content: "deleted", metadata: { exitCode: 0 } }),
      },
      confirmDestructiveAction: async () => false,
      fetchImpl: async () => Response.json({}),
    });

    await adapter.loadAgentConfig("shell-destructive-deny");
    await expect(
      adapter.executeTool({
        id: "call-1",
        name: "execShell",
        arguments: JSON.stringify({ cmd: "rm -rf tmp" }),
      })
    ).rejects.toMatchObject({
      code: "destructive_action_requires_confirmation",
    });
  });

  test("applies runtime policy shell settings to local executors without adding a timeout", async () => {
    const requests: Array<{ body: any }> = [];
    const shellCalls: any[] = [];
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-shell-limits",
          prompt: "Use shell when needed.",
          model: "qwen-coder",
          runtimeToolPolicy: {
            version: 1,
            runtimeTools: ["execShell"],
            shell: { enabled: true, mode: "worktree", maxOutputBytes: 120 },
          },
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      cwd: import.meta.dir,
      localToolExecutors: {
        execShell: async (call) => {
          shellCalls.push(call);
          return {
            content: "x".repeat(50),
            metadata: { exitCode: 0, timedOut: false },
          };
        },
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        if (requests.length === 1) {
          return Response.json({
            choices: [{
              message: {
                content: "",
                tool_calls: [{
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "execShell",
                    arguments: JSON.stringify({
                      cmd: process.platform === "win32"
                        ? "'abcdefghijklmnopqrstuvwxyz0123456789'"
                        : "node -e 'console.log(\"x\".repeat(50))'",
                    }),
                  },
                }],
              },
            }],
          });
        }
        return Response.json({
          choices: [{ message: { content: "limits applied" } }],
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "shell-limits",
      input: "run output limit check",
    });

    expect(result.content).toBe("limits applied");
    const toolResult = requests[1]?.body.messages.at(-1)?.content ?? "";
    expect(toolResult).toContain("xxxxxxxx");
    expect(toolResult).not.toContain("command timed out");
    expect(shellCalls).toHaveLength(1);
    expect(JSON.parse(shellCalls[0].arguments)).not.toHaveProperty("commandTimeoutMs");
  });

  test("accepts execShell aliases from the local model", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-shell-alias",
          prompt: "Use shell when needed.",
          model: "qwen-coder",
          toolNames: ["execShell"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      cwd: import.meta.dir,
      localToolExecutors: {
        execShell: async () => ({
          content: import.meta.dir,
          metadata: { exitCode: 0, timedOut: false },
        }),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        if (requests.length === 1) {
          return Response.json({
            choices: [{
              message: {
                content: "",
                tool_calls: [{
                  id: "call-1",
                  type: "function",
                  function: { name: "runCommand", arguments: "{\"cmd\":\"pwd\"}" },
                }],
              },
            }],
          });
        }
        return Response.json({
          choices: [{ message: { content: "alias ok" } }],
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "shell",
      input: "print cwd",
    });

    expect(result.content).toBe("alias ok");
    expect(requests[1]?.body.messages.at(-1)?.content).toContain(import.meta.dir);
  });

  test("pauses for manual terminal action and resumes the same local turn", async () => {
    const requests: Array<{ body: any }> = [];
    const userActions: any[] = [];
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-shell-manual-action",
          prompt: "Use shell when needed.",
          model: "qwen-coder",
          toolNames: ["execShell"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      cwd: import.meta.dir,
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        if (requests.length === 1) {
          return Response.json({
            choices: [{
              message: {
                content: "",
                tool_calls: [{
                  id: "call-auth",
                  type: "function",
                  function: {
                    name: "execShell",
                    arguments: JSON.stringify({ command: "gh auth refresh -h github.com -s delete_repo" }),
                  },
                }],
              },
            }],
          });
        }
        const lastToolMessage = requests[1]?.body.messages.at(-1);
        expect(lastToolMessage?.role).toBe("tool");
        expect(String(lastToolMessage?.content)).toContain("action gate completed");
        return Response.json({
          choices: [{ message: { content: "continuing after auth" } }],
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "shell-manual-action",
      input: "delete repo",
      onActionGate: async (gate) => {
        userActions.push(gate);
        return {
          content: "action gate completed: gh auth refresh -h github.com -s delete_repo",
          metadata: {
            exitCode: 0,
            actionGateResult: { gateId: gate.id, status: "completed" },
          },
        };
      },
    });

    expect(result.content).toBe("continuing after auth");
    expect(userActions).toHaveLength(1);
    expect(userActions[0]).toMatchObject({
      kind: "handoff",
      payload: {
        command: ["gh", "auth", "refresh", "-h", "github.com", "-s", "delete_repo"],
        displayCommand: "gh auth refresh -h github.com -s delete_repo",
      },
      toolName: "execShell",
    });
  });

  test("destructive local execShell calls run without a confirm callback (no stall path)", async () => {
    // Regression: when no confirmDestructiveAction is wired (non-interactive
    // CLI / machine WS dispatch), the destructive-shell guard must NOT block.
    // Blocking with no confirmation channel only made the model retry the same
    // `rm` until the turn timed out (multi-minute stall). The guard now runs
    // only when a confirmDestructiveAction callback is present (TUI path).
    let executorCalls = 0;
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-shell-guard",
          prompt: "Use shell when useful.",
          model: "qwen-coder",
          toolNames: ["execShell"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      cwd: import.meta.dir,
      localToolExecutors: {
        execShell: async () => {
          executorCalls += 1;
          return {
            content: "deleted",
          };
        },
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const lastToolMessage = [...(body.messages as Array<{ role?: unknown; content?: unknown }>)]
          .reverse()
          .find((message) => message.role === "tool");
        if (lastToolMessage) {
          expect(String(lastToolMessage.content)).toContain("deleted");
          return Response.json({
            choices: [{ message: { content: "guard ok" } }],
          });
        }
        return Response.json({
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: "call-1",
                type: "function",
                function: {
                  name: "execShell",
                  arguments: "{\"cmd\":\"rm -rf ./tmp\"}",
                },
              }],
            },
          }],
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "shell",
      input: "inspect cwd but don't delete files",
    });

    expect(result.content).toBe("guard ok");
    expect(executorCalls).toBe(1);
  });

  test("destructive local execShell calls are blocked when a confirm callback returns false", async () => {
    let executorCalls = 0;
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-shell-guard",
          prompt: "Use shell when useful.",
          model: "qwen-coder",
          toolNames: ["execShell"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      cwd: import.meta.dir,
      confirmDestructiveAction: async () => false,
      localToolExecutors: {
        execShell: async () => {
          executorCalls += 1;
          return { content: "should not run" };
        },
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const lastToolMessage = [...(body.messages as Array<{ role?: unknown; content?: unknown }>)]
          .reverse()
          .find((message) => message.role === "tool");
        if (lastToolMessage) {
          expect(String(lastToolMessage.content)).toContain(
            "destructive_action_requires_confirmation",
          );
          return Response.json({
            choices: [{ message: { content: "guard ok" } }],
          });
        }
        return Response.json({
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: "call-1",
                type: "function",
                function: {
                  name: "execShell",
                  arguments: "{\"cmd\":\"rm -rf ./tmp\"}",
                },
              }],
            },
          }],
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "shell",
      input: "inspect cwd but don't delete files",
    });

    expect(result.content).toBe("guard ok");
    expect(executorCalls).toBe(0);
  });

  test("exposes runtime policy tools to the local model even when toolNames omits them", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-policy-shell",
          prompt: "Use shell when needed.",
          model: "qwen-coder",
          runtimeToolPolicy: {
            version: 1,
            runtimeTools: ["execShell"],
          },
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      cwd: import.meta.dir,
      localToolExecutors: {
        execShell: async () => ({
          content: import.meta.dir,
          metadata: { exitCode: 0, timedOut: false },
        }),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        if (requests.length === 1) {
          return Response.json({
            choices: [{
              message: {
                content: "",
                tool_calls: [{
                  id: "call-1",
                  type: "function",
                  function: { name: "execShell", arguments: "{\"cmd\":\"pwd\"}" },
                }],
              },
            }],
          });
        }
        return Response.json({
          choices: [{ message: { content: "policy shell ok" } }],
        });
      },
    });

    const result = await runLocalAgentTurn({
      adapter,
      agentRef: "shell",
      input: "print cwd",
    });

    expect(result.content).toBe("policy shell ok");
    expect(toolNamesFromRequest(requests[0])).toContain("execShell");
    expect(requests[1]?.body.messages.at(-1)?.content).toContain(import.meta.dir);
  });

  test("treats runtime policy visual tools as declared local tools", async () => {
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-visual",
          prompt: "Inspect the page.",
          model: "qwen-coder",
          runtimeToolPolicy: {
            version: 1,
            runtimeTools: ["captureVisualState"],
          },
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      cwd: import.meta.dir,
      localToolExecutors: {
        captureVisualState: async () => ({
          content: "{\"status\":\"ok\"}",
        }),
      },
      fetchImpl: async (_url, init) => {
        expect(toolNamesFromRequest({ body: JSON.parse(String(init?.body)) })).toContain("captureVisualState");
        return Response.json({
          choices: [{ message: { content: "visual ok" } }],
        });
      },
    });

    await adapter.loadAgentConfig("visual");
    await expect(adapter.executeTool({
      id: "call-visual",
      name: "captureVisualState",
      arguments: JSON.stringify({ waitSelector: "body" }),
    })).resolves.toMatchObject({
      content: "{\"status\":\"ok\"}",
    });
  });

  test("exposes read_xhs_profile to OpenAI-compatible providers when the agent declares it", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-xhs",
          prompt: "Read XHS profile.",
          model: "gpt-4.1-mini",
          toolNames: ["read_xhs_profile"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          choices: [{ message: { content: "done" } }],
        });
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: "xhs",
      input: "读取小红书用户主页",
    });

    expect(toolNamesFromRequest(requests[0])).toContain("read_xhs_profile");
  });

  test("exposes read_x_post to OpenAI-compatible providers when the agent declares it", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-x-post",
          prompt: "Read X posts.",
          model: "gpt-4.1-mini",
          toolNames: ["read_x_post"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          choices: [{ message: { content: "done" } }],
        });
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: "x-post",
      input: "读取 X 帖子",
    });

    expect(toolNamesFromRequest(requests[0])).toContain("read_x_post");
  });

  test("adds LIGHT_WEB companions without social-reader for local web-search agents", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-web-reader",
          prompt: "Read web pages.",
          model: "gpt-4.1-mini",
          toolNames: ["fetchWebpage"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          choices: [{ message: { content: "done" } }],
        });
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: "web-reader",
      input: "搜索网页",
    });

    const names = toolNamesFromRequest(requests[0]);
    expect(names).toContain("exa_search");
    expect(names).toContain("fetchWebpage");
    expect(names).not.toContain("read_x_post");
    expect(names).not.toContain("read_xhs_profile");
  });

  test("does not expose read_xhs_profile when the agent does not declare it", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-no-xhs",
          prompt: "Be helpful.",
          model: "gpt-4.1-mini",
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          choices: [{ message: { content: "done" } }],
        });
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: "no-xhs",
      input: "hello",
    });

    expect(toolNamesFromRequest(requests[0])).not.toContain("read_xhs_profile");
  });

  test("executes read_xhs_profile locally through the desktop bridge", async () => {
    const xhsCalls: Array<{ args: any }> = [];
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-user-1-xhs",
          id: "xhs-agent",
          prompt: "Read XHS.",
          toolNames: ["read_xhs_profile"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      localToolExecutors: {
        read_xhs_profile: async (call) => {
          const parsed = JSON.parse(call.arguments || "{}");
          xhsCalls.push({ args: parsed });
          return {
            content: JSON.stringify({
              ok: true,
              data: {
                profile: { nickname: "test-soul", redId: "12345" },
                notes: [],
                noteDetails: [],
                analysis: {
                  totalNotes: 0,
                  commentBuckets: [],
                },
              },
            }),
            metadata: { xhsLocalBridge: true },
          };
        },
      },
      fetchImpl: async () => Response.json({}),
    });

    await adapter.loadAgentConfig("xhs-agent");
    const result = await adapter.executeTool({
      id: "call-xhs-1",
      name: "read_xhs_profile",
      arguments: JSON.stringify({
        url: "https://www.xiaohongshu.com/user/profile/5d2be8720000000010007556",
        maxScrollPages: 3,
      }),
    });

    expect(xhsCalls).toHaveLength(1);
    expect(xhsCalls[0].args.url).toBe(
      "https://www.xiaohongshu.com/user/profile/5d2be8720000000010007556"
    );
    expect(xhsCalls[0].args.maxScrollPages).toBe(3);
    expect(result.metadata).toMatchObject({ xhsLocalBridge: true });
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.profile.nickname).toBe("test-soul");
  });

  test("default read_x_post executor calls the local bridge reader", async () => {
    const readerCalls: Array<{ args: any }> = [];
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-user-1-x-post-default",
          id: "x-post-default",
          prompt: "Read X posts.",
          toolNames: ["read_x_post"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      readXPost: async (args) => {
        readerCalls.push({ args });
        return {
          rawData: {
            ok: true,
            backend: "desktop_local_browser",
            fetchedAt: "2026-06-08T00:00:00.000Z",
            data: {
              id: "2063842222307704944",
              url: "https://x.com/BohuTANG/status/2063842222307704944",
              text: "mock x post",
              author: {
                handle: "BohuTANG",
                displayName: "Bohu",
              },
            },
          } as any,
          displayData: "已读取 X 帖子：@BohuTANG",
        };
      },
      fetchImpl: async () => Response.json({}),
    });

    await adapter.loadAgentConfig("x-post-default");
    const result = await adapter.executeTool({
      id: "call-x-post-default",
      name: "read_x_post",
      arguments: JSON.stringify({
        url: "https://x.com/BohuTANG/status/2063842222307704944",
        keepOpen: true,
      }),
    });

    expect(readerCalls).toHaveLength(1);
    expect(readerCalls[0].args).toMatchObject({
      url: "https://x.com/BohuTANG/status/2063842222307704944",
      keepOpen: true,
    });
    expect(result.metadata).toMatchObject({ xPostLocalBridge: true });
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.text).toBe("mock x post");
  });

  test("default read_xhs_profile executor calls the local bridge reader", async () => {
    const readerCalls: Array<{ args: any; thunkApi: any }> = [];
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-user-1-xhs-default",
          id: "xhs-default",
          prompt: "Read XHS.",
          toolNames: ["read_xhs_profile"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      readXhsProfile: async (args, thunkApi) => {
        readerCalls.push({ args, thunkApi });
        return {
          rawData: {
            ok: true,
            data: {
              profile: { nickname: "default-bridge", redId: "67890" },
              notes: [],
              noteDetails: [],
              commentsByNote: {},
              analysis: {
                totalNotes: 0,
                averageLikes: 0,
                averageComments: 0,
                averageCollects: 0,
                averageShares: 0,
                commentBuckets: [],
                themes: [],
              },
            },
            fetchedAt: "2026-06-03T00:00:00.000Z",
          } as any,
          displayData: "小红书用户: default-bridge",
        };
      },
      fetchImpl: async () => Response.json({}),
    });

    await adapter.loadAgentConfig("xhs-default");
    const result = await adapter.executeTool({
      id: "call-xhs-default",
      name: "read_xhs_profile",
      arguments: JSON.stringify({
        url: "https://www.xiaohongshu.com/user/profile/5d2be8720000000010007556",
        includeComments: true,
        maxCommentPagesPerNote: 1,
      }),
    });

    expect(readerCalls).toHaveLength(1);
    expect(readerCalls[0].args).toMatchObject({
      url: "https://www.xiaohongshu.com/user/profile/5d2be8720000000010007556",
      includeComments: true,
      maxCommentPagesPerNote: 1,
    });
    expect(readerCalls[0].args.profileDir).toBeUndefined();
    expect(readerCalls[0].thunkApi).toBeUndefined();
    expect(result.metadata).toMatchObject({
      xhsLocalBridge: true,
      displayData: "小红书用户: default-bridge",
    });
    expect(JSON.parse(result.content).data.profile.nickname).toBe("default-bridge");
  });

  test("default read_xhs_profile executor ignores explicit XHS profile env", async () => {
    const readerCalls: Array<{ args: any }> = [];
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        NOLO_XHS_READER_PROFILE_DIR: "/tmp/custom-xhs-profile",
      },
      db: {
        get: async () => ({
          dbKey: "agent-user-1-xhs-env",
          id: "xhs-env",
          prompt: "Read XHS.",
          toolNames: ["read_xhs_profile"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      readXhsProfile: async (args) => {
        readerCalls.push({ args });
        return {
          rawData: {
            ok: true,
            data: {
              profile: { nickname: "env-bridge" },
              notes: [],
              noteDetails: [],
              commentsByNote: {},
              analysis: { totalNotes: 0, commentBuckets: [] },
            },
            fetchedAt: "2026-06-03T00:00:00.000Z",
          } as any,
          displayData: "小红书用户: env-bridge",
        };
      },
      fetchImpl: async () => Response.json({}),
    });

    await adapter.loadAgentConfig("xhs-env");
    await adapter.executeTool({
      id: "call-xhs-env",
      name: "read_xhs_profile",
      arguments: JSON.stringify({
        url: "https://www.xiaohongshu.com/user/profile/5d2be8720000000010007556",
      }),
    });

    expect(readerCalls).toHaveLength(1);
    expect(readerCalls[0].args.profileDir).toBeUndefined();
  });

  test("read_xhs_profile executor does not falsely succeed when bridge is unavailable", async () => {
    const adapter = createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-user-1-xhs-fail",
          id: "xhs-fail",
          prompt: "Read XHS.",
          toolNames: ["read_xhs_profile"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      localToolExecutors: {
        read_xhs_profile: async () => ({
          content: JSON.stringify({
            ok: false,
            code: "network_error",
            message: "read_xhs_profile needs Playwright but it is not installed.",
          }),
          metadata: { xhsLocalBridge: true, bridgeError: true },
        }),
      },
      fetchImpl: async () => Response.json({}),
    });

    await adapter.loadAgentConfig("xhs-fail");
    const result = await adapter.executeTool({
      id: "call-xhs-fail",
      name: "read_xhs_profile",
      arguments: JSON.stringify({
        url: "https://www.xiaohongshu.com/user/profile/5d2be8720000000010007556",
      }),
    });

    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("network_error");
    expect(result.metadata).toMatchObject({ bridgeError: true });
  });

  test("runs allowed workspace file tools through default local executors", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "nolo-cli-runtime-"));
    try {
      const store = new Map<string, any>([
        ["agent-user-1-writer", {
          dbKey: "agent-user-1-writer",
          id: "writer",
          toolNames: ["writeFile"],
        }],
      ]);
      const adapter = createAdapter({
        env: {
          NOLO_LOCAL_USER_ID: "user-1",
        },
        db: {
          get: async (key) => {
            if (!store.has(key)) throw new Error(`not found: ${key}`);
            return store.get(key);
          },
          put: async () => {},
          batch: async () => {},
          iterator: () => (async function* () {})(),
        },
        cwd: workspaceRoot,
        fetchImpl: async () => Response.json({}),
      });

      await adapter.loadAgentConfig("writer");
      const result = await adapter.executeTool({
        id: "call-1",
        name: "writeFile",
        arguments: JSON.stringify({
          path: "src/app.ts",
          content: "export const cliValue = 1;\n",
        }),
      });

      expect(result.content).toBe(`wrote ${join("src", "app.ts")}`);
      expect(readFileSync(join(workspaceRoot, "src/app.ts"), "utf8")).toBe("export const cliValue = 1;\n");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("exposes fetchWebpage and exa_search to OpenAI-compatible providers when the agent declares them", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-web-search",
          prompt: "Search the web.",
          model: "gpt-4.1-mini",
          toolNames: ["fetchWebpage", "exa_search"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          choices: [{ message: { content: "done" } }],
        });
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: "web-search",
      input: "搜索一下",
    });

    const toolNames = toolNamesFromRequest(requests[0]);
    expect(toolNames).toContain("fetchWebpage");
    expect(toolNames).toContain("exa_search");
  });

  test("does not auto-inject fetchWebpage/exa_search in declared-only mode", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
        NOLO_LOCAL_WORKSPACE_TOOLSET: "declared-only",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-no-web",
          prompt: "Be helpful.",
          model: "gpt-4.1-mini",
          tools: ["readFile", "searchFiles"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          choices: [{ message: { content: "done" } }],
        });
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: "no-web",
      input: "你好",
    });

    const toolNames = toolNamesFromRequest(requests[0]);
    // declared-only mode skips default tools (fetchWebpage/exa_search), but
    // FORCED_TOOLS (ui_ask_choice) survive — the platform interaction floor
    // cannot be turned off, even in ablation mode.
    expect(toolNames).not.toContain("fetchWebpage");
    expect(toolNames).not.toContain("exa_search");
    expect(toolNames).toContain("ui_ask_choice");
  });

  test("ui_ask_choice executor calls requestUserChoice and resolves the selected option", async () => {
    const requests: Array<{ body: any }> = [];
    let choiceRequest: any = null;
    const adapter = createAdapter({
      env: {
        OPENAI_API_KEY: "sk-local",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
      db: {
        get: async () => ({
          dbKey: "agent-local-choice",
          prompt: "Ask the user.",
          model: "gpt-4.1-mini",
          toolNames: ["ui_ask_choice"],
        }),
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push({ body });
        // First request: the model calls ui_ask_choice. We detect it by
        // checking whether ui_ask_choice is in the advertised tools.
        const hasChoiceTool = (body.tools || []).some(
          (t: any) => t.function?.name === "ui_ask_choice",
        );
        if (hasChoiceTool && requests.length === 1) {
          return Response.json({
            choices: [{
              message: {
                content: "",
                tool_calls: [{
                  id: "call-choice-1",
                  type: "function",
                  function: {
                    name: "ui_ask_choice",
                    arguments: JSON.stringify({
                      question: "选哪个？",
                      choices: [
                        { id: "a", label: "选项 A", userMessage: "我选 A" },
                        { id: "b", label: "选项 B", userMessage: "我选 B" },
                      ],
                      blocking: true,
                    }),
                  },
                }],
              },
            }],
          });
        }
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      },
      requestUserChoice: async (req) => {
        choiceRequest = req;
        return { kind: "selected", userMessage: "我选 A", label: "选项 A" };
      },
    });

    await runLocalAgentTurn({
      adapter,
      agentRef: "choice-agent",
      input: "给我选项",
    });

    // The callback was invoked with the parsed question + choices.
    expect(choiceRequest).not.toBeNull();
    expect(choiceRequest.question).toBe("选哪个？");
    expect(choiceRequest.choices).toHaveLength(2);
    expect(choiceRequest.choices[0].label).toBe("选项 A");
  });
});

describe("CLI local runtime adapter remote sync fetch timeout", () => {
  // This describe is a sibling of "CLI local runtime adapter", not a child,
  // so the parent's beforeEach (which clears the prepared-agent + hybrid-store
  // caches) does NOT run here. The normal-turn test below drives a full
  // runLocalAgentTurn, which calls getOrCreateSharedStore — a process-level
  // cache keyed by cwd. Without clearing it, a leftover store from a prior
  // test (bound to a different db/fetchImpl mock) gets reused, causing the
  // agent-config read to hang on a fetch that never settles. Clear explicitly.
  beforeEach(() => {
    clearCliLocalRuntimePreparedAgentCache();
  });

  test("postRemoteRecord aborts a hung fetch via AbortSignal.timeout (TimeoutError)", async () => {
    // Shorten the timeout via the test-only hook so this never waits the real
    // 10s. A hung/unreachable server is simulated by a fetchImpl that never
    // resolves on its own; it can only be aborted by the signal we attach.
    setRemoteDialogSyncTimeoutForTest(15);
    try {
      let receivedSignal: AbortSignal | undefined;
      // Simulate a hung server the way real fetch would behave: the socket
      // never answers, but the request still rejects when the abort signal
      // fires. A fake that ignores the signal would hang the test forever —
      // AbortSignal only aborts listeners, it cannot reject a promise that
      // never observes it.
      const hungFetch = async (_url: any, init?: any) => {
        receivedSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal.reason),
          );
        });
      };

      const promise = postRemoteRecord({
        authToken: "token-1",
        data: { hello: "world" },
        fetchImpl: hungFetch as any,
        key: "dialog-timeout-test",
        serverUrl: "https://us.nolo.chat",
        userId: "user-1",
      });

      // AbortSignal.timeout(...) rejects with a DOMException named
      // "TimeoutError" once the timeout elapses.
      await expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
      // The abort signal must be passed into the fetch call; otherwise a hung
      // server would hang the turn for undici's default (minutes).
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(receivedSignal?.aborted).toBe(true);
    } finally {
      setRemoteDialogSyncTimeoutForTest(undefined);
    }
  });

  test("normal-turn remote sync surface warns on timeout instead of throwing", async () => {
    // A subjectRef-less turn must treat the abort/timeout as non-fatal: the
    // sync fetch aborts but the turn still completes with a warning.
    setRemoteDialogSyncTimeoutForTest(15);
    try {
      const store = new Map<string, any>([
        ["agent-user-1-frontend", {
          dbKey: "agent-user-1-frontend",
          id: "frontend",
          name: "Frontend",
          prompt: "You are the frontend implementer.",
          apiSource: "cli",
          cliProvider: "agy",
        }],
      ]);
      const warnings: string[] = [];
      const adapter = createAdapter({
        env: {
          NOLO_LOCAL_USER_ID: "user-1",
          NOLO_SERVER: "https://us.nolo.chat",
          AUTH_TOKEN: "token-1",
        },
        db: {
          get: async (key) => {
            if (!store.has(key)) throw new Error(`not found: ${key}`);
            return store.get(key);
          },
          put: async (key, value) => {
            store.set(key, value);
          },
          batch: async (ops) => {
            for (const op of ops) {
              if (op.type === "put") store.set(op.key, op.value);
            }
          },
          iterator: () => (async function* () {})(),
        },
        createId: () => "01ABORT",
        fetchImpl: async (_url: any, init?: any) => {
          // Agent-config loading reads the agent record from the server first
          // (hybrid store) — answer those so the turn can proceed. Only the
          // dialog-evidence sync writes hang, abort-aware like real fetch
          // (see the postRemoteRecord timeout test above for why this matters).
          if (String(_url).includes("/api/v1/db/read/")) {
            return Response.json({ data: store.get("agent-user-1-frontend") });
          }
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal.reason),
            );
          });
        },
        executeCli: async () => ({ text: "cli ok", raw: "cli ok", elapsed: 1 }),
        output: { write: (chunk: string) => warnings.push(chunk) },
      } as any);

      const result = await runLocalAgentTurn({
        adapter,
        agentRef: "frontend",
        input: "hello",
      });

      // Turn completes despite the hung remote sync.
      expect(result.dialogId).toBe("01ABORT");
      expect(warnings.some((w) => w.includes("Remote dialog evidence sync failed"))).toBe(true);
    } finally {
      setRemoteDialogSyncTimeoutForTest(undefined);
    }
  });
});

describe("resolveCliEffectiveEnabledPacks", () => {
  test("enabledPacks 为空时默认补 code + 全部 always-on 包", () => {
    const expected = ["code", "long-term-memory", "agent-orchestration", "skills"];
    expect(resolveCliEffectiveEnabledPacks({ enabledPacks: [] })).toEqual(expected);
    expect(resolveCliEffectiveEnabledPacks({ enabledPacks: null })).toEqual(expected);
    expect(resolveCliEffectiveEnabledPacks({ enabledPacks: undefined })).toEqual(expected);
    expect(resolveCliEffectiveEnabledPacks({})).toEqual(expected);
  });

  test("enabledPacks 非空时幂等补齐 always-on 包（含长期记忆）", () => {
    expect(resolveCliEffectiveEnabledPacks({ enabledPacks: ["web-search"] })).toEqual(["web-search", "long-term-memory", "agent-orchestration", "skills"]);
    expect(resolveCliEffectiveEnabledPacks({ enabledPacks: ["code", "web-search"] })).toEqual(["code", "web-search", "long-term-memory", "agent-orchestration", "skills"]);
    expect(resolveCliEffectiveEnabledPacks({ enabledPacks: ["code", "agent-orchestration"] })).toEqual(["code", "agent-orchestration", "long-term-memory", "skills"]);
    expect(resolveCliEffectiveEnabledPacks({ enabledPacks: ["code", "long-term-memory", "agent-orchestration", "skills"] })).toEqual(["code", "long-term-memory", "agent-orchestration", "skills"]);
  });

  // 回归护栏：TUI 里说「记住 X」必须走真 tool call。此前 CLI 的 always-on 列表漏了
  // long-term-memory，rememberMemory 永远不进 schema，模型只能退回 shell 跑
  // `nolo memory remember`。断言的是「工具可见」这个用户可感知的结果，而非包名列表——
  // 后者换个实现方式就绿了，前者不会。
  test("rememberMemory 对任何未 ablation 的 CLI agent 都可见", () => {
    for (const enabledPacks of [[], ["code"], ["web-search"], ["code", "long-term-memory"]]) {
      expect(
        expandEnabledPacks(resolveCliEffectiveEnabledPacks({ enabledPacks }), []),
      ).toContain("rememberMemory");
    }
    // 单关通道仍然有效：disabledTools 能摘掉它。
    expect(
      applyDisabledTools(
        expandEnabledPacks(resolveCliEffectiveEnabledPacks({ enabledPacks: [] }), []),
        ["rememberMemory"],
      ),
    ).not.toContain("rememberMemory");
  });

  test("declared-only 模式下不补 code 包（用户显式要 ablation）", () => {
    expect(resolveCliEffectiveEnabledPacks({ enabledPacks: [], declaredOnly: true })).toEqual([]);
    expect(resolveCliEffectiveEnabledPacks({ enabledPacks: ["web-search"], declaredOnly: true })).toEqual(["web-search"]);
  });
});

describe("CLI local runtime adapter OAuth per-request wiring (real credential store)", () => {
  // 接线层保护：localRuntimeAdapter 把 token 解析下沉到每次请求（resolveRequestApiKey），
  // 并在 401 时强刷重试。底层单测覆盖了 openAiCompatibleProvider/oauthTokenStore，但若误删
  // adapter 里的 `resolveApiKey: resolveRequestApiKey` 接线，底层单测全绿。本组测试从 adapter
  // 入口驱动，接线被破坏即红。
  //
  // 可测性说明：adapter 硬构造 createOAuthApiKeyRefResolver()（不传 homeDir），而 Bun 的
  // os.homedir() 缓存进程启动时的 HOME（运行时改 process.env.HOME 无效，已 probe 验证），
  // 因此无法在不改产品代码的前提下把凭证存储重定向到临时目录。退而用真实 homeDir 凭证文件
  // 驱动真实 resolver 链：beforeEach 备份原文件、写入伪造凭证，afterEach 逐字节恢复。测试
  // 全程只接触伪造凭证（含 Test 2 的强刷也走 stub 的全局 fetch），不消耗用户真实 token。
  // 用 xai：chatgpt/claude/cursor/antigravity 在 adapter 里各有专用 provider 分支
  // （codex responses / anthropic messages / ConnectRPC / CCA），走不到本组要测的
  // direct-openai-compatible 接线。xai 是唯一无专用分支的 OAuth ref。
  const OAUTH_REF = "xai";
  const credentialPath = getCredentialPath(OAUTH_REF);
  let originalRaw: string | null = null;
  let originalExisted = false;

  beforeEach(() => {
    clearCliLocalRuntimePreparedAgentCache();
    originalExisted = existsSync(credentialPath);
    originalRaw = originalExisted ? readFileSync(credentialPath, "utf8") : null;
  });

  afterEach(() => {
    if (originalExisted && originalRaw !== null) {
      writeFileSync(credentialPath, originalRaw, { encoding: "utf8", mode: 0o600 });
    } else if (existsSync(credentialPath)) {
      unlinkSync(credentialPath);
    }
    originalRaw = null;
    originalExisted = false;
  });

  function writeFakeOAuthCredential(accessToken: string, refreshToken?: string) {
    writeOAuthCredential(OAUTH_REF, {
      provider: OAUTH_REF,
      accessToken,
      // 远期 expiresAt 让 token 始终「新鲜」（越过 5min skew），非 force 路径直接返回
      // 文件里的 accessToken，不触发 refresh；force 路径才会走 refresh（Test 2 用 stub fetch）。
      expiresAt: Date.now() + 60 * 60 * 1000,
      obtainedAt: Date.now(),
      ...(refreshToken ? { refreshToken } : {}),
    });
  }

  function createOAuthAdapter(opts: {
    agentRecord: Record<string, unknown>;
    fetchImpl: (url: unknown, init?: { headers?: unknown }) => Promise<Response>;
    authToken?: string;
  }) {
    const dbKey = String(opts.agentRecord.dbKey);
    const store = new Map<string, unknown>([[dbKey, opts.agentRecord]]);
    return createAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
        ...(opts.authToken ? { AUTH_TOKEN: opts.authToken } : {}),
      },
      db: {
        get: async (key: string) => {
          if (!store.has(key)) throw new Error(`not found: ${key}`);
          return store.get(key);
        },
        put: async (key: string, value: unknown) => {
          store.set(key, value);
        },
        batch: async (ops: Array<{ type: string; key: string; value: unknown }>) => {
          for (const op of ops) if (op.type === "put") store.set(op.key, op.value);
        },
        iterator: () => (async function* () {})(),
      },
      fetchImpl: opts.fetchImpl,
      sleep: async () => {},
    });
  }

  const OAUTH_AGENT_RECORD = {
    dbKey: "agent-user-1-oauth",
    id: "oauth",
    prompt: "Use OAuth provider.",
    model: "oauth-coder",
    provider: "custom-openai-compatible",
    apiSource: "custom",
    customProviderUrl: "https://api.example.com/v1/chat/completions",
    apiKeyRef: "xai",
  };

  // adapter 在 loadAgentConfig 阶段会打一次远端 record 读取（/api/v1/db/read/...），
  // 那不是 provider 请求。只录 chat.completions，否则请求计数会多一条。
  const isChatCompletion = (url: unknown) => String(url).includes("/chat/completions");

  test("re-resolves the OAuth bearer per request instead of reusing the providerConfig snapshot", async () => {
    writeFakeOAuthCredential("token-snapshot-A");
    const requests: Array<{ url: string; auth: string | null }> = [];
    const adapter = createOAuthAdapter({
      agentRecord: OAUTH_AGENT_RECORD,
      fetchImpl: async (url, init) => {
        if (isChatCompletion(url)) {
          requests.push({
            url: String(url),
            auth: new Headers(init?.headers as HeadersInit).get("Authorization"),
          });
        }
        return Response.json({ choices: [{ message: { content: "oauth ok" } }] });
      },
    });

    const agentConfig = await adapter.loadAgentConfig("oauth");
    const provider = await adapter.resolveProvider(agentConfig);
    // providerConfig.apiKey 此刻固化了 token-snapshot-A（resolver 第一次读到的值）。
    // 在 complete 之前改写凭证文件：若接线存在，resolver 当次应读到新值。
    writeFakeOAuthCredential("token-fresh-B");

    const result = await provider.complete([{ role: "user", content: "hello" }], {});

    expect(result.content).toBe("oauth ok");
    expect(requests).toHaveLength(1);
    // 实际发出的 bearer 是 resolver 当次返回值，不是固化的快照。
    expect(requests[0].auth).toBe("Bearer token-fresh-B");
    expect(requests[0].auth).not.toBe("Bearer token-snapshot-A");
  });

  test("inlines local image URLs before direct OpenAI-compatible requests", async () => {
    writeFakeOAuthCredential("token-image-A");
    const requests: Array<{ body: any; auth: string | null }> = [];
    const fileRequests: Array<{ auth: string | null }> = [];
    const adapter = createOAuthAdapter({
      agentRecord: OAUTH_AGENT_RECORD,
      authToken: "token-image-A",
      fetchImpl: async (url, init) => {
        if (String(url).includes("/api/v1/db/file/content/")) {
          fileRequests.push({
            auth: new Headers(init?.headers as HeadersInit).get("Authorization"),
          });
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        }
        if (isChatCompletion(url)) {
          requests.push({
            body: JSON.parse(String(init?.body)),
            auth: new Headers(init?.headers as HeadersInit).get("Authorization"),
          });
        }
        return Response.json({ choices: [{ message: { content: "image ok" } }] });
      },
    });

    const agentConfig = await adapter.loadAgentConfig("oauth");
    const provider = await adapter.resolveProvider(agentConfig);
    const result = await provider.complete(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image_url",
              image_url: {
                url: "https://us.nolo.chat/api/v1/db/file/content/file-1",
              },
            },
          ],
        },
      ],
      {},
    );

    expect(result.content).toBe("image ok");
    expect(fileRequests).toHaveLength(1);
    expect(fileRequests[0].auth).toBe("Bearer token-image-A");
    expect(requests).toHaveLength(1);
    expect(requests[0].auth).toBe("Bearer token-image-A");
    expect(requests[0].body.messages[0].content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AQID" },
    });
  });

  test("force-refreshes once and retries once on 401, sending the refreshed bearer", async () => {
    writeFakeOAuthCredential("token-initial-A", "refresh-R");
    // force 路径触发 OAuth refresh，其默认 fetchImpl 是全局 fetch；stub 掉以
    // 伪造 OAuth token 响应，避免任何真实网络请求（也避免触碰真实 refresh_token）。
    // xai 的 refresh 先打一次 OIDC discovery 再换 token，所以 stub 要按 URL 分流。
    const refreshFetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      async (input: any) => {
        const url = String(input?.url ?? input);
        if (url.includes("/.well-known/openid-configuration")) {
          return Response.json({
            authorization_endpoint: "https://accounts.x.ai/authorize",
            token_endpoint: "https://accounts.x.ai/token",
          });
        }
        return Response.json({
          access_token: "token-refreshed-B",
          expires_in: 900,
          refresh_token: "refresh-R2",
        });
      },
    );
    try {
      const requests: Array<{ url: string; auth: string | null }> = [];
      const adapter = createOAuthAdapter({
        agentRecord: OAUTH_AGENT_RECORD,
        fetchImpl: async (url, init) => {
          if (isChatCompletion(url)) {
            requests.push({
              url: String(url),
              auth: new Headers(init?.headers as HeadersInit).get("Authorization"),
            });
          }
          if (requests.length === 1) {
            return new Response("unauthorized", { status: 401 });
          }
          return Response.json({ choices: [{ message: { content: "oauth ok after retry" } }] });
        },
      });

      const agentConfig = await adapter.loadAgentConfig("oauth");
      const provider = await adapter.resolveProvider(agentConfig);
      const result = await provider.complete([{ role: "user", content: "hello" }], {});

      // (c) 整轮成功返回，不抛错。
      expect(result.content).toBe("oauth ok after retry");
      // (a) 共两次请求：首发（force:false → token-initial-A）+ 重试。resolver 硬构造不可
      // spy，用等价证据断言 force:true：refresh 函数（全局 fetch stub）恰被调用一次——
      // 新鲜 token 的非 force 解析直接返回文件值、绝不触发 refresh，只有 force 路径会。
      expect(requests).toHaveLength(2);
      // discovery + token 两发；关键是「非 force 路径绝不触发 refresh」，故 >0 即证明走了 force。
      expect(refreshFetchSpy.mock.calls.length).toBeGreaterThan(0);
      // (b) 首发用旧 token，重试用强刷后的新 token。
      expect(requests[0].auth).toBe("Bearer token-initial-A");
      expect(requests[1].auth).toBe("Bearer token-refreshed-B");
    } finally {
      refreshFetchSpy.mockRestore();
    }
  });

  test("does not wire resolveApiKey when the agent has no OAuth apiKeyRef", async () => {
    // 故意在真实 store 放一个 OAuth 凭证：若接线错误地无视空 ref、总是调用 resolver，
    // 请求就会带上 token-should-not-be-used。
    writeFakeOAuthCredential("token-should-not-be-used");
    const requests: Array<{ url: string; auth: string | null }> = [];
    const adapter = createOAuthAdapter({
      agentRecord: {
        dbKey: "agent-user-1-plain",
        id: "plain",
        prompt: "Use plain custom provider.",
        model: "plain-coder",
        provider: "custom-openai-compatible",
        apiSource: "custom",
        customProviderUrl: "https://provider.example/v1/chat/completions",
        apiKey: "sk-direct-plain",
        // 无 apiKeyRef → oauthApiKeyRef 为 undefined → resolveApiKey 不传。
      },
      fetchImpl: async (url, init) => {
        if (isChatCompletion(url)) {
          requests.push({
            url: String(url),
            auth: new Headers(init?.headers as HeadersInit).get("Authorization"),
          });
        }
        return Response.json({ choices: [{ message: { content: "plain ok" } }] });
      },
    });

    const agentConfig = await adapter.loadAgentConfig("plain");
    const provider = await adapter.resolveProvider(agentConfig);
    const result = await provider.complete([{ role: "user", content: "hello" }], {});

    expect(result.content).toBe("plain ok");
    expect(requests).toHaveLength(1);
    // 请求用 providerConfig.apiKey（agent.apiKey），而非 resolver 的 OAuth token。
    expect(requests[0].auth).toBe("Bearer sk-direct-plain");
    expect(requests[0].auth).not.toBe("Bearer token-should-not-be-used");
  });
});

/**
 * Policy 名单派生自 schema 侧：buildLocalPolicyToolNames 不再按类别独立收集，
 * 直接取 buildOpenAiTools 输出的 function.name。覆盖 startAgentRun/controlAgentRun
 * 掉出放行名单的回归（MED-1 之后 schema 注入了但 policy 漏放行）。
 */
describe("CLI local policy tool names 派生自 schema", () => {
  /** 最小 executor map：构造不触发 DB/网络，全是同步组装。fetchImpl 给假函数。 */
  function buildExecutors(env: Record<string, unknown> = {}) {
    return buildLocalToolExecutors({
      workspaceRoot: "/tmp/nolo-policy-derive-test",
      env: env as any,
      fetchImpl: (async () => new Response("{}")) as any,
    });
  }

  /**
   * 回归：rememberMemory 由 long-term-memory 能力包（defaultEnabled）声明，但 CLI
   * 的 schema 构造器一度没有对应分支，于是工具名被静默丢弃——TUI 能召回记忆却
   * 一条也写不进去，而 system prompt 还在告诉模型「你可以调用 rememberMemory」。
   */
  test("声明 rememberMemory 时 schema 暴露且 executor 已接线", () => {
    const env = {};
    const policyNames = buildLocalPolicyToolNames({
      agentKey: "agent-test",
      toolNames: ["rememberMemory"],
      env: env as any,
    });
    expect(policyNames).toContain("rememberMemory");
    expect(buildExecutors().rememberMemory).toBeFunction();
    const decision = resolveLocalToolPolicy({
      env: env as any,
      agentToolNames: policyNames,
      toolName: "rememberMemory",
    });
    expect(decision.allowed).toBe(true);
  });

  test("默认 agent 名单含 startAgentRun/controlAgentRun 且 policy 放行", () => {
    const agentConfig = { key: "agent-test", tools: [] } as any;
    const env = {};
    const requested = resolveCliRequestedToolNames(agentConfig, env as any);
    const policyNames = buildLocalPolicyToolNames({
      agentKey: agentConfig.key,
      toolNames: requested,
      env: env as any,
    });
    expect(policyNames).toContain("startAgentRun");
    expect(policyNames).toContain("controlAgentRun");
    const decision = resolveLocalToolPolicy({
      env: env as any,
      agentToolNames: policyNames,
      toolName: "startAgentRun",
    });
    expect(decision.allowed).toBe(true);
  });

  test("不变式：buildOpenAiTools 每个 function.name 都在 buildLocalPolicyToolNames 结果里", () => {
    const cases: Array<{ name: string; agentConfig: any; env: Record<string, unknown> }> = [
      { name: "默认 agent", agentConfig: { key: "agent-default", tools: [] }, env: {} },
      {
        name: "agent-orchestration 包",
        agentConfig: { key: "agent-orch", tools: [], enabledPacks: ["agent-orchestration"] },
        env: {},
      },
    ];
    for (const { name, agentConfig, env } of cases) {
      const requested = resolveCliRequestedToolNames(agentConfig, env as any);
      const tools = buildOpenAiTools({
        agentKey: agentConfig.key,
        toolNames: requested,
        env: env as any,
      }) as Array<Record<string, unknown>>;
      const schemaNames = tools
        .map((t) => (t as any)?.function?.name)
        .filter((n): n is string => typeof n === "string" && n.length > 0);
      const policyNames = new Set(
        buildLocalPolicyToolNames({
          agentKey: agentConfig.key,
          toolNames: requested,
          env: env as any,
        }),
      );
      const missing = schemaNames.filter((n) => !policyNames.has(n));
      expect(missing).toEqual([]);
    }
  });

  test("executor 覆盖守卫：模型可见的每个工具名都能在本地 executor map 找到实现", () => {
    const agentConfig = { key: "agent-exec-cov", tools: [] } as any;
    const env = {};
    const requested = resolveCliRequestedToolNames(agentConfig, env as any);
    const exposed = buildLocalPolicyToolNames({
      agentKey: agentConfig.key,
      toolNames: requested,
      env: env as any,
    });
    const executors = buildExecutors(env);
    const uncovered = exposed.filter((n) => !(n in executors));
    expect(uncovered).toEqual([]);
  });

  test("收窄仍然生效：disabledTools 屏蔽后 schema 与 policy 名单都不含被禁工具", () => {
    const agentConfig = {
      key: "agent-disabled",
      tools: [],
      disabledTools: ["startAgentRun", "controlAgentRun"],
    } as any;
    const env = {};
    const requested = resolveCliRequestedToolNames(agentConfig, env as any);
    const tools = buildOpenAiTools({
      agentKey: agentConfig.key,
      toolNames: requested,
      env: env as any,
    }) as Array<Record<string, unknown>>;
    const schemaNames = tools
      .map((t) => (t as any)?.function?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    expect(schemaNames).not.toContain("startAgentRun");
    expect(schemaNames).not.toContain("controlAgentRun");
    const policyNames = buildLocalPolicyToolNames({
      agentKey: agentConfig.key,
      toolNames: requested,
      env: env as any,
    });
    expect(policyNames).not.toContain("startAgentRun");
    expect(policyNames).not.toContain("controlAgentRun");
  });

  test("restricted 模式下默认 agent 的 startAgentRun 仍放行（在 DEFAULT_LOCAL_TOOLS 里）", () => {
    const agentConfig = { key: "agent-restricted", tools: [] } as any;
    const env = { NOLO_LOCAL_TOOL_MODE: "restricted" };
    const requested = resolveCliRequestedToolNames(agentConfig, env as any);
    const policyNames = buildLocalPolicyToolNames({
      agentKey: agentConfig.key,
      toolNames: requested,
      env: env as any,
    });
    expect(policyNames).toContain("startAgentRun");
    const decision = resolveLocalToolPolicy({
      env: env as any,
      agentToolNames: policyNames,
      toolName: "startAgentRun",
    });
    expect(decision.allowed).toBe(true);
  });
});

describe("resolveCliRequestedToolNames — systemBuiltinSkills 全局开关", () => {
  test("不传 systemBuiltinSkills（默认开启）保留 web-search 工具", () => {
    const agentConfig = {
      key: "agent-web",
      tools: [],
      enabledPacks: ["web-search"],
    } as any;
    const requested = resolveCliRequestedToolNames(agentConfig, {} as any);
    expect(requested).toContain("exa_search");
    expect(requested).toContain("fetchWebpage");
  });

  test("传 { 'web-search': false } 后过滤掉 exa_search 与 fetchWebpage，保留其他工具", () => {
    const agentConfig = {
      key: "agent-web-off",
      tools: [],
      enabledPacks: ["web-search", "long-term-memory"],
    } as any;
    const requested = resolveCliRequestedToolNames(
      agentConfig,
      {} as any,
      { "web-search": false },
    );
    expect(requested).not.toContain("exa_search");
    expect(requested).not.toContain("fetchWebpage");
    // long-term-memory 不受影响。
    expect(requested).toContain("rememberMemory");
  });

  test("传 { 'web-search': true } 时保留 web-search 工具", () => {
    const agentConfig = {
      key: "agent-web-on",
      tools: [],
      enabledPacks: ["web-search"],
    } as any;
    const requested = resolveCliRequestedToolNames(
      agentConfig,
      {} as any,
      { "web-search": true },
    );
    expect(requested).toContain("exa_search");
    expect(requested).toContain("fetchWebpage");
  });

  test("传 null 等价于默认开启（不过滤）", () => {
    const agentConfig = {
      key: "agent-web-null",
      tools: [],
      enabledPacks: ["web-search"],
    } as any;
    const requested = resolveCliRequestedToolNames(
      agentConfig,
      {} as any,
      null,
    );
    expect(requested).toContain("exa_search");
  });
});
