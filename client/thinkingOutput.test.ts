import { describe, expect, test } from "bun:test";

import {
  collapseThinkingBlocks,
  createThinkingAwareStreamFilter,
  formatAssistantTextForCli,
  normalizeThinkingDisplayMode,
} from "./thinkingOutput";

describe("thinkingOutput", () => {
  test("defaults to hide mode", () => {
    expect(normalizeThinkingDisplayMode(undefined)).toBe("hide");
    expect(formatAssistantTextForCli("你好\n<think>secret</think>\n结束", "hide")).toBe(
      "你好\n结束"
    );
  });

  test("strips server-side collapsed markers in hide mode", () => {
    expect(
      formatAssistantTextForCli("前缀\n▸ 思考已折叠\n\n后缀", "hide")
    ).toBe("前缀\n后缀");
  });

  test("shows marker mode text", () => {
    expect(collapseThinkingBlocks("<think>secret</think>\n答案", "marker")).toContain(
      "▸ 思考已折叠"
    );
  });

  test("streams visible text while hiding think blocks", () => {
    const chunks: string[] = [];
    const filter = createThinkingAwareStreamFilter((chunk) => chunks.push(chunk), "hide");

    filter.push("前缀");
    filter.push("<think>");
    filter.push("secret");
    filter.push("</think>");
    filter.push("\n▸ 思考已折叠\n");
    filter.push("后缀");
    filter.flush();

    expect(chunks.join("")).toBe("前缀\n后缀");
  });
});