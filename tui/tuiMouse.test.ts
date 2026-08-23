import { describe, expect, test } from "bun:test";
import {
  consumeSgrMouseSequence,
  parseSgrMouseEvent,
  type TuiMouseEvent,
} from "./tuiMouse";

describe("tuiMouse parser", () => {
  test("parses left button press", () => {
    const seq = "\x1b[<0;20;10M";
    const ev = parseSgrMouseEvent(seq);
    expect(ev).toEqual({
      kind: "press",
      button: "left",
      x: 20,
      y: 10,
      shift: false,
      alt: false,
      ctrl: false,
    });
  });

  test("parses button release", () => {
    const seq = "\x1b[<0;25;12m";
    const ev = parseSgrMouseEvent(seq);
    expect(ev).toEqual({
      kind: "release",
      button: "left",
      x: 25,
      y: 12,
      shift: false,
      alt: false,
      ctrl: false,
    });
  });

  test("parses mouse drag (button + motion)", () => {
    // 32 = motion with left button (0 + 32)
    const seq = "\x1b[<32;40;15M";
    const ev = parseSgrMouseEvent(seq);
    expect(ev).toEqual({
      kind: "drag",
      button: "left",
      x: 40,
      y: 15,
      shift: false,
      alt: false,
      ctrl: false,
    });
  });

  test("parses wheel up and down", () => {
    const upSeq = "\x1b[<64;10;5M";
    const upEv = parseSgrMouseEvent(upSeq);
    expect(upEv).toEqual({
      kind: "wheel",
      button: "none",
      x: 10,
      y: 5,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDirection: "up",
    });

    const downSeq = "\x1b[<65;10;5M";
    const downEv = parseSgrMouseEvent(downSeq);
    expect(downEv).toEqual({
      kind: "wheel",
      button: "none",
      x: 10,
      y: 5,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDirection: "down",
    });
  });

  test("parses modifiers (Shift, Alt, Ctrl)", () => {
    // Left drag (32) + Shift (4) + Alt (8) + Ctrl (16) = 60
    const seq = "\x1b[<60;30;8M";
    const ev = parseSgrMouseEvent(seq);
    expect(ev).toEqual({
      kind: "drag",
      button: "left",
      x: 30,
      y: 8,
      shift: true,
      alt: true,
      ctrl: true,
    });
  });

  test("consumeSgrMouseSequence handles buffering correctly", () => {
    expect(consumeSgrMouseSequence("\x1b[<0;10;5M")).toBe("\x1b[<0;10;5M");
    expect(consumeSgrMouseSequence("\x1b[<0;10;5")).toBeUndefined();
    expect(consumeSgrMouseSequence("\x1b[A")).toBeNull();
    expect(consumeSgrMouseSequence("hello")).toBeNull();
  });
});
