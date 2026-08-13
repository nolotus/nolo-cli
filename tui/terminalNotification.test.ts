import { describe, expect, test } from "bun:test";
import { emitTerminalBell, shouldEmitTerminalBell } from "./terminalNotification";

describe("terminal turn notification", () => {
  test.each([
    ["normal interactive completion", { wasAborted: false, exitCode: 0, interactive: true }, true],
    ["aborted turn", { wasAborted: true, exitCode: 0, interactive: true }, false],
    ["stream interruption", { wasAborted: false, streamInterrupted: true, exitCode: 0, interactive: true }, false],
    ["failed turn", { wasAborted: false, exitCode: 1, interactive: true }, false],
    ["non-interactive completion", { wasAborted: false, exitCode: 0, interactive: false }, false],
  ])("%s", (_name, decision, expected) => {
    expect(shouldEmitTerminalBell(decision)).toBe(expected);
  });

  test("writes a BEL without adding layout text", () => {
    let received = "";
    emitTerminalBell({
      write(chunk: string) {
        received += chunk;
        return true;
      },
    });
    expect(received).toBe("\x07");
  });

  test("does not throw when the terminal rejects the notification", () => {
    expect(() =>
      emitTerminalBell({
        write() {
          throw new Error("closed");
        },
      }),
    ).not.toThrow();
  });
});
