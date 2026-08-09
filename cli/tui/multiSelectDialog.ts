import {
  DIALOG_CHECKED,
  DIALOG_UNCHECKED,
  renderDialogError,
  renderDialogRow,
  renderDialogTitle,
  renderOverflowAbove,
  renderOverflowBelow,
} from "./dialogFrame";
import { t } from "./i18n";
import {
  computeVisibleWindow,
  createRawKeyReader,
  drainInputBuffer,
  isArrowDown,
  isArrowUp,
  isCancel,
  isSubmit,
  outputIsTty,
  clearRenderedLines,
  type KeyReader,
} from "./selectDialog";
import { SGR_MOUSE_REGEX, parseScrollAction } from "./tuiScrollbar";

/**
 * Multi-select picker.
 *
 * The keyboard layer is the same `createRawKeyReader` used by selectDialog /
 * askChoiceDialog / confirmDialog - one implementation. That reader
 * disambiguates a bare ESC from an ESC-led CSI/SGR sequence with a bounded
 * 30ms wait: a lone ESC stays pending until either a continuation byte
 * arrives (then the whole `\x1b[<...M` / arrow CSI is reassembled and handed
 * to the caller) or the timer fires with no continuation (then it is a
 * genuine bare Escape -> cancel). This is what stops a split wheel report
 * (chunk1 = `\x1b`, chunk2 = `[<64;1;1M`, as delivered by ConPTY / SSH /
 * multiplexers) from being mistaken for a bare-Escape cancel - the original
 * bug. See the reader's own comment for why `readline.emitKeypressEvents`
 * was evaluated and rejected (it shreds SGR mouse reports into stray
 * chars). This picker keeps the clack semantics callers relied on: Space
 * toggles the focused item, `a` selects all / `i` inverts, Enter submits
 * (blocked by `required` when nothing is checked), Esc / Ctrl+C cancels.
 * The wheel moves the highlight like the arrow keys (same wrap at
 * boundaries); non-wheel mouse reports are swallowed.
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
    renderDialogTitle(
      args.title ??
        `${t("dialogMultiSelectLabel")}  ${t("dialogMultiSelectHint")}  ${args.selectedValues.length}/${total} ${t("dialogMultiSelectSelected")}`,
    ),
    "",
  ];
  if (window.start > 0) {
    lines.push(renderOverflowAbove(window.start));
  }
  for (let index = window.start; index < window.end; index += 1) {
    const item = args.items[index];
    lines.push(
      renderDialogRow({
        label: item.label,
        ...(item.detail ? { detail: item.detail } : {}),
        focused: index === args.cursor,
        checkbox: args.selectedValues.includes(item.value)
          ? DIALOG_CHECKED
          : DIALOG_UNCHECKED,
      }),
    );
  }
  if (window.end < total) {
    lines.push("", renderOverflowBelow(total - window.end));
  }
  if (args.error) {
    lines.push(renderDialogError(args.error));
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
  /** Inject a custom key reader (tests); defaults to createRawKeyReader. */
  readKey?: KeyReader;
}): Promise<MultiSelectDialogResult<TValue>> {
  const items = args.items;
  if (items.length === 0) {
    return { kind: "cancelled" };
  }

  const output = args.output ?? process.stdout;
  const input = (args.input ?? process.stdin) as NodeJS.ReadStream;
  const readKey = args.readKey ?? createRawKeyReader(input);

  const wasRaw = Boolean(input.isTTY && input.isRaw);
  let renderedLineCount = 0;
  let cursor = 0;
  let selectedValues: TValue[] = items
    .filter((item) => item.selected)
    .map((item) => item.value);
  // Error banner shown under the list when Enter is pressed with `required`
  // set and nothing checked — matches the clack MultiSelectPrompt semantics
  // this dialog replaced. Cleared by the next input event so a toggle /
  // arrow / wheel dismisses it.
  let error: string | undefined;

  const paint = () => {
    const frame = renderMultiSelectFrame({
      items,
      cursor,
      selectedValues,
      title: args.title,
      maxVisible: args.maxVisible,
      ...(error ? { error } : {}),
    });
    const lines = frame.split("\n");
    const lineCount = lines.length;
    const canPosition = outputIsTty(output) && typeof output.write === "function";
    if (canPosition) {
      clearRenderedLines(output, renderedLineCount);
      output.write(`${frame}\n`);
    } else if (typeof output.write === "function") {
      output.write(`${frame}\n`);
    }
    renderedLineCount = lineCount;
  };

  // setRawMode + mouse-tracking enable + the first paint live INSIDE the try
  // so a throw here (or any failure before the loop) still hits the finally
  // that restores raw mode and disables mouse tracking. Leaving them outside
  // the try, as the previous build did, meant an exception stranded the
  // user's terminal in raw mode with mouse tracking on — the CRITICAL-2
  // finding; LOW-1 moves the enable write in here too for the same reason.
  try {
    if (input.isTTY && !wasRaw) {
      input.setRawMode?.(true);
    }
    // Re-enable SGR mouse tracking so wheel events reach the dialog. Inside
    // the try so the finally's `\x1b[?1000l\x1b[?1006l` always pairs with it.
    output.write("\x1b[?1006h\x1b[?1000h");
    paint();

    while (true) {
      const sequence = await readKey();
      if (sequence == null) {
        return { kind: "cancelled" };
      }

      // Any input at all clears a stale required-error banner before we
      // dispatch the key, so the error never lingers once the user acts.
      if (error) {
        error = undefined;
        paint();
      }

      // Mouse wheel moves the highlight like the arrow keys, including their
      // wrap-at-boundary behavior (spec: "滚轮等价于方向键上下", and existing
      // arrow keys wrap). A clamp here would diverge from ↑/↓, so we mirror
      // the arrow branches below instead of stopping at the edge.
      const scrollAction = parseScrollAction(sequence);
      if (scrollAction === "wheel-up" || scrollAction === "wheel-down") {
        cursor =
          scrollAction === "wheel-up"
            ? cursor <= 0
              ? items.length - 1
              : cursor - 1
            : cursor >= items.length - 1
              ? 0
              : cursor + 1;
        paint();
        continue;
      }

      // Any other SGR mouse report (click / drag / release) must never cancel
      // the dialog. Swallow it silently — a click into the terminal is not a
      // vote.
      if (SGR_MOUSE_REGEX.test(sequence)) {
        continue;
      }

      if (isCancel(sequence)) {
        return { kind: "cancelled" };
      }
      if (isSubmit(sequence)) {
        // `required` keeps an empty selection from submitting: Enter on a
        // multi-select with nothing checked stays open and shows the same
        // kind of in-dialog error the original clack MultiSelectPrompt did,
        // rather than returning an empty list (HIGH-1: this branch was
        // previously unconditional and the required flag was ignored).
        if (args.required && selectedValues.length === 0) {
          error = t("dialogMultiSelectRequired");
          paint();
          continue;
        }
        return { kind: "submitted", values: selectedValues };
      }
      if (isArrowUp(sequence)) {
        cursor = cursor <= 0 ? items.length - 1 : cursor - 1;
        paint();
        continue;
      }
      if (isArrowDown(sequence)) {
        cursor = cursor >= items.length - 1 ? 0 : cursor + 1;
        paint();
        continue;
      }
      if (sequence === " ") {
        const value = items[cursor].value;
        selectedValues = selectedValues.includes(value)
          ? selectedValues.filter((v) => v !== value)
          : [...selectedValues, value];
        paint();
        continue;
      }
      if (sequence === "a") {
        selectedValues =
          selectedValues.length === items.length
            ? []
            : items.map((item) => item.value);
        paint();
        continue;
      }
      if (sequence === "i") {
        selectedValues = items
          .filter((item) => !selectedValues.includes(item.value))
          .map((item) => item.value);
        paint();
        continue;
      }
    }
  } finally {
    output.write("\x1b[?1000l\x1b[?1006l");
    readKey.dispose?.();
    if (input.isTTY) {
      drainInputBuffer(input);
      if (!wasRaw) input.setRawMode?.(false);
      clearRenderedLines(output, renderedLineCount);
      renderedLineCount = 0;
    }
  }
}