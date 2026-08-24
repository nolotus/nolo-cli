/**
 * 客户端此前只在**抛异常**时重试。429/503 是一次成功的 HTTP 交换，直接原样返回，
 * 于是服务端明示的 `retryable: true, retryAfterMs: 1500` 被完全无视——
 * 一次容量抖动就成了用户可见的终局失败。
 *
 * 实测捕获（2026-07-27，alpha 部署重启期间）：
 *   HTTP 503 {"error":"Server draining","reason":"core_draining",
 *             "retryable":true,"retryAfterMs":1500}
 * 客户端不重试，整个 agent run 直接失败。
 */
import { describe, expect, it } from "bun:test";
import { fetchWithTransientRetry } from "./localRuntimeAdapter";

const json = (status: number, body: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function scriptedFetch(responses: Response[]) {
  const calls: number[] = [];
  const impl = (async () => {
    calls.push(Date.now());
    return responses.shift() ?? json(500, { error: "exhausted" });
  }) as any;
  return { impl, calls };
}

describe("fetchWithTransientRetry", () => {
  it("retries a 503 the server marked retryable and returns the eventual success", async () => {
    const slept: number[] = [];
    const { impl, calls } = scriptedFetch([
      json(503, {
        error: "Server draining",
        reason: "core_draining",
        retryable: true,
        retryAfterMs: 1500,
      }),
      json(200, { ok: true }),
    ]);

    const res = await fetchWithTransientRetry(impl, "https://example.test/x", undefined, {
      sleep: async (ms) => { slept.push(ms); },
    });

    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(slept).toEqual([1500]);
  });

  it("honours a standard Retry-After header over the body hint", async () => {
    const slept: number[] = [];
    const { impl } = scriptedFetch([
      json(429, { retryAfterMs: 9999 }, { "retry-after": "2" }),
      json(200, { ok: true }),
    ]);
    await fetchWithTransientRetry(impl, "https://example.test/x", undefined, {
      sleep: async (ms) => { slept.push(ms); },
    });
    expect(slept).toEqual([2000]);
  });

  it("gives up after the attempt budget and surfaces the last response", async () => {
    const slept: number[] = [];
    const { impl, calls } = scriptedFetch([
      json(503, {}), json(503, {}), json(503, { last: true }),
    ]);
    const res = await fetchWithTransientRetry(impl, "https://example.test/x", undefined, {
      sleep: async (ms) => { slept.push(ms); },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ last: true });
    expect(calls.length).toBe(3);
    expect(slept.length).toBe(2);
    // 无 Retry-After 头、无 body retryAfterMs：退避必须是递增的非零值
    // （250ms → 500ms 指数退避），不能变成 0 即瞬间重试。
    expect(slept[0]).toBeGreaterThan(0);
    expect(slept[1]).toBeGreaterThan(slept[0]);
  });

  it("gives structured 503 core_draining responses the dedicated long budget", async () => {
    const slept: number[] = [];
    const { impl, calls } = scriptedFetch([
      json(503, { reason: "core_draining", retryAfterMs: 1500 }),
      json(503, { reason: "core_draining", retryAfterMs: 1500 }),
      json(503, { reason: "core_draining", retryAfterMs: 1500 }),
      json(503, { reason: "core_draining", retryAfterMs: 1500 }),
      json(200, { ok: true }),
    ]);

    // 不传任何 maxAttempts：core_draining 走内置长预算（30），
    // 4 次重试后成功，证明普通 3 次预算不会截断 drain 窗口。
    const res = await fetchWithTransientRetry(
      impl,
      "https://example.test/x",
      undefined,
      {
        sleep: async (ms) => { slept.push(ms); },
      },
    );

    expect(res.status).toBe(200);
    expect(calls.length).toBe(5);
    expect(slept).toEqual([1500, 1500, 1500, 1500]);
  });

  it("keeps ordinary 429 responses on the general budget, not the drain budget", async () => {
    const slept: number[] = [];
    const { impl, calls } = scriptedFetch([
      json(429, { retryAfterMs: 100 }),
      json(429, { retryAfterMs: 100 }),
      json(429, { retryAfterMs: 100 }),
      json(429, { retryAfterMs: 100, last: true }),
    ]);
    // 默认预算 3：普通 429 只重试 2 次，第 3 次响应原样返回，不会被长预算拖住。
    const res = await fetchWithTransientRetry(impl, "https://example.test/x", undefined, {
      sleep: async (ms) => { slept.push(ms); },
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ retryAfterMs: 100 });
    expect(calls.length).toBe(3);
    expect(slept.length).toBe(2);
  });

  it("keeps plain 503 (non core_draining) on the general budget", async () => {
    const slept: number[] = [];
    const { impl, calls } = scriptedFetch([
      json(503, { retryAfterMs: 50 }),
      json(503, { retryAfterMs: 50 }),
      json(503, { retryAfterMs: 50, last: true }),
    ]);
    const res = await fetchWithTransientRetry(impl, "https://example.test/x", undefined, {
      sleep: async (ms) => { slept.push(ms); },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ retryAfterMs: 50, last: true });
    expect(calls.length).toBe(3);
    expect(slept.length).toBe(2);
  });

  it("does not retry statuses the upstream actually processed", async () => {
    const { impl, calls } = scriptedFetch([json(400, { error: "bad request" })]);
    const res = await fetchWithTransientRetry(impl, "https://example.test/x", undefined, {
      sleep: async () => {},
    });
    expect(res.status).toBe(400);
    expect(calls.length).toBe(1);
  });

  it("leaves the returned body readable after peeking for retryAfterMs", async () => {
    const { impl } = scriptedFetch([json(503, { retryAfterMs: 1 }), json(200, { hi: 1 })]);
    const res = await fetchWithTransientRetry(impl, "https://example.test/x", undefined, {
      sleep: async () => {},
    });
    expect(await res.json()).toEqual({ hi: 1 });
  });

  it("does NOT retry 502 by default (upstream may have already processed it)", async () => {
    const { impl, calls } = scriptedFetch([json(502, { error: "bad gateway" })]);
    const res = await fetchWithTransientRetry(impl, "https://example.test/x", undefined, {
      sleep: async () => {},
    });
    expect(res.status).toBe(502);
    expect(calls.length).toBe(1);
  });

  it("retries 502 when retryableStatuses explicitly includes it, then succeeds", async () => {
    const slept: number[] = [];
    const { impl, calls } = scriptedFetch([
      json(502, { error: "bad gateway" }),
      json(200, { ok: true }),
    ]);
    const res = await fetchWithTransientRetry(
      impl,
      "https://example.test/x",
      undefined,
      {
        sleep: async (ms) => { slept.push(ms); },
        retryableStatuses: new Set([429, 502, 503]),
      },
    );
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(slept.length).toBe(1);
  });

  it("retries 502 with retryableStatuses but surfaces the last response when budget exhausted", async () => {
    const slept: number[] = [];
    const { impl, calls } = scriptedFetch([
      json(502, {}),
      json(502, {}),
      json(502, { last: true }),
    ]);
    const res = await fetchWithTransientRetry(
      impl,
      "https://example.test/x",
      undefined,
      {
        sleep: async (ms) => { slept.push(ms); },
        retryableStatuses: new Set([502]),
      },
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ last: true });
    expect(calls.length).toBe(3);
    expect(slept.length).toBe(2);
  });

  it("lets a caller reject retries for a structured application 502", async () => {
    const slept: number[] = [];
    const { impl, calls } = scriptedFetch([
      json(502, { error: { code: "UPSTREAM_TRANSPORT_ERROR" } }),
      json(200, { ok: true }),
    ]);
    const res = await fetchWithTransientRetry(
      impl,
      "https://example.test/x",
      undefined,
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
        retryableStatuses: new Set([502]),
        shouldRetryResponse: async (response) => {
          const body = (await response
            .clone()
            .json()
            .catch(() => null)) as any;
          return body?.error?.code !== "UPSTREAM_TRANSPORT_ERROR";
        },
      },
    );

    expect(res.status).toBe(502);
    expect(calls.length).toBe(1);
    expect(slept).toEqual([]);
  });

  it("reports retry progress via onRetry with attempt/maxAttempts/delayMs", async () => {
    const slept: number[] = [];
    const reported: Array<{ attempt: number; maxAttempts: number; delayMs: number }> = [];
    const { impl, calls } = scriptedFetch([
      json(503, { retryAfterMs: 1500 }),
      json(200, { ok: true }),
    ]);
    const res = await fetchWithTransientRetry(impl, "https://example.test/x", undefined, {
      sleep: async (ms) => { slept.push(ms); },
      onRetry: (info) => reported.push(info),
    });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(reported).toEqual([{ attempt: 2, maxAttempts: 3, delayMs: 1500 }]);
  });

  it("reports 502 retry progress when retryableStatuses includes it", async () => {
    const reported: Array<{ attempt: number; maxAttempts: number; delayMs: number }> = [];
    const { impl, calls } = scriptedFetch([
      json(502, { error: "bad gateway" }),
      json(200, { ok: true }),
    ]);
    const res = await fetchWithTransientRetry(
      impl,
      "https://example.test/x",
      undefined,
      {
        sleep: async () => {},
        retryableStatuses: new Set([429, 502, 503]),
        onRetry: (info) => reported.push(info),
      },
    );
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.attempt).toBe(2);
    expect(reported[0]!.maxAttempts).toBe(3);
  });

  it("reports network-error retries via onRetry too", async () => {
    const reported: Array<{ attempt: number; maxAttempts: number; delayMs: number }> = [];
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNRESET socket hang up");
      return json(200, { ok: true });
    }) as any;
    const res = await fetchWithTransientRetry(impl, "https://example.test/x", undefined, {
      sleep: async () => {},
      onRetry: (info) => reported.push(info),
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.attempt).toBe(2);
    expect(reported[0]!.maxAttempts).toBe(3);
    expect(reported[0]!.delayMs).toBeGreaterThan(0);
  });

  it("does not replay a network failure when the caller disables unsafe POST retries", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      throw new Error("ECONNRESET socket hang up");
    }) as any;

    await expect(
      fetchWithTransientRetry(impl, "https://example.test/chat", {
        method: "POST",
        body: "{}",
      }, {
        sleep: async () => {},
        retryNetworkErrors: false,
      }),
    ).rejects.toThrow("ECONNRESET socket hang up");
    expect(calls).toBe(1);
  });
});
