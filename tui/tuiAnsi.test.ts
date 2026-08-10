import { describe, expect, test } from "bun:test";
import { buildWindowTitle } from "./tuiAnsi";

describe("buildWindowTitle", () => {
  test("strips ANSI sequences from title", () => {
    const res = buildWindowTitle("\x1b[31mBold Red Title\x1b[0m");
    expect(res).toBe("\x1b]0;Bold Red Title\x07\x1b]2;Bold Red Title\x07");
  });

  test("replaces CRLF and LF newlines with spaces", () => {
    const res = buildWindowTitle("First Line\r\nSecond Line\nThird Line");
    expect(res).toBe(
      "\x1b]0;First Line Second Line Third Line\x07\x1b]2;First Line Second Line Third Line\x07",
    );
  });

  test("truncates title exceeding 80 display columns, accounting for CJK width", () => {
    // 42 Chinese characters (width 2 each = 84 cols), should truncate to 40 characters (80 cols)
    const longTitle = "测试".repeat(21);
    const res = buildWindowTitle(longTitle);
    const expectedText = "测试".repeat(20);
    expect(res).toBe(`\x1b]0;${expectedText}\x07\x1b]2;${expectedText}\x07`);
  });

  test("uses BEL (\\x07) as string terminator for both OSC 0 and OSC 2", () => {
    const res = buildWindowTitle("Hello World");
    expect(res.startsWith("\x1b]0;Hello World\x07")).toBe(true);
    expect(res.endsWith("\x1b]2;Hello World\x07")).toBe(true);
    expect(res).toBe("\x1b]0;Hello World\x07\x1b]2;Hello World\x07");
  });

  test("filters C0 control characters (BEL/ESC) so they cannot break the OSC sequence", () => {
    const res = buildWindowTitle("Task\x07Urgent");
    // The embedded BEL must be replaced with a space, not terminate the sequence early.
    expect(res).toBe("\x1b]0;Task Urgent\x07\x1b]2;Task Urgent\x07");
  });
});
