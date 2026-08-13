import { describe, expect, test } from "bun:test";
import { compactDialog, parseTokenUserId } from "./compactDialog";

// A minimal valid JWT-style token with userId encoded in base64 payload.
// JWT format: header.payload.signature
// Payload: { "userId": "user01" }
const USER_ID = "user01";
const TOKEN_HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64");
const TOKEN_PAYLOAD = Buffer.from(JSON.stringify({ userId: USER_ID })).toString("base64");
const FAKE_TOKEN = `${TOKEN_HEADER}.${TOKEN_PAYLOAD}.fakesig`;

const OLD_DIALOG_ID = "01OLD0000000000000000000AB";
const OLD_DIALOG_KEY = `dialog-${USER_ID}-${OLD_DIALOG_ID}`;

const OLD_DIALOG_RECORD = {
  id: OLD_DIALOG_ID,
  dbKey: OLD_DIALOG_KEY,
  type: "dialog",
  title: "My dialog",
  cybots: ["agent-pub-01NOLOAPPBLD000000019KCKT0"],
  spaceId: "myspace",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  inputTokens: 100,
  outputTokens: 200,
  totalCost: 0.001,
  // conversation summary/compression state that must NOT be carried to the fork
  summary: "This is a long summary of the old conversation.",
  summarizedBeforeId: "msg-old-summary-anchor",
  compressionCount: 3,
  summaryPending: true,
};

function makeFetchMock(options: {
  dialogRecord?: Record<string, unknown>;
  writeOk?: boolean;
  patchOk?: boolean;
}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];

  const fetchMock: import("../cliFetch").CliFetchImpl = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const bodyStr = typeof init?.body === "string" ? init.body : undefined;
    const body = bodyStr ? JSON.parse(bodyStr) : undefined;
    calls.push({ url, method, body });

    if (method === "GET" || !method) {
      return new Response(JSON.stringify(options.dialogRecord ?? OLD_DIALOG_RECORD), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "POST") {
      return new Response("{}", { status: options.writeOk !== false ? 200 : 500 });
    }
    if (method === "PATCH") {
      return new Response("{}", { status: options.patchOk !== false ? 200 : 500 });
    }
    return new Response("{}", { status: 404 });
  };

  return { fetchMock, calls };
}

