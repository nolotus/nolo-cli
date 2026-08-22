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
  resolveAgentModelIdentity,
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

  test("resolveAgentContextWindow follows the nolo catalog model (1M)", () => {
    // nolo 指向 builtinAgentCatalog 里的 DeepSeek V4 Flash Vision Exp（1M），
    // 窗口跟随目录模型，不再受 NOLO_AUTO_ROUTE 影响。
    expect(
      resolveAgentContextWindow({
        agentKey: BUILTIN_NOLO_AGENT_KEY,
        agentName: "nolo",
      }),
    ).toBe(1_000_000);

    expect(
      resolveAgentContextWindow({
        agentKey: PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
        agentName: "auto→flash",
      }),
    ).toBe(1_000_000);

    // 没有 agentKey 时只有一个显示名，仍回落到通用默认窗口。
    expect(resolveAgentContextWindow({ agentName: "nolo" })).toBe(256_000);
  });

  test("resolveAgentModelIdentity resolves the nolo default from the catalog", () => {
    expect(
      resolveAgentModelIdentity({
        agentKey: BUILTIN_NOLO_AGENT_KEY,
        agentName: "nolo",
      }),
    ).toEqual({ agentName: "nolo", model: "deepseek-v4-flash-vision-exp" });

    // 显式 model 优先，不被默认档覆盖。
    expect(
      resolveAgentModelIdentity({
        agentKey: "agent-pub-custom",
        agentName: "custom",
        model: "gpt-5.6-luna",
      }),
    ).toEqual({ agentName: "custom", model: "gpt-5.6-luna" });

    expect(
      resolveAgentModelIdentity({ agentKey: "agent-pub-custom", agentName: "custom" }),
    ).toEqual({ agentName: "custom" });
  });

  test("calculates platform credits from provider raw cost when cost > 0", () => {
    expect(
      buildTurnTokenUsage(
        { input_tokens: 100, output_tokens: 50, cost: 0.5 },
        "nolo"
      )?.credits
    ).toBe(4.0);
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
