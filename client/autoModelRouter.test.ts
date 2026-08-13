import { describe, expect, it } from "bun:test";
import {
  CLI_AUTO_TIER_AGENT_KEYS,
  CLI_IMAGE_AGENT_KEY,
  classifyCliAutoRoute,
  resolveCliAutoAgentModel,
} from "./autoModelRouter";

const SERVER_URL = "https://nolo.test";
const AUTH_TOKEN = "token-123";

describe("classifyCliAutoRoute", () => {
  it("routes image messages to the kimi vision agent", () => {
    const result = classifyCliAutoRoute("看看这张图", {
      serverUrl: SERVER_URL,
      authToken: AUTH_TOKEN,
      hasImages: true,
    });
    expect(result.agentKey).toBe(CLI_IMAGE_AGENT_KEY);
    expect(result.tier).toBe("image");
    expect(result.classified).toBe(true);
  });

  it("routes plain text messages to the flash tier agent", () => {
    const result = classifyCliAutoRoute("帮我分析一下这个方案的优缺点", {
      serverUrl: SERVER_URL,
      authToken: AUTH_TOKEN,
    });
    expect(result.agentKey).toBe(CLI_AUTO_TIER_AGENT_KEYS.flash);
    expect(result.tier).toBe("flash");
    expect(result.classified).toBe(true);
  });

  it("defaults hasImages to false (flash) when not provided", () => {
    const result = classifyCliAutoRoute("", {
      serverUrl: SERVER_URL,
      authToken: AUTH_TOKEN,
    });
    expect(result.agentKey).toBe(CLI_AUTO_TIER_AGENT_KEYS.flash);
    expect(result.tier).toBe("flash");
  });

  it("is synchronous and never calls the LLM classifier", () => {
    // 纯二选一：不依赖 authToken、不发网络请求、没有复杂度兜底。
    const result = classifyCliAutoRoute("写一首诗", {
      serverUrl: SERVER_URL,
      authToken: "",
      hasImages: false,
    });
    expect(result.classified).toBe(true);
    expect(result.agentKey).toBe(CLI_AUTO_TIER_AGENT_KEYS.flash);
    expect(result.tier).toBe("flash");
  });
});

describe("resolveCliAutoAgentModel", () => {
  it("maps flash tier and image agent keys to catalog model ids", () => {
    expect(resolveCliAutoAgentModel(CLI_AUTO_TIER_AGENT_KEYS.flash)).toBe(
      "deepseek-v4-flash",
    );
    expect(resolveCliAutoAgentModel(CLI_IMAGE_AGENT_KEY)).toBe("kimi-k2.6");
    expect(resolveCliAutoAgentModel("unknown-agent")).toBeUndefined();
  });
});
