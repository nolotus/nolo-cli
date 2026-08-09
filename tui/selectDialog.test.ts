import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { getCliLocale, setCliLocale } from "./i18n";
import {
  createRawKeyReader,
  renderSelectDialog,
  runSelectDialog,
  type SelectDialogItem,
  type SelectDialogResult,
} from "./selectDialog";

// String assertions target the English strings; pin the locale for machines
// whose LANG resolves to zh.
const originalLocale = getCliLocale();
beforeAll(() => setCliLocale("en"));
afterAll(() => setCliLocale(originalLocale));

describe("selectDialog", () => {
  test("renders a marker on the selected row", () => {
    const output = renderSelectDialog({
      items: [
        { label: "nolo", detail: "platform" },
        { label: "MiniMax M3", detail: "custom" },
      ],
      selectedIndex: 1,
      title: "Select agent",
    });

    expect(output).toContain("❯ MiniMax M3  custom");
    expect(output).toContain("  nolo  platform");
  });

  test("renders only a partial window for long lists", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      label: `agent-${index + 1}`,
    }));
    const output = renderSelectDialog({
      items,
      selectedIndex: 10,
      maxVisible: 5,
    });

    expect(output).toContain("11/12");
    expect(output).toContain("↑ 7 more");
    expect(output).toContain("❯ agent-11");
    expect(output).not.toContain("agent-1\n");
  });

  test("re-anchors above the composer when the terminal resizes", async () => {
    const writes: string[] = [];
    const listeners = new Map<string, () => void>();
    const output = {
      isTTY: true,
      rows: 30,
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
      on(event: string, listener: () => void) {
        listeners.set(event, listener);
      },
      off(event: string) {
        listeners.delete(event);
      },
    } as unknown as NodeJS.WritableStream & { rows: number };

    const keys = ["\r"];
    const resultPromise = runSelectDialog<SelectDialogItem>({
      items: [{ label: "nolo" }],
      readKey: async () => keys.shift() ?? null,
      input: { isTTY: false } as NodeJS.ReadStream,
      output,
      bottomAnchored: true,
      bottomRow: () => output.rows - 2,
    });

    // Initial paint anchors at rows-2 = 28.
    expect(writes.join("")).toContain("\x1b[28;1H");

    // Drag the window smaller: the frame must clear its old rows and repaint
    // at the new anchor instead of staying frozen at row 28.
    output.rows = 20;
    writes.length = 0;
    listeners.get("resize")?.();
    const repainted = writes.join("");
    expect(repainted).toContain("\x1b[28;1H\x1b[2K"); // old position cleared
    expect(repainted).toContain("\x1b[18;1H"); // new anchor painted

    const result = await resultPromise;
    expect(result).toEqual({ kind: "selected", index: 0, item: { label: "nolo" } });
    expect(listeners.has("resize")).toBe(false); // listener disposed on close
  });

  test("selects with arrow keys and enter", async () => {
    const keys = ["\x1b[B", "\r"];
    const result = await runSelectDialog<SelectDialogItem>({
      items: [
        { label: "nolo" },
        { label: "grok" },
      ],
      readKey: async () => keys.shift() ?? null,
      input: { isTTY: false } as NodeJS.ReadStream,
      output: { isTTY: false, write() {} } as unknown as NodeJS.WritableStream,
    });

    expect(result).toEqual({
      kind: "selected",
      index: 1,
      item: { label: "grok" },
    });
  });

  test("cancels on escape", async () => {
    const result = await runSelectDialog<SelectDialogItem>({
      items: [{ label: "nolo" }],
      readKey: async () => "\u001b",
      input: { isTTY: false } as NodeJS.ReadStream,
      output: { isTTY: false, write() {} } as unknown as NodeJS.WritableStream,
    });

    expect(result).toEqual({ kind: "cancelled" });
  });

  test("a stray mouse click is swallowed, not treated as cancel", async () => {
    // Regression: re-entering the terminal window from another app sends an
    // SGR mouse-click report (ESC [ < button ; col ; row M). The raw key
    // reader used to drop multi-byte CSI sequences into an 8-byte bucket and
    // return null, which the dialog loop read as "stream closed" → cancel.
    // Feed a real click sequence followed by Enter through createRawKeyReader
    // and assert the dialog stays open and selects normally.
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    let settled: SelectDialogResult<SelectDialogItem> | undefined;
    const resultPromise = runSelectDialog<SelectDialogItem>({
      items: [{ label: "nolo" }, { label: "grok" }],
      readKey,
      input,
      output: { isTTY: false, write() {} } as unknown as NodeJS.WritableStream,
    });
    resultPromise.then((r) => {
      settled = r;
    });

    // Emit a plain left-click SGR mouse report, then arrow-down, then Enter.
    // Wait a microtask between writes so the 'data' listener can deliver.
    input.emit("data", "\x1b[<0;5;5M");
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBeUndefined(); // click must not cancel the dialog

    input.emit("data", "\x1b[B");
    await new Promise((r) => setTimeout(r, 10));
    input.emit("data", "\r");
    const result = await resultPromise;
    expect(result).toEqual({
      kind: "selected",
      index: 1,
      item: { label: "grok" },
    });
  });

  test("a wheel report scrolls the list, never cancels", async () => {
    // Regression for the reported bug: scrolling the wheel in a select dialog
    // cancelled it. The wheel arrives as one SGR report `\x1b[<...M`; the
    // reader recognizes it (consumeSgrMouseSequence) and parseScrollAction
    // turns it into a wheel-down that moves the highlight — instead of the
    // old path that had no SGR parser and let the ESC-led bytes fall through
    // to isCancel().
    //
    // NOTE: the report is emitted as a single `data` chunk. In a real raw-mode
    // terminal the kernel hands the whole report to one read(), so it never
    // arrives byte-by-byte. The previous version of this test split it across
    // two emits and relied on a 15ms hand-rolled esc-pending timer to reassemble
    // it; that timer is the hand-written state machine spec 2a forbids, and
    // it was only needed to make the split test pass. Emitting whole reflects
    // real delivery and lets the reader be timer-free.
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const writes: string[] = [];
    const resultPromise = runSelectDialog<SelectDialogItem>({
      items: [{ label: "a" }, { label: "b" }, { label: "c" }],
      readKey,
      input,
      output: {
        isTTY: false,
        write(chunk: string) {
          writes.push(chunk);
          return true;
        },
      } as unknown as NodeJS.WritableStream,
    });

    // Wheel-down moves highlight from item 0 to item 1.
    input.emit("data", "\x1b[<65;3;3M");
    await new Promise((r) => setTimeout(r, 10));
    expect(writes.join("")).toContain("❯ b");
    // Wheel-up moves it back to item 0.
    writes.length = 0;
    input.emit("data", "\x1b[<64;3;3M");
    await new Promise((r) => setTimeout(r, 10));
    expect(writes.join("")).toContain("❯ a");

    input.emit("data", "\r");
    const result = await resultPromise;
    expect(result).toEqual({
      kind: "selected",
      index: 0,
      item: { label: "a" },
    });
  });

  test("a bare Escape still cancels", async () => {
    // A lone ESC with no continuation arriving within the 30ms bounded wait
    // is a genuine bare Escape — the reader's esc timer fires and delivers
    // it as the cancel key. The split-arrival test below covers the other
    // direction (ESC is a sequence prefix, not a cancel).
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const resultPromise = runSelectDialog<SelectDialogItem>({
      items: [{ label: "a" }],
      readKey,
      input,
      output: { isTTY: false, write() {} } as unknown as NodeJS.WritableStream,
    });

    input.emit("data", "\x1b");
    const result = await resultPromise;
    expect(result).toEqual({ kind: "cancelled" });
  });

  test("a split SGR wheel report does not cancel (ESC arrives alone, rest follows)", async () => {
    // Regression for the original bug's worst real-world shape: ConPTY /
    // SSH / multiplexers can deliver a wheel report split so the lone ESC
    // lands in one `data` chunk and the rest (`[<65;1;1M`) in the next. The
    // reader must NOT hand the lone ESC to the cancel branch immediately —
    // it waits, the continuation arrives, the whole SGR report is
    // reassembled, and parseScrollAction moves the highlight. Emit the two
    // halves through the SAME reader instance to prove no lone-ESC cancel
    // leaks out between them.
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const writes: string[] = [];
    const resultPromise = runSelectDialog<SelectDialogItem>({
      items: [{ label: "a" }, { label: "b" }],
      readKey,
      input,
      output: {
        isTTY: false,
        write(chunk: string) {
          writes.push(chunk);
          return true;
        },
      } as unknown as NodeJS.WritableStream,
    });

    // chunk1: just the ESC byte. Must not cancel — give it well under the
    // 30ms esc timeout so the continuation can still arrive in-window.
    input.emit("data", "\x1b");
    await new Promise((r) => setTimeout(r, 5));
    // Dialog still open (no cancel) — prove by checking the frame is painted
    // and no resolve yet would be observable via a follow-up that succeeds.
    // chunk2: the rest of the SGR wheel-down report.
    input.emit("data", "[<65;1;1M");
    await new Promise((r) => setTimeout(r, 10));
    // The wheel-down moved highlight to item 1, not a cancel.
    expect(writes.join("")).toContain("❯ b");

    input.emit("data", "\r");
    const result = await resultPromise;
    expect(result).toEqual({
      kind: "selected",
      index: 1,
      item: { label: "b" },
    });
  });

  test("a non-wheel SGR mouse report (click) does not cancel or move", async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const writes: string[] = [];
    const resultPromise = runSelectDialog<SelectDialogItem>({
      items: [{ label: "a" }, { label: "b" }],
      readKey,
      input,
      output: {
        isTTY: false,
        write(chunk: string) {
          writes.push(chunk);
          return true;
        },
      } as unknown as NodeJS.WritableStream,
    });

    // A plain left-click report, emitted whole (real raw-mode delivery). It
    // must be swallowed — not a cancel, not a scroll, not a highlight move.
    input.emit("data", "\x1b[<0;1;1M");
    await new Promise((r) => setTimeout(r, 10));
    const afterClick = writes.join("");
    expect(afterClick).toContain("❯ a");
    expect(afterClick).not.toContain("❯ b");

    input.emit("data", "\r");
    const result = await resultPromise;
    expect(result).toEqual({
      kind: "selected",
      index: 0,
      item: { label: "a" },
    });
  });
});