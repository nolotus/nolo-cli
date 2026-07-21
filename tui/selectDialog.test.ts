import { describe, expect, test } from "bun:test";

import {
  renderSelectDialog,
  runSelectDialog,
  type SelectDialogItem,
} from "./selectDialog";

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
});