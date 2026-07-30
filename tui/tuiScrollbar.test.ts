import { describe, expect, test } from "bun:test";

import {
  consumeSgrMouseSequence,
  isSgrWheelEvent,
  parseScrollAction,
} from "./tuiScrollbar";

describe("consumeSgrMouseSequence", () => {
  test("returns a complete wheel-up report", () => {
    // SGR wheel-up: button 64, col 10, row 5, M (press)
    const seq = "\x1b[<64;10;5M";
    expect(consumeSgrMouseSequence(seq)).toBe(seq);
  });

  test("returns a complete plain-click report (button 0)", () => {
    const seq = "\x1b[<0;1;1M";
    expect(consumeSgrMouseSequence(seq)).toBe(seq);
  });

  test("returns undefined for an incomplete report (waiting for terminator)", () => {
    // Missing the trailing M/m — the reader should keep buffering.
    expect(consumeSgrMouseSequence("\x1b[<0;1;1")).toBe(undefined);
  });

  test("returns null for a non-mouse CSI sequence", () => {
    // Arrow key CSI — not a mouse report; caller's own CSI logic handles it.
    expect(consumeSgrMouseSequence("\x1b[A")).toBe(null);
  });

  test("returns null for a non-CSI buffer", () => {
    expect(consumeSgrMouseSequence("abc")).toBe(null);
  });
});

describe("isSgrWheelEvent", () => {
  test("true for wheel-up (64) and wheel-down (65)", () => {
    expect(isSgrWheelEvent("\x1b[<64;1;1M")).toBe(true);
    expect(isSgrWheelEvent("\x1b[<65;1;1M")).toBe(true);
  });

  test("false for a plain click (button 0)", () => {
    expect(isSgrWheelEvent("\x1b[<0;1;1M")).toBe(false);
  });

  test("false for horizontal wheel (66)", () => {
    expect(isSgrWheelEvent("\x1b[<66;1;1M")).toBe(false);
  });

  test("false for non-mouse input", () => {
    expect(isSgrWheelEvent("\x1b[A")).toBe(false);
  });
});

describe("parseScrollAction + mouse round-trip", () => {
  test("wheel-up report parses as wheel-up", () => {
    expect(parseScrollAction("\x1b[<64;1;1M")).toBe("wheel-up");
  });

  test("plain click report is NOT a scroll action", () => {
    // A click must not be misread as a scroll/cancel — it should be swallowed
    // by the dialog loop so re-entering the terminal window doesn't reject
    // the prompt.
    expect(parseScrollAction("\x1b[<0;1;1M")).toBe(null);
  });
});