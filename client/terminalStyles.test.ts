import { describe, expect, test } from "bun:test";
import { dimCliText, resolveCliColorEnabled, styleCliText } from "./terminalStyles";

describe("terminalStyles", () => {
  test("disables styling when NO_COLOR is set", () => {
    expect(resolveCliColorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(dimCliText("tool", false)).toBe("tool");
  });

  test("wraps text with dim ANSI when color is enabled", () => {
    expect(styleCliText("tool", "dim", true)).toBe("\x1b[2mtool\x1b[0m");
  });
});