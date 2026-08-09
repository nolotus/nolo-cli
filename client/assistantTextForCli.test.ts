import { describe, expect, test } from "bun:test";
import { formatAssistantTextForCli } from "./assistantOutput";

describe("formatAssistantTextForCli", () => {
  test("strips think tags from content", () => {
    expect(formatAssistantTextForCli("你好\u003cthink\u003esecret\u003c/think\u003e结束")).toBe(
      "你好结束",
    );
  });

  test("returns clean text unchanged", () => {
    expect(formatAssistantTextForCli("just normal text")).toBe("just normal text");
  });

  test("collapses excessive newlines", () => {
    expect(formatAssistantTextForCli("line1\n\n\n\nline2")).toBe("line1\n\nline2");
  });

  test("trims leading/trailing whitespace", () => {
    expect(formatAssistantTextForCli("  hello  ")).toBe("hello");
  });

  test("handles empty string", () => {
    expect(formatAssistantTextForCli("")).toBe("");
  });
});