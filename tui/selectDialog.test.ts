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

    expect(output).toContain("> MiniMax M3  custom");
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
    expect(output).toContain("... 7 more above");
    expect(output).toContain("> agent-11");
    expect(output).not.toContain("agent-1\n");
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
      output: { isTTY: false, write() {} } as NodeJS.WritableStream,
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
      output: { isTTY: false, write() {} } as NodeJS.WritableStream,
    });

    expect(result).toEqual({ kind: "cancelled" });
  });
});