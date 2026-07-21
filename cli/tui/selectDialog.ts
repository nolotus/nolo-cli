import {
  renderDialogOverflow,
  renderDialogRow,
  renderDialogTitle,
} from "./dialogFrame";
import { t } from "./i18n";

export type SelectDialogItem = {
  label: string;
  detail?: string;
};

export type SelectDialogResult<T extends SelectDialogItem> =
  | { kind: "selected"; index: number; item: T }
  | { kind: "cancelled" };

export type KeyReader = (() => Promise<string | null>) & {
  /** Detach any stream listeners the reader installed. */
  dispose?: () => void;
};

const CSI_ARROW_UP = "\x1b[A";
const CSI_ARROW_DOWN = "\x1b[B";
const CSI_ARROW_UP_APP = "\x1bOA";
const CSI_ARROW_DOWN_APP = "\x1bOB";
const DEFAULT_MAX_VISIBLE = 8;

export function computeVisibleWindow(args: {
  selectedIndex: number;
  total: number;
  maxVisible?: number;
}) {
  const maxVisible = Math.max(1, args.maxVisible ?? DEFAULT_MAX_VISIBLE);
  if (args.total <= maxVisible) {
    return { start: 0, end: args.total, maxVisible };
  }
  let start = Math.max(0, args.selectedIndex - Math.floor(maxVisible / 2));
  if (start + maxVisible > args.total) {
    start = args.total - maxVisible;
  }
  return { start, end: start + maxVisible, maxVisible };
}

export function renderSelectDialog<T extends SelectDialogItem>(args: {
  items: T[];
  selectedIndex: number;
  title?: string;
  /**
   * Pre-rendered title lines (already styled via dialogFrame primitives).
   * When provided, they replace the single `title` line verbatim — used by
   * confirmDialog to embed a separately-colored command line that
   * `renderDialogTitle` (which wraps the whole string in one color) cannot
   * produce. Plain when color is disabled, so non-TTY/NO_COLOR output stays
   * ANSI-free.
   */
  titleLines?: string[];
  maxVisible?: number;
}) {
  const total = args.items.length;
  const window = computeVisibleWindow({
    selectedIndex: args.selectedIndex,
    total,
    maxVisible: args.maxVisible,
  });
  const titleLines =
    args.titleLines ??
    [
      renderDialogTitle(
        args.title ??
          `${t("dialogSelectLabel")}  ${t("dialogSelectHint")}  ${args.selectedIndex + 1}/${total}`,
      ),
    ];
  // Blank line between the title block and the list gives the frame some
  // breathing room; it counts as an anchored row like any other.
  const lines = [...titleLines, ""];

  if (window.start > 0) {
    lines.push(renderDialogOverflow(`↑ ${window.start} more`));
  }

  for (let index = window.start; index < window.end; index += 1) {
    const item = args.items[index];
    lines.push(
      renderDialogRow({
        label: item.label,
        ...(item.detail ? { detail: item.detail } : {}),
        focused: index === args.selectedIndex,
      }),
    );
  }

  if (window.end < total) {
    lines.push("", renderDialogOverflow(`↓ ${total - window.end} more`));
  }

  return lines.join("\n");
}

function outputIsTty(output: NodeJS.WritableStream): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    "isTTY" in output &&
    Boolean(output.isTTY)
  );
}

function clearRenderedLines(output: NodeJS.WritableStream, lineCount: number) {
  if (!outputIsTty(output) || lineCount <= 0) return;
  for (let index = 0; index < lineCount; index += 1) {
    output.write("\x1b[1A\x1b[2K");
  }
}
function clearAnchoredLines(
  output: NodeJS.WritableStream,
  bottomRow: number,
  lineCount: number
) {
  if (!outputIsTty(output) || lineCount <= 0) return;
  for (let index = 0; index < lineCount; index += 1) {
    const row = bottomRow - index;
    if (row < 1) break;
    output.write(`\x1b[${row};1H\x1b[2K`);
  }
}

function isArrowUp(sequence: string) {
  return sequence === CSI_ARROW_UP || sequence === CSI_ARROW_UP_APP;
}

function isArrowDown(sequence: string) {
  return sequence === CSI_ARROW_DOWN || sequence === CSI_ARROW_DOWN_APP;
}

function isSubmit(sequence: string) {
  return sequence === "\r" || sequence === "\n";
}

function isCancel(sequence: string) {
  return sequence === "\u0003" || sequence === "\u001b";
}

export function createRawKeyReader(input: NodeJS.ReadStream): KeyReader {
  let buffer = "";

  const tryParseSequence = () => {
    if (!buffer) return null;
    if (isSubmit(buffer) || isCancel(buffer)) {
      const sequence = buffer;
      buffer = "";
      return sequence;
    }
    if (buffer.startsWith("\x1b")) {
      for (const candidate of [
        CSI_ARROW_UP,
        CSI_ARROW_DOWN,
        CSI_ARROW_UP_APP,
        CSI_ARROW_DOWN_APP,
      ]) {
        if (buffer.startsWith(candidate)) {
          buffer = buffer.slice(candidate.length);
          return candidate;
        }
      }
      if (buffer.length >= 8) {
        buffer = "";
        return null;
      }
      return undefined;
    }
    const sequence = buffer;
    buffer = "";
    return sequence;
  };

  // Deliver keys via 'data' events. The TUI workspace drives stdin in flowing
  // mode with 'data' listeners; mixing in 'readable'/read() here left the
  // dialog deaf to every keypress under Bun (the 'readable' event never fires
  // once the stream has been flowing), so /agent showed a picker that ignored
  // arrows and Enter. A persistent 'data' listener uses the same delivery
  // path as the rest of the TUI and never drops bytes between reads.
  let waiter: ((sequence: string | null) => void) | null = null;

  const tryDeliver = () => {
    if (!waiter || !buffer) return;
    const parsed = tryParseSequence();
    if (parsed === undefined) return;
    const resolve = waiter;
    waiter = null;
    resolve(parsed);
  };

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    tryDeliver();
  };
  input.on("data", onData);
  input.resume?.();

  const reader: KeyReader = () =>
    new Promise((resolve) => {
      waiter = resolve;
      tryDeliver();
    });
  reader.dispose = () => {
    waiter = null;
    input.off("data", onData);
  };
  return reader;
}

