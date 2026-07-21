import { describe, expect, test } from "bun:test";
import { createDialogHost, resolveDialogBottomRow } from "./dialogHost";

function createComposerSpy(inputLines = 2) {
  const calls: string[] = [];
  let paused = false;
  return {
    calls,
    composer: {
      pause() {
        paused = true;
        calls.push("pause");
      },
      resumeFromDialog() {
        paused = false;
        calls.push("resume");
      },
      getInputLines: () => inputLines,
      isPaused: () => paused,
    },
  };
}

const output = { rows: 30, write: () => true } as unknown as NodeJS.WritableStream;

describe("resolveDialogBottomRow", () => {
  test("stacks the frame just above the docked composer", () => {
    expect(resolveDialogBottomRow({ output: { rows: 30 }, inputLines: 2 })).toBe(28);
  });

  test("falls back to 24 rows when the stream reports no size", () => {
    expect(resolveDialogBottomRow({ output: {}, inputLines: 2 })).toBe(22);
  });

  test("never returns a row above the top of the screen", () => {
    expect(resolveDialogBottomRow({ output: { rows: 1 }, inputLines: 40 })).toBe(1);
  });
});

describe("createDialogHost", () => {
  test("pauses the composer around the dialog and anchors it", async () => {
    const { calls, composer } = createComposerSpy();
    const host = createDialogHost({ composer, output });

    const anchor = await host.run(async (a) => a);

    expect(anchor.bottomAnchored).toBe(true);
    expect(anchor.bottomRow()).toBe(28);
    expect(calls).toEqual(["pause", "resume"]);
  });

  test("anchor resolves lazily so a terminal resize re-docks the dialog", async () => {
    // The picker used to capture bottomRow once at open; dragging the window
    // then left the frame frozen at the pre-resize rows instead of stacked
    // above the composer.
    const { composer } = createComposerSpy();
    const resizable = { rows: 30, write: () => true } as unknown as NodeJS.WritableStream;
    const host = createDialogHost({ composer, output: resizable });

    await host.run(async (anchor) => {
      expect(anchor.bottomRow()).toBe(28);
      (resizable as { rows: number }).rows = 20;
      expect(anchor.bottomRow()).toBe(18);
    });
  });

  test("reports paused while the dialog body runs", async () => {
    // This is what suppresses the transcript repaint underneath an open
    // dialog; if it were false mid-body, streaming tokens would erase the
    // frame — the exact failure that made the confirm prompt invisible.
    const { composer } = createComposerSpy();
    const host = createDialogHost({ composer, output });

    let pausedDuringBody = false;
    await host.run(async () => {
      pausedDuringBody = composer.isPaused();
    });

    expect(pausedDuringBody).toBe(true);
    expect(composer.isPaused()).toBe(false);
  });

  test("restores the composer when the dialog throws", async () => {
    const { calls, composer } = createComposerSpy();
    const host = createDialogHost({ composer, output });

    let thrown: unknown = null;
    try {
      await host.run(async () => {
        throw new Error("picker exploded");
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error | null)?.message).toBe("picker exploded");

    expect(calls).toEqual(["pause", "resume"]);
    expect(composer.isPaused()).toBe(false);
  });
});
