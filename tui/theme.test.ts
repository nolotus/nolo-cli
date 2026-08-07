import { describe, expect, test, beforeEach } from "bun:test";
import {
  applyDetectedBackground,
  blendHex,
  diffLineSequences,
  getActiveBrightness,
  getActiveTerminalBaseHex,
  renderDiffLine,
  resolveTuiBrightness,
  setActiveBrightness,
  setActiveTerminalBaseHex,
  setActiveThemeName,
  supportsTruecolor,
  themeColorSequence,
  themeText,
} from "./theme";

describe("tui theme", () => {
  beforeEach(() => {
    // 默认主题已改为 catppuccin；测 trail 专有色值的用例自行 setActiveThemeName("trail")。
    setActiveThemeName("catppuccin");
  });
  test("truecolor terminals get the exact catppuccin primary (default theme)", () => {
    expect(themeColorSequence("accent", { COLORTERM: "truecolor" })).toBe(
      "\x1b[38;2;137;180;250m", // catppuccin dark accent (default) — Mocha blue #89B4FA
    );
  });

  test("non-truecolor terminals fall back to ANSI-16", () => {
    expect(themeColorSequence("accent", {})).toBe("\x1b[34m");
    expect(themeColorSequence("chrome", {})).toBe("\x1b[90m");
  });

  test("light theme accent uses trail light blue", () => {
    setActiveThemeName("trail");
    expect(themeColorSequence("accent", { COLORTERM: "truecolor", NOLO_TUI_THEME: "light" })).toBe(
      "\x1b[38;2;46;125;181m",
    );
  });

  test("trail light warning is the deeper amber 9A6A1F (H2 contrast on white)", () => {
    // Owner feedback: ## Plan / H2 headers floated yellow on white. The hex
    // was deepened from B57F2E → 9A6A1F for more contrast on light backgrounds.
    setActiveThemeName("trail");
    expect(themeColorSequence("warning", { COLORTERM: "truecolor", NOLO_TUI_THEME: "light" })).toBe(
      "\x1b[38;2;154;106;31m",
    );
  });

  test("trail light muted is the denser slate 5E6A78 (not lighter than the old 687584)", () => {
    // 687584 read as a wash of saturated blue in dense prose (inline code /
    // tool labels). 5E6A78 pulls the blue channel down and stays darker, so
    // white-background contrast is preserved.
    setActiveThemeName("trail");
    const env = { COLORTERM: "truecolor", NOLO_TUI_THEME: "light" };
    expect(themeColorSequence("muted", env)).toBe("\x1b[38;2;94;106;120m");
    // Hard constraint: new value must not be lighter than the old one.
    // Luminance-ish check: average channel value must be <= old average.
    const oldAvg = (0x68 + 0x75 + 0x84) / 3;
    const newAvg = (0x5e + 0x6a + 0x78) / 3;
    expect(newAvg).toBeLessThanOrEqual(oldAvg);
  });

  test("dark theme accent uses Catppuccin Mocha blue", () => {
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

  describe("supportsTruecolor", () => {
    test("NOLO_TUI_TRUECOLOR=0 overrides COLORTERM=truecolor", () => {
      expect(
        supportsTruecolor({ COLORTERM: "truecolor", NOLO_TUI_TRUECOLOR: "0" })
      ).toBe(false);
    });

    test("NOLO_TUI_TRUECOLOR=1 forces truecolor without any other signal", () => {
      expect(supportsTruecolor({ NOLO_TUI_TRUECOLOR: "1" })).toBe(true);
    });

    test("TERM_PROGRAM=ghostty with no COLORTERM is truecolor", () => {
      // tmux / SSH / VS Code integrated terminal don't set COLORTERM; the
      // TERM_PROGRAM allowlist is the second signal that keeps backgrounds on.
      expect(supportsTruecolor({ TERM_PROGRAM: "ghostty" })).toBe(true);
    });

    test("TERM_PROGRAM=Apple_Terminal is not truecolor", () => {
      // Apple Terminal is 256-color; admitting it would approximate 24-bit
      // SGR into the wrong hue.
      expect(supportsTruecolor({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
    });

    test("TERM containing direct/24bit is truecolor", () => {
      expect(supportsTruecolor({ TERM: "xterm-direct" })).toBe(true);
      expect(supportsTruecolor({ TERM: "xterm-24bit" })).toBe(true);
    });
  });

  describe("activeTerminalBaseHex", () => {
    beforeEach(() => {
      // Module-level state must not leak between cases.
      setActiveTerminalBaseHex(null);
    });

    test("invalid hex stores null and diffLineSequences never emits NaN", () => {
      setActiveTerminalBaseHex("ZZZZZZ");
      expect(getActiveTerminalBaseHex()).toBeNull();
      const diff = diffLineSequences({ COLORTERM: "truecolor" }, "dark");
      expect(diff).not.toBeNull();
      // NaN would render as a literal "NaN" channel, which \d+ must reject.
      // Check every background-bearing kind, not just added.
      const bgSgr = /^\x1b\[48;2;\d+;\d+;\d+m$/;
      for (const kind of ["added", "removed", "hunk"] as const) {
        expect(diff![kind].bg).toMatch(bgSgr);
      }
    });

    test("a non-default base changes added.bg vs the default base", () => {
      const env = { COLORTERM: "truecolor" };
      const defaultDiff = diffLineSequences(env, "dark");
      expect(defaultDiff).not.toBeNull();
      setActiveTerminalBaseHex("000000");
      expect(getActiveTerminalBaseHex()).toBe("000000");
      const blackBaseDiff = diffLineSequences(env, "dark");
      expect(blackBaseDiff).not.toBeNull();
      expect(blackBaseDiff!.added.bg).not.toBe(defaultDiff!.added.bg);
    });
  });

  describe("renderDiffLine", () => {
    const env = { COLORTERM: "truecolor", NOLO_TUI_THEME: "dark" };

    test("pads by display width, not code-unit count, for CJK text", () => {
      // displayWidth("+ 中文") = 1 + 1 + 2 + 2 = 6 (CJK double-width);
      // code-unit length is 4. padTo=10 → 4 spaces, not 6.
      const out = renderDiffLine({ kind: "added", text: "+ 中文", padTo: 10, env, colorEnabled: true });
      expect(out.endsWith("    \x1b[0m")).toBe(true);
      expect(out.endsWith("      \x1b[0m")).toBe(false);
    });

    test("output ends with \\x1b[0m so the tint never leaks", () => {
      const out = renderDiffLine({ kind: "removed", text: "- gone", padTo: 8, env, colorEnabled: true });
      expect(out.endsWith("\x1b[0m")).toBe(true);
    });

    test("non-truecolor env renders no background (no 48;2) and context passes through", () => {
      const out = renderDiffLine({ kind: "added", text: "+ foo", env: {}, colorEnabled: true });
      expect(out).not.toContain("48;2");
      expect(renderDiffLine({ kind: "context", text: " ctx", env: {}, colorEnabled: true })).toBe(" ctx");
    });
  });

  describe("applyDetectedBackground", () => {
    test("records a fresh detection and reports a change", () => {
      setActiveBrightness(null);
      setActiveTerminalBaseHex(null);
      const changed = applyDetectedBackground({ brightness: "dark", hex: "1E1E2E" });
      expect(changed).toBe(true);
      expect(getActiveBrightness()).toBe("dark");
      expect(getActiveTerminalBaseHex()).toBe("1E1E2E");
    });

    test("returns false when the terminal already matched", () => {
      setActiveBrightness("dark");
      setActiveTerminalBaseHex("1E1E2E");
      expect(applyDetectedBackground({ brightness: "dark", hex: "1E1E2E" })).toBe(false);
      expect(getActiveBrightness()).toBe("dark");
      expect(getActiveTerminalBaseHex()).toBe("1E1E2E");
    });

    test("returns true when only brightness changes (same hex)", () => {
      setActiveBrightness("dark");
      setActiveTerminalBaseHex("1E1E2E");
      expect(applyDetectedBackground({ brightness: "light", hex: "1E1E2E" })).toBe(true);
      expect(getActiveBrightness()).toBe("light");
      expect(getActiveTerminalBaseHex()).toBe("1E1E2E");
    });

    test("returns true when only the exact hex changes (same brightness)", () => {
      setActiveBrightness("dark");
      setActiveTerminalBaseHex("1E1E2E");
      expect(applyDetectedBackground({ brightness: "dark", hex: "2E2E3E" })).toBe(true);
      expect(getActiveBrightness()).toBe("dark");
      expect(getActiveTerminalBaseHex()).toBe("2E2E3E");
    });

    test("normalizes a lower-case hex before comparing (no repeat repaint)", () => {
      setActiveBrightness(null);
      setActiveTerminalBaseHex(null);
      expect(applyDetectedBackground({ brightness: "dark", hex: "1e1e2e" })).toBe(true);
      expect(getActiveBrightness()).toBe("dark");
      expect(getActiveTerminalBaseHex()).toBe("1E1E2E");
      // Same lower-case input again: normalized comparison sees no change.
      expect(applyDetectedBackground({ brightness: "dark", hex: "1e1e2e" })).toBe(false);
    });

    test("normalizes a '#'-prefixed hex before comparing (no repeat repaint)", () => {
      setActiveBrightness(null);
      setActiveTerminalBaseHex(null);
      expect(applyDetectedBackground({ brightness: "dark", hex: "#1E1E2E" })).toBe(true);
      expect(getActiveBrightness()).toBe("dark");
      expect(getActiveTerminalBaseHex()).toBe("1E1E2E");
      // Same '#1E1E2E' input again: normalized comparison sees no change.
      expect(applyDetectedBackground({ brightness: "dark", hex: "#1E1E2E" })).toBe(false);
    });
  });
});
