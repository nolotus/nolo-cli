import { describe, expect, test } from "bun:test";
import {
  buildTurnTokenUsage,
  formatTokenCount,
  mergeUsageRecords,
  renderTokenStatus,
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
});