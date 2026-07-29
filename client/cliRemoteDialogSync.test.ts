/**
 * Tests for cliRemoteDialogSync — postRemoteRecord retry and
 * syncLocalDialogEvidenceToRemote bounded concurrency.
 *
 * ensureDialogSyncedForServerFallback and pushLocalDialogToRemote tests were
 * removed: auto runtime no longer falls back to server when local fails
 * (see agentRun.ts). Those functions were deleted as dead code.
 */
import { expect, mock, test } from "bun:test";

const DIALOG_ID = "01TESTDIALOG0000000000000";
const USER_ID = "0e95801d90";
const SERVER = "https://nolo.test";
const AUTH_TOKEN = `${Buffer.from(JSON.stringify({ userId: USER_ID })).toString(
  "base64url",
)}.sig.x`;

test("postRemoteRecord 遇 429 经退避后成功，不再一次即弃", async () => {
  const { postRemoteRecord } = await import("./cliRemoteDialogSync");
  let writeCalls = 0;
  const fetchImpl = mock(async (url: string, _init?: RequestInit) => {
    if (String(url).includes("/api/v1/db/write/")) {
      writeCalls += 1;
      if (writeCalls === 1) {
        // 服务端限流：第一次 429，Retry-After: 0（立即重试）。
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  // 不应抛错——退避后第二次成功。
  await postRemoteRecord({
    authToken: AUTH_TOKEN,
    data: { hello: "world" },
    fetchImpl: fetchImpl as any,
    key: `dialog-msg-${DIALOG_ID}-retry`,
    serverUrl: SERVER,
    userId: USER_ID,
  });

  expect(writeCalls).toBe(2);
});

test("syncLocalDialogEvidenceToRemote 有界并发 + 批间节流", async () => {
  const { syncLocalDialogEvidenceToRemote } = await import("./cliRemoteDialogSync");
  // 10 个 op：6 msg + 4 non-msg，共 10 条写。
  const ops = Array.from({ length: 10 }, (_, i) => ({
    type: "put" as const,
    key: i < 6 ? `dialog-${USER_ID}-${DIALOG_ID}-msg-m${i}` : `dialog-${USER_ID}-${DIALOG_ID}-meta${i}`,
    value: { idx: i },
  }));

  const slept: number[] = [];
  let inflight = 0;
  let maxInflight = 0;
  let writeCalls = 0;
  const fetchImpl = mock(async (url: string, _init?: RequestInit) => {
    if (String(url).includes("/api/v1/db/write/")) {
      writeCalls += 1;
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      // 模拟一点异步延迟，让并发可观测。
      await new Promise((r) => setTimeout(r, 5));
      inflight -= 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  await syncLocalDialogEvidenceToRemote({
    env: { NOLO_SERVER: SERVER, AUTH_TOKEN },
    fetchImpl: fetchImpl as any,
    input: {} as any,
    ops,
    userId: USER_ID,
    sleep: async (ms) => { slept.push(ms); },
  });

  // 全部写入完成。
  expect(writeCalls).toBe(10);
  // 并发上限 = 4（有界，不是无界 Promise.all 的 10）。
  expect(maxInflight).toBe(4);
  // 10 条 / 批 4 = 3 批 → 批间 sleep 2 次（最后一批不 sleep）。
  expect(slept.length).toBe(2);
});