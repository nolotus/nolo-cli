import { describe, test, expect } from "bun:test";
import { clipHeadAndTail } from "./toolOutput";
import { parseUsageRecord, mergeUsageRecords, renderTokenStatus } from "./tokenUsage";
import { existsSync, readFileSync, unlinkSync } from "node:fs";

describe("toolOutput clipHeadAndTail", () => {
  test("returns original content when below threshold", () => {
    const text = "Short output";
    const res = clipHeadAndTail(text, { maxTotalBytes: 100 });
    expect(res.clipped).toBe(false);
    expect(res.content).toBe(text);
  });

  test("clips content using Head+Tail when above threshold and saves temp log", () => {
    const head = "START_HEADER_LINE_1234567890\n".repeat(50);
    const middle = "MIDDLE_NOISE_LINE_1234567890\n".repeat(200);
    const tail = "END_TAIL_LINE_1234567890\n".repeat(50);
    const fullText = head + middle + tail;

    const res = clipHeadAndTail(fullText, {
      maxHeadBytes: 100,
      maxTailBytes: 100,
      maxTotalBytes: 300,
      toolCallId: "test-tool-call-1",
    });

    expect(res.clipped).toBe(true);
    expect(res.content).toContain("START_HEADER");
    expect(res.content).toContain("END_TAIL");
    expect(res.content).toContain("[... truncated");
    expect(res.logPath).toBeDefined();

    if (res.logPath && existsSync(res.logPath)) {
      const savedContent = readFileSync(res.logPath, "utf8");
      expect(savedContent).toBe(fullText);
      unlinkSync(res.logPath);
    }
  });

  test("protects UTF-8 multi-byte character boundaries during clipping", () => {
    const chineseText = "测试中文字符截断，确保不会出现乱码字符。".repeat(20);
    const res = clipHeadAndTail(chineseText, {
      maxHeadBytes: 11, // Split in middle of 3-byte char if unaligned
      maxTailBytes: 11,
      maxTotalBytes: 30,
      saveTempLog: false,
    });
    expect(res.clipped).toBe(true);
    expect(res.content).not.toContain("\uFFFD");
  });
});

describe("tokenUsage Cache Token Parsing", () => {
  test("parses cache_read_input_tokens and cache_creation_input_tokens", () => {
    const raw = {
      prompt_tokens: 15000,
      completion_tokens: 500,
      cache_read_input_tokens: 12000,
      cache_creation_input_tokens: 2000,
    };
    const usage = parseUsageRecord(raw);
    expect(usage).toBeDefined();
    expect(usage?.input).toBe(15000);
    expect(usage?.output).toBe(500);
    expect(usage?.cacheRead).toBe(12000);
    expect(usage?.cacheWrite).toBe(2000);
  });

  test("parses OpenAI prompt_tokens_details.cached_tokens", () => {
    const raw = {
      prompt_tokens: 10000,
      completion_tokens: 300,
      prompt_tokens_details: {
        cached_tokens: 8000,
      },
    };
    const usage = parseUsageRecord(raw);
    expect(usage?.cacheRead).toBe(8000);
  });

  test("renders cache status in renderTokenStatus", () => {
    const tokens = {
      input: 15000,
      output: 500,
      cacheRead: 12000,
      contextWindow: 128000,
      remaining: 113000,
    };
    const status = renderTokenStatus(tokens);
    expect(status).toContain("in 15k");
    expect(status).toContain("(cache 12k)");
    expect(status).toContain("out 500");
    expect(status).toContain("left 113k");
  });

  test("merges usage records preserving cache totals and handling empty left", () => {
    const a = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800 };
    const b = { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 1500 };
    const merged = mergeUsageRecords(a, b) as Record<string, unknown>;
    expect(merged.input_tokens).toBe(3000);
    expect(merged.output_tokens).toBe(500);
    expect(merged.cache_read_input_tokens).toBe(2300);

    const mergedEmptyLeft = mergeUsageRecords(null, b);
    expect(mergedEmptyLeft).toEqual(b);
  });
});
