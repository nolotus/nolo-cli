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
});
