/**
 * 回归：auto runtime 本地失败后 fallback 到服务器时，服务端跑的是**服务端**那份
 * 对话历史。此前 `ensureDialogSyncedForServerFallback` 只检查远端 dialog 记录
 * 是否存在（200 就放行），不比对消息。服务器繁忙时 chat 代理与 db 写入会同时
 * 退化，于是本地已经落库的轮次没能同步上去，fallback 带着过期历史重跑——
 * 用户看到的就是「刚说过的话它不记得」。
 */
import { afterEach, expect, mock, test } from "bun:test";

const DIALOG_ID = "01TESTDIALOG0000000000000";
const USER_ID = "0e95801d90";
const DIALOG_KEY = `dialog-${USER_ID}-${DIALOG_ID}`;
const SERVER = "https://nolo.test";
// userId 从 token 里解出来，形状必须与 parseUserIdFromAuthToken 一致。
const AUTH_TOKEN = `${Buffer.from(JSON.stringify({ userId: USER_ID })).toString(
  "base64url",
)}.sig.x`;

const msg = (id: string, content: string) => ({
  id,
  _key: `dialog-msg-${DIALOG_ID}-${id}`,
  role: "user",
  content,
});

async function loadWithLocalMessages(localMsgs: unknown[]) {
  mock.module("../localRuntimeAuthority", () => ({
    getDefaultCliLocalRuntimeDb: async () => ({}),
  }));
  mock.module("../../agent-runtime/localDialogRead", () => ({
    readDialogFromLocalDb: async () => ({
      meta: { id: DIALOG_ID, dbKey: DIALOG_KEY },
      msgs: localMsgs,
    }),
  }));
  return import("./cliRemoteDialogSync");
}

type Call = { url: string; body?: any };

function createFetch(remoteMsgs: unknown[]) {
  const calls: Call[] = [];
  const fetchImpl = mock(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    if (String(url).includes("/api/v1/db/read/")) {
      return new Response(JSON.stringify({ id: DIALOG_ID }), { status: 200 });
    }
    if (String(url).includes("/rpc/getConvMsgs")) {
      return new Response(JSON.stringify(remoteMsgs), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  return { calls, fetchImpl };
}

const writtenKeys = (calls: Call[]) =>
  calls
    .filter((c) => c.url.includes("/api/v1/db/write"))
    .map((c) => c.body?.key ?? c.body?.data?._key);

afterEach(() => {
  mock.restore();
});

test("远端落后时，把本地独有的消息补上去再 fallback", async () => {
  const { ensureDialogSyncedForServerFallback } = await loadWithLocalMessages([
    msg("m1", "第一句"),
    msg("m2", "第二句"),
    msg("m3", "服务器繁忙时只落在本地的那句"),
  ]);
  const { calls, fetchImpl } = createFetch([msg("m1", "第一句"), msg("m2", "第二句")]);

  const result = await ensureDialogSyncedForServerFallback(
    {
      continueDialogId: DIALOG_ID,
      env: { NOLO_SERVER: SERVER },
      fetchImpl: fetchImpl as any,
      serverUrl: SERVER,
    },
    AUTH_TOKEN,
  );

  expect(result.ok).toBe(true);
  expect(calls.some((c) => c.url.includes("/rpc/getConvMsgs"))).toBe(true);
  const written = writtenKeys(calls);
  expect(written).toContain(`dialog-msg-${DIALOG_ID}-m3`);
  // 只补差集：已经同步过的两条不重复写。
  expect(written).not.toContain(`dialog-msg-${DIALOG_ID}-m1`);
  expect(written).not.toContain(`dialog-msg-${DIALOG_ID}-m2`);
});

test("远端已完整时不写任何东西", async () => {
  const { ensureDialogSyncedForServerFallback } = await loadWithLocalMessages([
    msg("m1", "第一句"),
  ]);
  const { calls, fetchImpl } = createFetch([msg("m1", "第一句")]);

  const result = await ensureDialogSyncedForServerFallback(
    {
      continueDialogId: DIALOG_ID,
      env: { NOLO_SERVER: SERVER },
      fetchImpl: fetchImpl as any,
      serverUrl: SERVER,
    },
    AUTH_TOKEN,
  );

  expect(result.ok).toBe(true);
  expect(writtenKeys(calls)).toEqual([]);
});

test("远端比本地新时什么都不做，不用陈旧本地状态覆盖服务端", async () => {
  const { ensureDialogSyncedForServerFallback } = await loadWithLocalMessages([]);
  const { calls, fetchImpl } = createFetch([msg("m1", "服务端独有"), msg("m2", "服务端独有")]);

  const result = await ensureDialogSyncedForServerFallback(
    {
      continueDialogId: DIALOG_ID,
      env: { NOLO_SERVER: SERVER },
      fetchImpl: fetchImpl as any,
      serverUrl: SERVER,
    },
    AUTH_TOKEN,
  );

  expect(result.ok).toBe(true);
  expect(writtenKeys(calls)).toEqual([]);
});

test("补齐失败绝不阻塞 fallback —— lock 错误走 lock 专属提示语", async () => {
  mock.module("../localRuntimeAuthority", () => ({
    getDefaultCliLocalRuntimeDb: async () => ({}),
  }));
  mock.module("../../agent-runtime/localDialogRead", () => ({
    readDialogFromLocalDb: async () => {
      throw new Error("LEVEL_LOCKED");
    },
  }));
  const { ensureDialogSyncedForServerFallback } = await import("./cliRemoteDialogSync");
  const { fetchImpl } = createFetch([]);
  const written: string[] = [];

  const result = await ensureDialogSyncedForServerFallback(
    {
      continueDialogId: DIALOG_ID,
      env: { NOLO_SERVER: SERVER },
      fetchImpl: fetchImpl as any,
      output: { write: (c: string) => written.push(c) },
      serverUrl: SERVER,
    },
    AUTH_TOKEN,
  );

  expect(result.ok).toBe(true);
  // lock 专属提示语：告诉用户历史会缺 + 怎么释放。
  expect(written.join("")).toContain("local database is locked");
  // 不应再走原来的 "could not sync" 分支。
  expect(written.join("")).not.toContain("could not sync");
});

test("补齐失败绝不阻塞 fallback —— 非 lock 错误走原来的 could not sync 分支", async () => {
  mock.module("../localRuntimeAuthority", () => ({
    getDefaultCliLocalRuntimeDb: async () => ({}),
  }));
  mock.module("../../agent-runtime/localDialogRead", () => ({
    readDialogFromLocalDb: async () => {
      throw new Error("network down");
    },
  }));
  const { ensureDialogSyncedForServerFallback } = await import("./cliRemoteDialogSync");
  const { fetchImpl } = createFetch([]);
  const written: string[] = [];

  const result = await ensureDialogSyncedForServerFallback(
    {
      continueDialogId: DIALOG_ID,
      env: { NOLO_SERVER: SERVER },
      fetchImpl: fetchImpl as any,
      output: { write: (c: string) => written.push(c) },
      serverUrl: SERVER,
    },
    AUTH_TOKEN,
  );

  expect(result.ok).toBe(true);
  // 非 lock 错误：走原来的 "could not sync" 分支。
  expect(written.join("")).toContain("could not sync");
  // 不应误报成 lock 错误。
  expect(written.join("")).not.toContain("local database is locked");
});
