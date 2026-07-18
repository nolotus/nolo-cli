import { describe, expect, test } from "bun:test";
import { themeColorSequence, themeText } from "./theme";

describe("tui theme", () => {
  test("truecolor terminals get the exact catppuccin primary", () => {
    expect(themeColorSequence("accent", { COLORTERM: "truecolor" })).toBe(
      "\x1b[38;2;30;102;245m",
    );
  });

  test("non-truecolor terminals fall back to ANSI-16", () => {
    expect(themeColorSequence("accent", {})).toBe("\x1b[34m");
    expect(themeColorSequence("chrome", {})).toBe("\x1b[90m");
  });

  test("themeText wraps and closes with default-foreground", () => {
    const styled = themeText("⬢ nolo", "accent", true);
    expect(styled).toContain("⬢ nolo");
    expect(styled.endsWith("\x1b[39m")).toBe(true);
    expect(themeText("plain", "accent", false)).toBe("plain");
  });
});
