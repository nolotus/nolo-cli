import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  brightnessFromRgb,
  detectTerminalBrightness,
  detectTerminalBackground,
  detectSystemBrightness,
  parseOsc11Reply,
  parseOsc11Background,
} from "./detectBackground";

/** Minimal TTY stdin stand-in that records raw-mode transitions. */
function fakeStdin() {
  const emitter = new EventEmitter() as any;
  emitter.isTTY = true;
  emitter.isRaw = false;
  emitter.rawModeCalls = [];
  emitter.setRawMode = (mode: boolean) => {
    emitter.rawModeCalls.push(mode);
    emitter.isRaw = mode;
  };
  emitter.resume = () => {};
  emitter.pause = () => {};
  emitter.off = emitter.removeListener.bind(emitter);
  return emitter;
}

function fakeStdout() {
  const writes: string[] = [];
  return {
    isTTY: true,
    writes,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  } as any;
}

describe("detectBackground", () => {
  test("classifies rgb by perceived luma", () => {
    expect(brightnessFromRgb(0, 0, 0)).toBe("dark");
    expect(brightnessFromRgb(255, 255, 255)).toBe("light");
    // Terminal.app default light gray and a typical dark editor background.
    expect(brightnessFromRgb(0xf0, 0xf0, 0xf2)).toBe("light");
    expect(brightnessFromRgb(0x1e, 0x1e, 0x2e)).toBe("dark");
  });

  test("parses 16-bit and short-form OSC 11 replies", () => {
    // 16-bit per channel — the common reply width.
    expect(parseOsc11Reply("\x1b]11;rgb:ffff/ffff/ffff\x07")).toBe("light");
    expect(parseOsc11Reply("\x1b]11;rgb:0000/0000/0000\x1b\\")).toBe("dark");
    // Narrower components must scale, not be read as tiny absolute values —
    // "ff/ff/ff" is white, and mis-scaling it would report "dark".
    expect(parseOsc11Reply("\x1b]11;rgb:ff/ff/ff\x07")).toBe("light");
    expect(parseOsc11Reply("garbage")).toBe(null);
  });

  test("resolves the brightness a terminal reports", async () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const pending = detectTerminalBrightness({ stdin, stdout, timeoutMs: 500, isTerminal: () => true });
    // The probe must actually ask before we answer.
    expect(stdout.writes.join("")).toBe("\x1b]11;?\x07");
    stdin.emit("data", Buffer.from("\x1b]11;rgb:fafa/fafa/fafa\x07", "latin1"));
    expect(await pending).toBe("light");
  });

  test("resolves null when the terminal stays silent, and restores raw mode", async () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    expect(await detectTerminalBrightness({ stdin, stdout, timeoutMs: 20, isTerminal: () => true })).toBe(null);
    // Raw mode was enabled to read the reply and must be handed back off, or
    // the TUI's own readline setup would start against a flipped terminal.
    expect(stdin.rawModeCalls).toEqual([true, false]);
    expect(stdin.listenerCount("data")).toBe(0);
  });

  test("resolves null for a non-TTY without writing a probe", async () => {
    const stdout = fakeStdout();
    stdout.isTTY = false;
    expect(await detectTerminalBrightness({ stdin: fakeStdin(), stdout, isTerminal: () => true })).toBe(null);
    expect(stdout.writes).toEqual([]);
  });

  test("skips a stream that only claims isTTY and never borrows it", async () => {
    // The default check requires a real tty.ReadStream. Borrowing a plain
    // duplex stream (a PassThrough wearing isTTY, or a pipe) resumes it and
    // swallows bytes the next reader needs — that regression hung every
    // raw-TTY integration test until the probe timed out.
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    expect(await detectTerminalBrightness({ stdin, stdout, timeoutMs: 20 })).toBe(null);
    expect(stdout.writes).toEqual([]);
    expect(stdin.rawModeCalls).toEqual([]);
    expect(stdin.listenerCount("data")).toBe(0);
  });

  test("parseOsc11Background returns brightness and uppercase hex", () => {
    // 16-bit per channel, the common reply width — must scale to bytes and
    // uppercase, without "#".
    expect(parseOsc11Background("\x1b]11;rgb:1e1e/1e1e/2e2e\x07")).toEqual({
      brightness: "dark",
      hex: "1E1E2E",
    });
    expect(parseOsc11Background("\x1b]11;rgb:ffff/ffff/ffff\x07")).toEqual({
      brightness: "light",
      hex: "FFFFFF",
    });
    expect(parseOsc11Background("garbage")).toBeNull();
  });

  test("detectTerminalBackground resolves the full background via probe", async () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const pending = detectTerminalBackground({
      stdin,
      stdout,
      timeoutMs: 500,
      isTerminal: () => true,
    });
    expect(stdout.writes.join("")).toBe("\x1b]11;?\x07");
    stdin.emit("data", Buffer.from("\x1b]11;rgb:1e1e/1e1e/2e2e\x07", "latin1"));
    expect(await pending).toEqual({ brightness: "dark", hex: "1E1E2E" });
  });

  test("detectTerminalBrightness thin wrapper still resolves brightness", async () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const pending = detectTerminalBrightness({
      stdin,
      stdout,
      timeoutMs: 500,
      isTerminal: () => true,
    });
    stdin.emit("data", Buffer.from("\x1b]11;rgb:fafa/fafa/fafa\x07", "latin1"));
    expect(await pending).toBe("light");
  });

  describe("detectSystemBrightness", () => {
    test("detects dark mode from AppleInterfaceStyle on macOS", () => {
      expect(detectSystemBrightness({ AppleInterfaceStyle: "Dark" })).toBe("dark");
      expect(detectSystemBrightness({ AppleInterfaceStyle: "dark" })).toBe("dark");
    });

    test("detects dark or light mode from COLOR_SCHEME", () => {
      expect(detectSystemBrightness({ COLOR_SCHEME: "prefer-dark" })).toBe("dark");
      expect(detectSystemBrightness({ COLOR_SCHEME: "prefer-light" })).toBe("light");
    });

    test("detects mode from GTK_THEME and QT_STYLE_OVERRIDE", () => {
      expect(detectSystemBrightness({ GTK_THEME: "Adwaita-dark" })).toBe("dark");
      expect(detectSystemBrightness({ QT_STYLE_OVERRIDE: "breeze-light" })).toBe("light");
    });

    test("returns null when no system dark/light signals match", () => {
      expect(detectSystemBrightness({})).toBe(null);
    });

    test("does not trigger subprocess check by default when allowSubprocess is omitted", () => {
      // Even if env is empty, without allowSubprocess: true, it must return null immediately
      // without running execFileSync.
      expect(detectSystemBrightness({}, {})).toBe(null);
      expect(detectSystemBrightness({})).toBe(null);
    });

    test("word boundary checks prevent false positives like flashlight", () => {
      expect(detectSystemBrightness({ COLOR_SCHEME: "flashlight" })).toBe(null);
    });

    test("detectTerminalBrightness falls back to system dark when allowSubprocess is true and OSC 11 stays silent", async () => {
      const stdin = fakeStdin();
      const stdout = fakeStdout();
      const prev = process.env.COLOR_SCHEME;
      process.env.COLOR_SCHEME = "prefer-dark";
      try {
        const pending = detectTerminalBrightness({
          stdin,
          stdout,
          timeoutMs: 20,
          isTerminal: () => true,
          allowSubprocess: true,
        });
        expect(await pending).toBe("dark");
      } finally {
        if (prev === undefined) delete process.env.COLOR_SCHEME;
        else process.env.COLOR_SCHEME = prev;
      }
    });

    test("detectTerminalBackground with allowSystemFallback resolves {brightness:'dark', hex:''} on a silent terminal", async () => {
      const stdin = fakeStdin();
      const stdout = fakeStdout();
      const prev = process.env.COLOR_SCHEME;
      process.env.COLOR_SCHEME = "prefer-dark";
      try {
        const pending = detectTerminalBackground({
          stdin,
          stdout,
          timeoutMs: 20,
          isTerminal: () => true,
          allowSystemFallback: true,
        });
        expect(await pending).toEqual({ brightness: "dark", hex: "" });
      } finally {
        if (prev === undefined) delete process.env.COLOR_SCHEME;
        else process.env.COLOR_SCHEME = prev;
      }
    });

    test("detectTerminalBackground without allowSystemFallback stays null on a silent terminal (hot path never forks)", async () => {
      const stdin = fakeStdin();
      const stdout = fakeStdout();
      const pending = detectTerminalBackground({
        stdin,
        stdout,
        timeoutMs: 20,
        isTerminal: () => true,
      });
      expect(await pending).toBeNull();
    });
  });
});
