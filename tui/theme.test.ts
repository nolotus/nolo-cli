import { describe, expect, test } from "bun:test";
import {
  resolveTuiBrightness,
  themeColorSequence,
  themeText,
  highlightMarkdown,
  blendHex,
  diffLineSequences,
  setActiveThemeName,
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
      expect(formatted).toContain("\x1b[38;2;154;163;184mcode\x1b[39m"); // trail dark muted
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

  describe("blendHex & diffLineSequences", () => {
    test("blendHex calculates weighted color mix correctly", () => {
      expect(blendHex("FFFFFF", "000000", 0)).toBe("000000");
      expect(blendHex("FFFFFF", "000000", 1)).toBe("FFFFFF");
      expect(blendHex("FFFFFF", "000000", 0.5)).toBe("808080");
    });

    test("blendHex clamps out-of-range weights instead of extrapolating", () => {
      expect(blendHex("FFFFFF", "000000", -1)).toBe("000000");
      expect(blendHex("FFFFFF", "000000", 4)).toBe("FFFFFF");
    });

    test("blendHex falls back to base on malformed hex, never emitting NaN", () => {
      // "ABC" would slice into an empty blue channel and round to NaN, whose
      // hex string is the literal "NaN" — that would ship \x1b[48;2;…NaN…m.
      for (const bad of ["ABC", "", "GGGGGG", "12345"]) {
        const result = blendHex(bad, "102030", 0.5);
        expect(result).toBe("102030");
        expect(result).not.toContain("NaN");
      }
      expect(blendHex("FFFFFF", "xyz", 0.5)).toBe("XYZ");
    });

    test("diff background sequences never contain NaN channels", () => {
      const diff = diffLineSequences({ COLORTERM: "truecolor" }, "dark");
      expect(diff).not.toBeNull();
      expect(diff!.added.bg).toMatch(/^\x1b\[48;2;\d+;\d+;\d+m$/);
      expect(diff!.removed.bg).toMatch(/^\x1b\[48;2;\d+;\d+;\d+m$/);
    });

    test("diffLineSequences returns null when truecolor is not supported", () => {
      expect(diffLineSequences({}, "dark")).toBeNull();
    });

    test("diffLineSequences updates when active theme changes", () => {
      try {
        const trailDiff = diffLineSequences({ COLORTERM: "truecolor" }, "dark");
        setActiveThemeName("rose");
        const roseDiff = diffLineSequences({ COLORTERM: "truecolor" }, "dark");
        expect(roseDiff?.added.fg).not.toBe(trailDiff?.added.fg);
      } finally {
        setActiveThemeName("trail");
      }
    });
  });
});