import { describe, expect, test } from "bun:test";
import {
  DIALOG_CHECKED,
  DIALOG_UNCHECKED,
  renderDialogError,
  renderDialogOverflow,
  renderDialogRow,
  renderDialogTitle,
} from "./dialogFrame";
import { renderSelectDialog } from "./selectDialog";
import { renderMultiSelectFrame } from "./multiSelectDialog";

describe("dialog frame primitives", () => {
  test("plain text is unchanged when color is disabled", () => {
    expect(renderDialogRow({ label: "alpha", focused: false }, false)).toBe(
      "  alpha",
    );
    expect(renderDialogRow({ label: "alpha", focused: true }, false)).toBe(
      "> alpha",
    );
    expect(
      renderDialogRow({ label: "alpha", detail: "the one", focused: false }, false),
    ).toBe("  alpha  the one");
    expect(renderDialogOverflow("... 3 more above", false)).toBe(
      "  ... 3 more above",
    );
    expect(renderDialogError("pick at least one", false)).toBe(
      "  ! pick at least one",
    );
    expect(renderDialogTitle("Select", false)).toBe("Select");
  });

  test("focused row and detail carry distinct colors when enabled", () => {
    const row = renderDialogRow(
      { label: "alpha", detail: "the one", focused: true },
      true,
    );
    // Focused label and muted detail must not collapse to the same sequence,
    // otherwise the cursor is only findable via the `>` glyph.
    const labelColor = row.slice(row.indexOf("alpha") - 20, row.indexOf("alpha"));
    const detailColor = row.slice(
      row.indexOf("the one") - 20,
      row.indexOf("the one"),
    );
    expect(labelColor).not.toBe(detailColor);
    expect(row).toContain("\x1b[");
  });

  test("multi-select uses the shared checkbox glyphs", () => {
    const frame = renderMultiSelectFrame({
      items: [
        { label: "alpha", value: "a" },
        { label: "beta", value: "b" },
      ],
      cursor: 0,
      selectedValues: ["a"],
      title: "Pick",
    });
    expect(frame).toContain(`${DIALOG_CHECKED} alpha`);
    expect(frame).toContain(`${DIALOG_UNCHECKED} beta`);
  });

  test("single and multi select share row layout for the focused item", () => {
    // Both renderers route through renderDialogRow, so the cursor column and
    // label spacing stay identical; they used to be hand-assembled separately.
    const single = renderSelectDialog({
      items: [{ label: "alpha" }],
      selectedIndex: 0,
      title: "Pick",
    });
    const multi = renderMultiSelectFrame({
      items: [{ label: "alpha", value: "a" }],
      cursor: 0,
      selectedValues: [],
      title: "Pick",
    });
    expect(single).toContain("> alpha");
    expect(multi).toContain(`> ${DIALOG_UNCHECKED} alpha`);
  });
});
