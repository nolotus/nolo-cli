import { describe, expect, it } from "bun:test";

import { shouldRetryPlatformProxyResponse } from "./platformProxyTransport";

describe("platform proxy response retry ownership", () => {
  it("does not retry a structured Bun application 502", async () => {
    const response = Response.json(
      { error: { code: "UPSTREAM_TRANSPORT_ERROR" } },
      { status: 502, headers: { server: "Caddy" } },
    );

    expect(await shouldRetryPlatformProxyResponse(response)).toBe(false);
  });

  it("does not replay an empty Caddy ingress 502", async () => {
    const response = new Response("", {
      status: 502,
      headers: { server: "Caddy" },
    });

    expect(await shouldRetryPlatformProxyResponse(response)).toBe(false);
  });

  it("retries only structured core-draining 503 responses", async () => {
    expect(
      await shouldRetryPlatformProxyResponse(
        Response.json(
          { reason: "core_draining", retryable: true },
          { status: 503 },
        ),
      ),
    ).toBe(true);
    expect(
      await shouldRetryPlatformProxyResponse(
        Response.json(
          { error: { code: "PLATFORM_LLM_BUSY" } },
          { status: 503 },
        ),
      ),
    ).toBe(false);
  });
});