describe("compactDialog", () => {
  test("reads current dialog, writes a forked copy, and returns the new dialog id", async () => {
    const { fetchMock, calls } = makeFetchMock({});

    const result = await compactDialog({
      serverUrl: "http://localhost:8080",
      authToken: FAKE_TOKEN,
      dialogId: OLD_DIALOG_ID,
      fetchImpl: fetchMock,
    });

    // Should have made 3 HTTP calls: read, write, patch (space)
    expect(calls).toHaveLength(3);

    // 1. Read old dialog
    expect(calls[0]?.url).toContain(`/api/v1/db/read/${OLD_DIALOG_KEY}`);
    expect(calls[0]?.method).toBe("GET");

    // 2. Write new dialog
    expect(calls[1]?.url).toContain("/api/v1/db/write/");
    expect(calls[1]?.method).toBe("POST");
    const writeBody = calls[1]?.body as any;
    expect(writeBody?.data?.inheritedFromDialogKey).toBe(OLD_DIALOG_KEY);
    expect(writeBody?.data?.cybots).toEqual(OLD_DIALOG_RECORD.cybots);
    expect(writeBody?.data?.spaceId).toBe("myspace");
    // Token stats should be reset
    expect(writeBody?.data?.inputTokens).toBe(0);
    expect(writeBody?.data?.outputTokens).toBe(0);
    expect(writeBody?.data?.totalCost).toBe(0);
    // Key should differ from old
    expect(writeBody?.customKey).not.toBe(OLD_DIALOG_KEY);
    expect(writeBody?.customKey).toMatch(/^dialog-user01-/);

    // 3. Patch space
    expect(calls[2]?.url).toContain("/api/v1/db/patch/space-myspace");
    expect(calls[2]?.method).toBe("PATCH");

    // Result
    expect(result.dialogId).toBeDefined();
    expect(result.dialogId).not.toBe(OLD_DIALOG_ID);
    expect(result.dialogKey).toMatch(/^dialog-user01-/);
    expect(result.spaceId).toBe("myspace");
    // No summaryLlmCaller wired → no compression ran
    expect(result.summaryGenerated).toBe(false);
    expect(result.compactedMessageCount).toBe(0);
  });

  test("does not patch space when the dialog has no spaceId", async () => {
    const dialogWithoutSpace = { ...OLD_DIALOG_RECORD, spaceId: undefined };
    const { fetchMock, calls } = makeFetchMock({ dialogRecord: dialogWithoutSpace });

    await compactDialog({
      serverUrl: "http://localhost:8080",
      authToken: FAKE_TOKEN,
      dialogId: OLD_DIALOG_ID,
      fetchImpl: fetchMock,
    });

    // Only read + write, no patch
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.method !== "PATCH")).toBe(true);
  });

  test("throws when the auth token is missing or invalid", async () => {
    const { fetchMock } = makeFetchMock({});

    await expect(
      compactDialog({
        serverUrl: "http://localhost:8080",
        authToken: "not-a-valid-token",
        dialogId: OLD_DIALOG_ID,
        fetchImpl: fetchMock,
      })
    ).rejects.toThrow(/invalid or missing auth token/);
  });

  test("throws when the server read fails", async () => {
    const fetchFailing: import("../cliFetch").CliFetchImpl = async () =>
      new Response("{}", { status: 404 });

    await expect(
      compactDialog({
        serverUrl: "http://localhost:8080",
        authToken: FAKE_TOKEN,
        dialogId: OLD_DIALOG_ID,
        fetchImpl: fetchFailing,
      })
    ).rejects.toThrow(/Failed to read dialog/);
  });

  test("space patch failure does not throw (best-effort)", async () => {
    const { fetchMock } = makeFetchMock({ patchOk: false });

    // Should resolve without throwing even though PATCH fails
    const result = await compactDialog({
      serverUrl: "http://localhost:8080",
      authToken: FAKE_TOKEN,
      dialogId: OLD_DIALOG_ID,
      fetchImpl: fetchMock,
    });

    expect(result.dialogId).toBeDefined();
  });

  test("forked dialog does NOT inherit conversation summary/compression state", async () => {
    const { fetchMock, calls } = makeFetchMock({});

    await compactDialog({
      serverUrl: "http://localhost:8080",
      authToken: FAKE_TOKEN,
      dialogId: OLD_DIALOG_ID,
      fetchImpl: fetchMock,
    });

    const writeBody = calls[1]?.body as any;
    const forked = writeBody?.data ?? {};

    // Conversation summary/compression state IS now inherited so the forked
    // dialog continues with the compressed context (matching Web /compact semantics).
    expect(forked.summary).toBe(OLD_DIALOG_RECORD.summary);
    expect(forked.summarizedBeforeId).toBe(OLD_DIALOG_RECORD.summarizedBeforeId);
    expect(forked.compressionCount).toBe(OLD_DIALOG_RECORD.compressionCount);

    // Config/identity fields must still be carried forward
    expect(forked.cybots).toEqual(OLD_DIALOG_RECORD.cybots);
    expect(forked.type).toBe("dialog");
    expect(forked.spaceId).toBe("myspace");
    expect(forked.inheritedFromDialogKey).toBe(OLD_DIALOG_KEY);
    expect(forked.inheritedFromDialogTitle).toBe(OLD_DIALOG_RECORD.title);

    // Stats must be reset
    expect(forked.inputTokens).toBe(0);
    expect(forked.outputTokens).toBe(0);
    expect(forked.totalCost).toBe(0);
  });
});

describe("parseTokenUserId", () => {
  test("extracts userId from a valid JWT token (header.payload.signature)", () => {
    const userId = "user-12345";
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64");
    const payload = Buffer.from(JSON.stringify({ userId })).toString("base64");
    const token = `${header}.${payload}.signature`;
    
    expect(parseTokenUserId(token)).toBe(userId);
  });

  test("returns null when token has fewer than 2 segments", () => {
    expect(parseTokenUserId("onlyonepart")).toBeNull();
  });

  test("returns null when payload is not valid JSON", () => {
    const token = "header.not-valid-base64-json.signature";
    expect(parseTokenUserId(token)).toBeNull();
  });

  test("returns null when payload does not contain userId", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64");
    const payload = Buffer.from(JSON.stringify({ sub: "someone" })).toString("base64");
    const token = `${header}.${payload}.signature`;
    
    expect(parseTokenUserId(token)).toBeNull();
  });

  test("returns null when userId is not a string", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64");
    const payload = Buffer.from(JSON.stringify({ userId: 12345 })).toString("base64");
    const token = `${header}.${payload}.signature`;

    expect(parseTokenUserId(token)).toBeNull();
  });
});

