export type SelectDialogItem = {
  label: string;
  detail?: string;
};

export type SelectDialogResult<T extends SelectDialogItem> =
  | { kind: "selected"; index: number; item: T }
  | { kind: "cancelled" };

export type KeyReader = () => Promise<string | null>;

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
  maxVisible?: number;
}) {
  const total = args.items.length;
  const window = computeVisibleWindow({
    selectedIndex: args.selectedIndex,
    total,
    maxVisible: args.maxVisible,
  });
  const lines = [
    args.title ??
      `Select agent (↑↓ Enter Esc)  ${args.selectedIndex + 1}/${total}`,
  ];

  if (window.start > 0) {
    lines.push(`  ... ${window.start} more above`);
  }

  for (let index = window.start; index < window.end; index += 1) {
    const item = args.items[index];
    const marker = index === args.selectedIndex ? ">" : " ";
    const detail = item.detail ? `  ${item.detail}` : "";
    lines.push(`${marker} ${item.label}${detail}`);
  }

  if (window.end < total) {
    lines.push(`  ... ${total - window.end} more below`);
  }

  return lines.join("\n");
}

function countRenderedLines(text: string) {
  return text.split("\n").length;
}

function clearRenderedLines(output: NodeJS.WritableStream, lineCount: number) {
  if (!(output as any).isTTY || lineCount <= 0) return;
  for (let index = 0; index < lineCount; index += 1) {
    output.write("\x1b[1A\x1b[2K");
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

  return () =>
    new Promise((resolve) => {
      const finalize = (sequence: string | null | undefined) => {
        cleanup();
        resolve(sequence ?? null);
      };

      const onReadable = () => {
        while (true) {
          const chunk = input.read();
          if (chunk == null) break;
          buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          const parsed = tryParseSequence();
          if (parsed === undefined) return;
          finalize(parsed);
          return;
        }
      };

      const cleanup = () => {
        input.off("readable", onReadable);
      };

      onReadable();
      if (buffer) {
        const parsed = tryParseSequence();
        if (parsed !== undefined) {
          finalize(parsed);
          return;
        }
      }
      input.on("readable", onReadable);
    });
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
  maxVisible?: number;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WritableStream;
  readKey?: KeyReader;
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
  const wasPaused = typeof input.isPaused === "function" ? input.isPaused() : false;
  let renderedLineCount = 0;

  const paint = () => {
    const frame = renderSelectDialog({
      items,
      selectedIndex,
      title: args.title,
      maxVisible: args.maxVisible,
    });
    if ((output as any).isTTY && typeof output.write === "function") {
      clearRenderedLines(output, renderedLineCount);
      output.write(`${frame}\n`);
      renderedLineCount = countRenderedLines(frame);
      return;
    }
    if (typeof output.write === "function") {
      output.write(`${frame}\n`);
    }
    renderedLineCount = countRenderedLines(frame);
  };

  if (input.isTTY) {
    if (!wasRaw) input.setRawMode(true);
    if (!wasPaused) input.pause();
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
    if (input.isTTY) {
      drainInputBuffer(input);
      if (!wasRaw) input.setRawMode(false);
      if (!wasPaused) input.resume();
      clearRenderedLines(output, renderedLineCount);
      renderedLineCount = 0;
    }
  }
}