import { describe, expect, test } from "bun:test";
import {
  resolveTuiBrightness,
  themeColorSequence,
  themeText,
  highlightMarkdown,
} from "./theme";

describe("tui theme", () => {
  test("truecolor terminals get the exact catppuccin primary", () => {
    expect(themeColorSequence("accent", { COLORTERM: "truecolor" })).toBe(
      "\x1b[38;2;137;180;250m", // dark accent (default)
    );
  });

  test("non-truecolor terminals fall back to ANSI-16", () => {
    expect(themeColorSequence("accent", {})).toBe("\x1b[34m");
    expect(themeColorSequence("chrome", {})).toBe("\x1b[90m");
  });

  test("light theme accent uses trail light blue", () => {
    expect(themeColorSequence("accent", { COLORTERM: "truecolor", NOLO_TUI_THEME: "light" })).toBe(
      "\x1b[38;2;46;125;181m",
    );
  });

  test("dark theme accent uses mocha blue", () => {
    expect(themeColorSequence("accent", { COLORTERM: "truecolor", NOLO_TUI_THEME: "dark" })).toBe(
      "\x1b[38;2;137;180;250m",
    );
  });

  test("brightness detection respects NOLO_TUI_THEME", () => {
    expect(resolveTuiBrightness({ NOLO_TUI_THEME: "light" })).toBe("light");
    expect(resolveTuiBrightness({ NOLO_TUI_THEME: "dark" })).toBe("dark");
  });

  test("brightness detection reads COLORFGBG", () => {
    // Format is "fg;bg" — the background value (2nd) determines brightness.
    // 0–6 = dark background, 7–15 = light background.
    expect(resolveTuiBrightness({ COLORFGBG: "0;0" })).toBe("dark");
    expect(resolveTuiBrightness({ COLORFGBG: "15;0" })).toBe("dark"); // bright fg, dark bg
    expect(resolveTuiBrightness({ COLORFGBG: "0;7" })).toBe("light"); // dark fg, light bg
    expect(resolveTuiBrightness({ COLORFGBG: "0;15" })).toBe("light");
  });

  test("defaults to dark when no hints are present", () => {
    expect(resolveTuiBrightness({})).toBe("dark");
  });

  test("themeText wraps and closes with default-foreground", () => {
    const styled = themeText("⬢ nolo", "accent", true);
    expect(styled).toContain("⬢ nolo");
    expect(styled.endsWith("\x1b[39m")).toBe(true);
    expect(themeText("plain", "accent", false)).toBe("plain");
  });

  test("themeText with explicit brightness uses the right palette", () => {
    // Need truecolor for the hex codes to differ (ANSI-16 fallbacks are the
    // same for light/dark chrome).
    const lightStyled = themeText("x", "chrome", true, { COLORTERM: "truecolor", NOLO_TUI_THEME: "light" });
    const darkStyled = themeText("x", "chrome", true, { COLORTERM: "truecolor", NOLO_TUI_THEME: "dark" });
    // latte chrome #9799A4 vs mocha chrome #6C7086
    expect(lightStyled).not.toBe(darkStyled);
  });

  describe("markdown highlighter", () => {
    test("leaves plain text alone when color is disabled", () => {
      expect(highlightMarkdown("hello **world**", false)).toBe("hello **world**");
    });

    test("formats bold text with bold escape codes", () => {
      const formatted = highlightMarkdown("hello **world**", true);
      expect(formatted).toBe("hello \x1b[1mworld\x1b[22m");
    });

    test("formats inline code with muted color, not the code-block info hue", () => {
      const env = { COLORTERM: "truecolor", NOLO_TUI_THEME: "dark" };
      const formatted = highlightMarkdown("this is `code`", true, env);
      expect(formatted).toContain("\x1b[38;2;166;173;200mcode\x1b[39m"); // trail dark muted
      expect(formatted).not.toContain("\x1b[38;2;148;226;213m"); // info stays for blocks only
    });

    test("formats code blocks with custom frame and info color", () => {
      const env = { COLORTERM: "truecolor", NOLO_TUI_THEME: "dark" };
      const codeBlock = "```ts\nconst x = 1;\n```";
      const formatted = highlightMarkdown(codeBlock, true, env);
      expect(formatted).toContain("┌───");
      expect(formatted).toContain("└───");
      expect(formatted).toContain(themeText("│", "chrome", true, env));
      expect(formatted).toContain("const x = 1;");
    });
  });
});