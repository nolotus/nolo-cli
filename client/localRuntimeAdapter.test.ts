import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runLocalAgentTurn } from "../agent-runtime/localLoop";
import type { PermissionRequest } from "../agent-runtime/actionGate";
import {
  clearCliLocalRuntimePreparedAgentCache,
  createCliLocalRuntimeAdapter,
} from "./localRuntimeAdapter";
import { LOCAL_CODEX_AGENT_KEY } from "../agentAliases";

const FULLSTACK_TEST_AGENT_KEY = "fullstack";

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
  ];
  const LEGACY_WRITE_LOCAL_CODING_TOOL_NAMES = [
    "listFiles",
    "readFile",
    "writeFile",
    "editFile",
    "globFiles",
    "searchFiles",
    "execShell",
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
    "listTables",
    "queryTableRows",
    "cliWhoami",
    "cliDoctor",
  ];
  const DEFAULT_PRIVATE_LOCAL_TOOL_NAMES = [
    ...DEFAULT_LOCAL_CODING_TOOL_NAMES,
    ...DEFAULT_PRIVATE_NOLO_WORKSPACE_TOOL_NAMES,
  ];

  function toolNamesFromRequest(request: any) {
    return request?.body?.tools?.map((tool: any) => tool.function.name) ?? [];
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
    const adapter = createCliLocalRuntimeAdapter({
      env: { NOLO_LOCAL_USER_ID: "user-1" },
      cwd: "/tmp/nolo-cache-test",
      db: {
        get: async (key) => {
          storeReads += 1;
          if (key !== "agent-user-1-test") throw new Error(`not found: ${key}`);
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
        },
        put: async () => {},
        batch: async () => {},
        iterator: () => (async function* () {})(),
      },
      fetchImpl: async () => new Response("not found", { status: 404 }),
    } as any);

    await adapter.loadAgentConfig("agent-user-1-test");
    await adapter.loadAgentConfig("agent-user-1-test");

    expect(storeReads).toBe(1);
  });

  test("loads stored local CLI agent records before falling back to built-ins", async () => {
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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

  test("fails cli-provider local runs clearly when the requested local CLI is unavailable", async () => {
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
  });

  test("passes cli-provider image inputs to the CLI executor instead of rejecting", async () => {
    let cliCalledWith: any = null;
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
        messages: [
          { role: "system", content: "Fix UI" },
          { role: "assistant", content: "previous answer" },
          { role: "user", content: "make it cleaner" },
        ],
        stream: false,
      },
    });
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
        messages: [
          { role: "system", content: "Use custom provider." },
          { role: "user", content: "hello" },
        ],
        stream: false,
        temperature: 0.2,
        max_tokens: 4096,
        reasoning_effort: "medium",
      },
    });
    expect(toolNamesFromRequest(requests[0])).toEqual(DEFAULT_PRIVATE_LOCAL_TOOL_NAMES);
  });

  test("aborts stalled custom provider requests when timeoutMs is provided", async () => {
    const store = new Map<string, any>([
      ["agent-user-1-mimo", {
        dbKey: "agent-user-1-mimo",
        id: "mimo",
        prompt: "Use monthly mimo.",
        model: "mimo-v2.5-pro",
        provider: "custom",
        apiSource: "custom",
        customProviderUrl: "https://token-plan-cn.xiaomimimo.com/v1",
        apiKey: "mimo-monthly-key",
      }],
    ]);
    const adapter = createCliLocalRuntimeAdapter({
      env: {
        NOLO_LOCAL_USER_ID: "user-1",
      },
      store: {
        read: async (key) => store.get(key) ?? null,
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
      fetchImpl: async (_url, init) => {
        if (init?.signal?.aborted) {
          throw init.signal.reason ?? new Error("aborted");
        }
        await new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
        });
        throw new Error("unreachable");
      },
    });

    await expect(runLocalAgentTurn({
      adapter,
      agentRef: "mimo",
      input: "hello",
      timeoutMs: 10,
    })).rejects.toThrow(/timed out|aborted/i);
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
    const adapter = createCliLocalRuntimeAdapter({
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
        messages: [
          { role: "system", content: "Use localhost provider." },
          { role: "user", content: "hello" },
        ],
        stream: false,
      },
    });
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
    const adapter = createCliLocalRuntimeAdapter({
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
        messages: [
          { role: "system", content: "Fix UI." },
          { role: "user", content: "make notifications cleaner" },
        ],
        stream: false,
        tool_choice: "auto",
        url: "https://api.fireworks.ai/inference/v1/chat/completions",
        provider: "fireworks",
        agentKey: "agent-user-1-frontend",
      },
    });
    expect(toolNamesFromRequest(requests[0])).toEqual([
      ...LEGACY_WRITE_LOCAL_CODING_TOOL_NAMES,
      ...DEFAULT_PRIVATE_NOLO_WORKSPACE_TOOL_NAMES,
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
      fetchImpl: async () => {
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
    const adapter = createCliLocalRuntimeAdapter({
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
      fetchImpl: async () => {
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
      ...SHELL_LOCAL_CODING_TOOL_NAMES,
      ...DEFAULT_PRIVATE_NOLO_WORKSPACE_TOOL_NAMES,
    ]);
  });

  test("keeps fullstack local model tools to the compact coding surface", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createCliLocalRuntimeAdapter({
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
      ...SHELL_LOCAL_CODING_TOOL_NAMES,
      "queryTableRows",
    ]);
  });

  test("can expose only declared local workspace tools for tool ablations", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createCliLocalRuntimeAdapter({
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

    expect(toolNamesFromRequest(requests[0])).toEqual(["listFiles", "readFile", "execShell"]);
  });

  test("defaults local workspace tools to strategy descriptions and rich parameters", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createCliLocalRuntimeAdapter({
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
    expect(readFile.description).toContain("Use line ranges");
    expect(publicSchemaKeys(readFile)).toEqual([
      "path",
      "startLine",
      "endLine",
      "maxLines",
      "tailLines",
    ]);
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

  test("can vary globFiles schema through local runtime env", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    expect(readFile.description).toContain("Use line ranges");
    expect(readFile.parameters.properties.maxLines.description).toContain("each readFile preview consumes one budget slot");
    expect(publicSchemaKeys(readFile)).toEqual([
      "path",
      "startLine",
      "endLine",
      "maxLines",
      "tailLines",
    ]);
  });

  test("can vary searchFiles schema through local runtime env", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createCliLocalRuntimeAdapter({
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
      const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
      const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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

  test("blocks destructive local execShell calls unless the user explicitly asked to delete", async () => {
    let executorCalls = 0;
    const adapter = createCliLocalRuntimeAdapter({
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
            content: "should not run",
          };
        },
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const lastToolMessage = [...body.messages]
          .reverse()
          .find((message: any) => message.role === "tool");
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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

  test("adds read_x_post to local web-capable agent tool surface", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createCliLocalRuntimeAdapter({
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
      input: "读取 X 帖子",
    });

    expect(toolNamesFromRequest(requests[0])).toContain("read_x_post");
  });

  test("does not expose read_xhs_profile when the agent does not declare it", async () => {
    const requests: Array<{ body: any }> = [];
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
    const adapter = createCliLocalRuntimeAdapter({
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
      const adapter = createCliLocalRuntimeAdapter({
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
});
