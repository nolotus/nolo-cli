import { describe, expect, test } from "bun:test";
import {
  BUILTIN_NOLO_AGENT_KEY,
  PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
} from "../core/builtinAgents";
import {
  buildTurnTokenUsage,
  formatTokenCount,
  formatUsage,
  mergeUsageRecords,
  renderTokenStatus,
  resolveAgentContextWindow,
  resolveContextWindow,
} from "./tokenUsage";

describe("tokenUsage", () => {
  test("merges usage across tool-loop rounds", () => {
    expect(
      mergeUsageRecords(
        { prompt_tokens: 100, completion_tokens: 20 },
        { input_tokens: 300, output_tokens: 40 }
      )
    ).toEqual({ input_tokens: 400, output_tokens: 60 });
  });

  test("computes remaining context from the latest prompt size", () => {
    const usage = buildTurnTokenUsage(
      { prompt_tokens: 12_400, completion_tokens: 1_200 },
      "MiniMax-M3"
    );
    expect(usage).toMatchObject({
      input: 12_400,
      output: 1_200,
      contextWindow: 1_000_000,
      remaining: 987_600,
    });
    expect(renderTokenStatus(usage)).toBe("in 12.4k out 1.2k left 987.6k");

    const fireworksUsage = buildTurnTokenUsage(
      { prompt_tokens: 12_400, completion_tokens: 1_200 },
      "accounts/fireworks/models/minimax-m3"
    );
    expect(fireworksUsage?.contextWindow).toBe(512_000);
  });

  test("formats small and unknown token counts", () => {
    expect(formatTokenCount(842)).toBe("842");
    expect(renderTokenStatus()).toBe("in — out — left —");
    expect(resolveContextWindow("MiniMax-M3")).toBe(1_000_000);
  });

  test("resolveAgentContextWindow maps auto/flash to DeepSeek 1M", () => {
    expect(
      resolveAgentContextWindow({
        agentKey: BUILTIN_NOLO_AGENT_KEY,
        agentName: "nolo",
        autoRouteDefault: true,
      }),
    ).toBe(1_000_000);

    expect(
      resolveAgentContextWindow({
        agentKey: PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
        agentName: "auto→flash",
      }),
    ).toBe(1_000_000);

    expect(
      resolveAgentContextWindow({
        agentName: "nolo",
        autoRouteDefault: false,
      }),
    ).toBe(256_000);

    // With the real default agent key, autoRouteDefault:false must still
    // refuse the flash 1M upgrade (regression for runAgentChat leak).
    expect(
      resolveAgentContextWindow({
        agentKey: BUILTIN_NOLO_AGENT_KEY,
        agentName: "nolo",
        autoRouteDefault: false,
      }),
    ).toBe(256_000);
  });

  test("calculates platform credits from provider raw cost when cost > 0", () => {
    expect(
      buildTurnTokenUsage(
        { input_tokens: 100, output_tokens: 50, cost: 0.5 },
        "nolo"
      )?.credits
    ).toBe(3.5);
    expect(
      buildTurnTokenUsage({ input_tokens: 100, output_tokens: 50 }, "nolo")
        ?.credits
    ).toBeUndefined();
  });

  test("formatUsage renders cache hit count and percentage", () => {
    expect(
      formatUsage(
        {
          input_tokens: 10_000,
          output_tokens: 250,
          cache_read_input_tokens: 8_000,
        },
        "01TESTDIALOG0000000000"
      )
    ).toContain("cache: 8k / 44.4%");

    // OpenAI/Anthropic 语义：input 不含 cache 时命中可能超过新输入，
    // 分母包含 cacheHit 后百分比恒 ≤100%
    expect(
      formatUsage(
        {
          input_tokens: 2_000,
          output_tokens: 100,
          cache_read_input_tokens: 10_000,
        },
        "01TESTDIALOG0000000000"
      )
    ).toContain("cache: 10k / 83.3%");

    expect(
      renderTokenStatus({
        input: 10_000,
        output: 250,
        cacheRead: 8_000,
      })
    ).toBe("in 10k (cache 8k) out 250 left —");
  });
});
