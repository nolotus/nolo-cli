import { describe, expect, it, mock } from "bun:test";
import {
  CLI_AUTO_TIER_AGENT_KEYS,
  classifyCliAutoRoute,
  resolveCliAutoFallbackTier,
} from "./autoModelRouter";
import {
  INTENT_MODEL,
  INTENT_PROVIDER,
} from "../agent-runtime/quickChatIntentCore";
import type { CliFetchImpl } from "../cliFetch";

const SERVER_URL = "https://nolo.test";
const AUTH_TOKEN = "token-123";

const okResponse = (content: string) =>
  new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

const captureFetch = (
  impl: (body: any) => Response,
): { fetchImpl: CliFetchImpl; calls: { url: string; init: RequestInit; body: any }[] } => {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fetchImpl: CliFetchImpl = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(input), init: init ?? {}, body });
    return impl(body);
  };
  return { fetchImpl, calls };
};

describe("classifyCliAutoRoute", () => {
  it("sends a non-streaming classifier request through the platform proxy", async () => {
    const { fetchImpl, calls } = captureFetch(() =>
      okResponse(
        `{"confidence":0.9,"agentKey":"${CLI_AUTO_TIER_AGENT_KEYS.balanced}","needsWorkspace":false}`,
      ),
    );

    const result = await classifyCliAutoRoute("帮我分析一下这个方案的优缺点", {
      serverUrl: SERVER_URL,
      authToken: AUTH_TOKEN,
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${SERVER_URL}/api/v1/chat`);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${AUTH_TOKEN}`,
    );
    expect(calls[0].body.model).toBe(INTENT_MODEL);
    expect(calls[0].body.provider).toBe(INTENT_PROVIDER);
    expect(calls[0].body.stream).toBe(false);
    // system prompt 列出全部三档
    const systemMsg = calls[0].body.messages[0];
    expect(systemMsg.role).toBe("system");
    for (const key of Object.values(CLI_AUTO_TIER_AGENT_KEYS)) {
      expect(systemMsg.content).toContain(key);
    }

    expect(result).toEqual({
      agentKey: CLI_AUTO_TIER_AGENT_KEYS.balanced,
      tier: "balanced",
      classified: true,
      confidence: 0.9,
      needsWorkspace: false,
      skills: undefined,
    });
  });

  it("passes through needsWorkspace and skills from the classifier protocol", async () => {
    const { fetchImpl } = captureFetch(() =>
      okResponse(
        `{"confidence":0.7,"agentKey":"${CLI_AUTO_TIER_AGENT_KEYS.quality}","needsWorkspace":true,"skills":["table"]}`,
      ),
    );

    const result = await classifyCliAutoRoute("帮我建个表整理这些数据", {
      serverUrl: SERVER_URL,
      authToken: AUTH_TOKEN,
      fetchImpl,
    });

    expect(result.needsWorkspace).toBe(true);
    expect(result.skills).toEqual(["table"]);
  });

  it("skips the LLM call for short greetings", async () => {
    const fetchImpl = mock(async () => okResponse("{}"));
    const result = await classifyCliAutoRoute("你好", {
      serverUrl: SERVER_URL,
      authToken: AUTH_TOKEN,
      fetchImpl: fetchImpl as unknown as CliFetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.agentKey).toBe(CLI_AUTO_TIER_AGENT_KEYS.flash);
    expect(result.classified).toBe(true);
  });

  it("falls back without a network call when there is no auth token", async () => {
    const fetchImpl = mock(async () => okResponse("{}"));
    const result = await classifyCliAutoRoute("分析一下架构", {
      serverUrl: SERVER_URL,
      authToken: "",
      fetchImpl: fetchImpl as unknown as CliFetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.classified).toBe(false);
    expect(result.tier).toBe("balanced"); // 「分析」命中复杂度 medium
  });

  it("falls back on invalid classifier JSON", async () => {
    const { fetchImpl } = captureFetch(() => okResponse("not json at all"));
    const result = await classifyCliAutoRoute("写一首诗", {
      serverUrl: SERVER_URL,
      authToken: AUTH_TOKEN,
      fetchImpl,
    });

    expect(result.classified).toBe(false);
    expect(result.agentKey).toBe(CLI_AUTO_TIER_AGENT_KEYS.flash);
  });

  it("falls back on HTTP errors", async () => {
    const { fetchImpl } = captureFetch(
      () => new Response("boom", { status: 500 }),
    );
    const result = await classifyCliAutoRoute("写一首诗", {
      serverUrl: SERVER_URL,
      authToken: AUTH_TOKEN,
      fetchImpl,
    });

    expect(result.classified).toBe(false);
  });

  it("falls back when the classifier call exceeds the timeout", async () => {
    const fetchImpl: CliFetchImpl = (_input, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });

    const started = Date.now();
    const result = await classifyCliAutoRoute("写一首诗", {
      serverUrl: SERVER_URL,
      authToken: AUTH_TOKEN,
      fetchImpl,
      timeoutMs: 30,
    });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.classified).toBe(false);
    expect(result.agentKey).toBe(CLI_AUTO_TIER_AGENT_KEYS.flash);
  });
});

describe("resolveCliAutoFallbackTier", () => {
  it("maps complexity to tiers", () => {
    expect(resolveCliAutoFallbackTier("写一首诗")).toBe("flash");
    expect(resolveCliAutoFallbackTier("分析一下这个架构")).toBe("balanced");
    expect(resolveCliAutoFallbackTier("x".repeat(600))).toBe("quality");
  });
});
