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
  proactiveSummary: "Short recap of prior topics.",
  proactiveSummaryBeforeId: "msg-old-proactive-anchor",
  compressionCount: 3,
  summaryPending: true,
};

function makeFetchMock(options: {
  dialogRecord?: Record<string, unknown>;
  writeOk?: boolean;
  patchOk?: boolean;
}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];

  const fetchMock: typeof fetch = async (input, init) => {
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
    const fetchFailing: typeof fetch = async () =>
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

    // Conversation-state fields must be absent (undefined / not present)
    expect(forked.summary).toBeUndefined();
    expect(forked.summarizedBeforeId).toBeUndefined();
    expect(forked.proactiveSummary).toBeUndefined();
    expect(forked.proactiveSummaryBeforeId).toBeUndefined();
    expect(forked.compressionCount).toBeUndefined();
    expect(forked.summaryPending).toBeUndefined();

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