export function drainInputBuffer(input: NodeJS.ReadStream) {
  if (typeof input.read !== "function") return;
  while (input.read() !== null) {
    // drain stale escape sequences after raw-mode picker
  }
}

export async function runSelectDialog<T extends SelectDialogItem>(args: {
  items: T[];
  initialIndex?: number;
  title?: string;
  /** See renderSelectDialog.titleLines. */
  titleLines?: string[];
  maxVisible?: number;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WritableStream;
  readKey?: KeyReader;
  /**
   * Dock the list above the composer instead of letting it scroll to the top
   * of the terminal. When true, `bottomRow` (1-indexed absolute cursor row)
   * is the row the last line of the frame sits on; the rest stack upward.
   * Pass a function to resolve the row lazily on every paint — the TUI uses
   * this so the dialog re-anchors itself above the composer after a terminal
   * resize instead of staying frozen at the rows captured when it opened.
   */
  bottomAnchored?: boolean;
  bottomRow?: number | (() => number);
}): Promise<SelectDialogResult<T>> {
  const items = args.items;
  if (items.length === 0) {
    return { kind: "cancelled" };
  }

  let selectedIndex = Math.min(
    Math.max(args.initialIndex ?? 0, 0),
    items.length - 1
  );
  const output = args.output ?? process.stdout;
  const input = args.input ?? process.stdin;
  const readKey = args.readKey ?? createRawKeyReader(input);

  const wasRaw = Boolean(input.isTTY && input.isRaw);
  let renderedLineCount = 0;
  const bottomAnchored = Boolean(args.bottomAnchored && args.bottomRow);
  const resolveBottomRow = () =>
    Math.max(
      1,
      typeof args.bottomRow === "function" ? args.bottomRow() : args.bottomRow ?? 0
    );
  // Anchor of the last actual paint, tracked separately from resolveBottomRow()
  // so a resize moves the frame: clear where it WAS, repaint where it IS.
  let lastBottomRow = 0;

  const paint = () => {
    const frame = renderSelectDialog({
      items,
      selectedIndex,
      title: args.title,
      ...(args.titleLines ? { titleLines: args.titleLines } : {}),
      maxVisible: args.maxVisible,
    });
    const lines = frame.split("\n");
    const lineCount = lines.length;
    const canPosition = outputIsTty(output) && typeof output.write === "function";

    if (bottomAnchored && canPosition) {
      const anchorRow = resolveBottomRow();
      clearAnchoredLines(
        output,
        lastBottomRow > 0 ? lastBottomRow : anchorRow,
        renderedLineCount
      );
      for (let i = 0; i < lines.length; i += 1) {
        const row = anchorRow - (lines.length - 1 - i);
        if (row < 1) break;
        output.write(`\x1b[${row};1H\x1b[2K${lines[i]}`);
      }
      lastBottomRow = anchorRow;
      renderedLineCount = lineCount;
      return;
    }

    if (canPosition) {
      clearRenderedLines(output, renderedLineCount);
      output.write(`${frame}\n`);
      renderedLineCount = lineCount;
      return;
    }

    if (typeof output.write === "function") {
      output.write(`${frame}\n`);
    }
    renderedLineCount = lineCount;
  };

  // While anchored, the dialog owns its rows — re-paint on terminal resize so
  // the frame follows the composer to its new position. The workspace's own
  // resize handler skips repainting while a dialog is up (composer paused), so
  // this listener is the only thing keeping the frame docked during a drag.
  const resizeTarget = output as NodeJS.WritableStream & {
    on?: (event: string, listener: () => void) => void;
    off?: (event: string, listener: () => void) => void;
  };
  const onOutputResize = () => paint();

  // Do not pause the stream here: the key reader listens via 'data' events,
  // which an explicit pause() would silence.
  if (input.isTTY && !wasRaw) {
    input.setRawMode?.(true);
  }
  if (bottomAnchored && outputIsTty(output)) {
    resizeTarget.on?.("resize", onOutputResize);
  }
  paint();

  try {
    while (true) {
      const sequence = await readKey();
      if (sequence == null) {
        return { kind: "cancelled" };
      }

      if (isCancel(sequence)) {
        return { kind: "cancelled" };
      }
      if (isSubmit(sequence)) {
        return { kind: "selected", index: selectedIndex, item: items[selectedIndex] };
      }
      if (isArrowUp(sequence)) {
        selectedIndex = selectedIndex <= 0 ? items.length - 1 : selectedIndex - 1;
        paint();
        continue;
      }
      if (isArrowDown(sequence)) {
        selectedIndex = selectedIndex >= items.length - 1 ? 0 : selectedIndex + 1;
        paint();
        continue;
      }
    }
  } finally {
    resizeTarget.off?.("resize", onOutputResize);
    readKey.dispose?.();
    if (input.isTTY) {
      drainInputBuffer(input);
      if (!wasRaw) input.setRawMode?.(false);
      if (bottomAnchored) {
        clearAnchoredLines(
          output,
          lastBottomRow > 0 ? lastBottomRow : resolveBottomRow(),
          renderedLineCount
        );
      } else {
        clearRenderedLines(output, renderedLineCount);
      }
      renderedLineCount = 0;
    }
  }
}