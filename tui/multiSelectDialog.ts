import { MultiSelectPrompt, isCancel } from "@clack/core";
import { computeVisibleWindow } from "./selectDialog";

/**
 * Multi-select picker built on @clack/core's MultiSelectPrompt state machine.
 *
 * clack owns the keyboard layer (raw-mode keypress parsing, cursor movement,
 * Space toggle, `a` select-all / `i` invert, Esc/Ctrl+C cancel); we own the
 * frame layout so the look matches selectDialog/agentPicker. Rendering is
 * sequential (clack diffs frames in place at the cursor position) — callers
 * inside the docked TUI should pause the composer first, same as selectDialog.
 */
export type MultiSelectDialogItem<TValue> = {
  label: string;
  value: TValue;
  detail?: string;
  /** Pre-checked when the dialog opens. */
  selected?: boolean;
};

export type MultiSelectDialogResult<TValue> =
  | { kind: "submitted"; values: TValue[] }
  | { kind: "cancelled" };

export function renderMultiSelectFrame<TValue>(args: {
  items: MultiSelectDialogItem<TValue>[];
  cursor: number;
  selectedValues: TValue[];
  title?: string;
  maxVisible?: number;
  error?: string;
}): string {
  const total = args.items.length;
  const window = computeVisibleWindow({
    selectedIndex: args.cursor,
    total,
    maxVisible: args.maxVisible,
  });
  const lines = [
    args.title ??
      `Select (↑↓ Space toggle · Enter submit · Esc cancel)  ${args.selectedValues.length}/${total} selected`,
  ];
  if (window.start > 0) {
    lines.push(`  ... ${window.start} more above`);
  }
  for (let index = window.start; index < window.end; index += 1) {
    const item = args.items[index];
    const cursorMarker = index === args.cursor ? ">" : " ";
    const checked = args.selectedValues.includes(item.value) ? "◉" : "○";
    const detail = item.detail ? `  ${item.detail}` : "";
    lines.push(`${cursorMarker} ${checked} ${item.label}${detail}`);
  }
  if (window.end < total) {
    lines.push(`  ... ${total - window.end} more below`);
  }
  if (args.error) {
    lines.push(`  ! ${args.error}`);
  }
  return lines.join("\n");
}

export async function runMultiSelectDialog<TValue>(args: {
  items: MultiSelectDialogItem<TValue>[];
  title?: string;
  maxVisible?: number;
  /** Require at least one checked item before Enter submits. */
  required?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<MultiSelectDialogResult<TValue>> {
  const items = args.items;
  if (items.length === 0) {
    return { kind: "cancelled" };
  }

  const prompt = new MultiSelectPrompt<MultiSelectDialogItem<TValue>>({
    options: items,
    initialValues: items
      .filter((item) => item.selected)
      .map((item) => item.value),
    required: args.required ?? false,
    input: (args.input ?? process.stdin) as any,
    output: (args.output ?? process.stdout) as any,
    render() {
      // Final frame: collapse to nothing so the transcript stays clean; the
      // caller reports the outcome through its own output path.
      if (this.state === "submit" || this.state === "cancel") return "";
      return renderMultiSelectFrame({
        items,
        cursor: this.cursor,
        selectedValues: this.value ?? [],
        title: args.title,
        maxVisible: args.maxVisible,
        error: this.state === "error" ? this.error : undefined,
      });
    },
  });

  const result = await prompt.prompt();
  if (isCancel(result) || result === undefined) {
    return { kind: "cancelled" };
  }
  return { kind: "submitted", values: result as TValue[] };
}