describe("compactDialog with summary compression", () => {
  test("generates summary, patches old dialog, and fork inherits compressed state", async () => {
    // Build messages with enough tokens to trigger compression
    // manual force needs isActiveSummaryWorthDoing: pendingTokens >= max(10000, contextWindow*0.05)
    // DEFAULT_CONTEXT_WINDOW=256000 → minTokens=12800 → need >= 128 msgs * 100 tokens
    const msgs = Array.from({ length: 140 }, (_, i) => ({
      id: `m${i + 1}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i + 1} with enough text to have tokens`,
      usage: { completion_tokens: 100 },
    }));

    const calls: { url: string; method: string; body?: unknown }[] = [];
    const fetchMock: import("../cliFetch").CliFetchImpl = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const bodyStr = typeof init?.body === "string" ? init.body : undefined;
      const body = bodyStr ? JSON.parse(bodyStr) : undefined;
      calls.push({ url, method, body });

      // GET → read dialog record
      if (method === "GET") {
        return new Response(JSON.stringify({
          ...OLD_DIALOG_RECORD,
          cybots: [], // no agent → DEFAULT_CONTEXT_WINDOW
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      // POST → could be dialog-read or write
      if (method === "POST") {
        if (url.includes("dialog-read")) {
          return new Response(JSON.stringify({ ok: true, msgs }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        // write forked dialog
        return new Response("{}", { status: 200 });
      }
      // PATCH → patch old dialog with summary
      if (method === "PATCH") {
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };

    const summaryLlmCaller = async (_content: string): Promise<string | null> => {
      return "Compressed summary of the conversation.";
    };

    const result = await compactDialog({
      serverUrl: "http://localhost:8080",
      authToken: FAKE_TOKEN,
      dialogId: OLD_DIALOG_ID,
      fetchImpl: fetchMock,
      summaryLlmCaller,
    });

    // Summary was generated
    expect(result.summaryGenerated).toBe(true);
    // Compression folded some messages into the summary
    expect(result.compactedMessageCount).toBeGreaterThan(0);

    // PATCH was called to write summary back to old dialog
    const patchCall = calls.find(c => c.method === "PATCH");
    expect(patchCall).toBeDefined();
    const patchBody = (patchCall as any)?.body?.data;
    expect(patchBody.summary).toBe("Compressed summary of the conversation.");
    expect(patchBody.summarizedBeforeId).toBeDefined();
    expect(patchBody.compressionCount).toBe(4); // was 3, incremented

    // Forked dialog inherits the new summary
    const writeCall = calls.find(c => c.method === "POST" && !c.url.includes("dialog-read"));
    expect(writeCall).toBeDefined();
    const forkedData = (writeCall as any)?.body?.data;
    expect(forkedData.summary).toBe("Compressed summary of the conversation.");
    expect(forkedData.summarizedBeforeId).toBeDefined();
    expect(forkedData.compressionCount).toBe(4);
    // Fork inherits the updated referenceKeys (from current.referenceKeys)
    expect(forkedData.referenceKeys).toBeDefined();
  });

  test("degrades to fork-only when summaryLlmCaller returns null", async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const fetchMock: import("../cliFetch").CliFetchImpl = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const bodyStr = typeof init?.body === "string" ? init.body : undefined;
      const body = bodyStr ? JSON.parse(bodyStr) : undefined;
      calls.push({ url, method, body });

      if (method === "GET") {
        return new Response(JSON.stringify(OLD_DIALOG_RECORD), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "POST") {
        if (url.includes("dialog-read")) {
          return new Response(JSON.stringify({
            ok: true,
            msgs: Array.from({ length: 140 }, (_, i) => ({
              id: `m${i + 1}`,
              role: i % 2 === 0 ? "user" : "assistant",
              content: `message ${i + 1}`,
              usage: { completion_tokens: 100 },
            })),
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("{}", { status: 200 });
      }
      if (method === "PATCH") return new Response("{}", { status: 200 });
      return new Response("{}", { status: 404 });
    };

    const result = await compactDialog({
      serverUrl: "http://localhost:8080",
      authToken: FAKE_TOKEN,
      dialogId: OLD_DIALOG_ID,
      fetchImpl: fetchMock,
      summaryLlmCaller: async () => null,
    });

    // No summary generated, but fork still succeeds
    expect(result.summaryGenerated).toBe(false);
    expect(result.compactedMessageCount).toBe(0);

    // No PATCH to dialog record (no summary to write back).
    // addDialogToSpaceIfNeeded also PATCHes, so filter by URL.
    const dialogPatchCall = calls.find(c => c.method === "PATCH" && c.url.includes(OLD_DIALOG_KEY));
    expect(dialogPatchCall).toBeUndefined();

    // Fork inherits old summary (from dialog record)
    const writeCall = calls.find(c => c.method === "POST" && !c.url.includes("dialog-read"));
    const forkedData = (writeCall as any)?.body?.data;
    expect(forkedData.summary).toBe(OLD_DIALOG_RECORD.summary);
  });
});
