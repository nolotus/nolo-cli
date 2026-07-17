import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";

export type RenderDisplayMode = "plain" | "rich";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
};

export function normalizeRenderDisplayMode(
  raw: string | undefined,
  fallback: RenderDisplayMode = "rich"
): RenderDisplayMode {
  const normalized = asTrimmedLowercaseString(raw);
  if (normalized === "plain" || normalized === "raw" || normalized === "off" || normalized === "0") {
    return "plain";
  }
  if (normalized === "rich" || normalized === "on" || normalized === "1" || normalized === "styled") {
    return "rich";
  }
  return fallback;
}

export function resolveRenderDisplayMode(env: Record<string, string | undefined> = process.env) {
  return normalizeRenderDisplayMode(env.NOLO_CLI_RENDER ?? env.NOLO_RENDER, "rich");
}

function splitTableCells(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  const core = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return core.split("|").map((cell) => cell.trim()).filter(Boolean);
}

function isTableSeparator(line: string) {
  const cells = splitTableCells(line);
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}

function isTableRow(line: string) {
  const cells = splitTableCells(line);
  return cells.length >= 2 && cells.some((cell) => cell.length > 0);
}

/** `| a | b |` shaped line (pipe-wrapped, at least two cells). */
function isPipeWrappedTableRow(line: string) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("|") &&
    trimmed.endsWith("|") &&
    isTableRow(line)
  );
}

function isCodeFenceLine(line: string) {
  return /^\s*```/.test(line);
}

function tableRowToBullet(line: string) {
  const row = splitTableCells(line);
  const label = row[0] ?? "";
  const detail = row.slice(1).join(" — ").trim();
  return detail ? `  • ${label} — ${detail}` : `  • ${label}`;
}

export function convertMarkdownTablesForTerminal(text: string) {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isCodeFenceLine(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    const next = lines[index + 1] ?? "";
    if (isTableRow(line) && isTableSeparator(next)) {
      index += 1;
      while (index + 1 < lines.length && isTableRow(lines[index + 1] ?? "") && !isTableSeparator(lines[index + 1] ?? "")) {
        index += 1;
        out.push(tableRowToBullet(lines[index] ?? ""));
      }
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    // Orphan table fragments: streamed tables can leak a header-less row or a
    // separator on its own line, which used to render as raw `| … | … |`.
    if (isPipeWrappedTableRow(line)) {
      if (!isTableSeparator(line)) out.push(tableRowToBullet(line));
      continue;
    }
    out.push(line);
  }

  return out.join("\n");
}

export function polishAssistantStructure(
  text: string,
  options: { trimEdges?: boolean } = {}
) {
  const polished = convertMarkdownTablesForTerminal(text)
    .replace(/\r\n/g, "\n")
    .replace(/([^\n])\n(#{1,3} )/g, "$1\n\n$2")
    .replace(/\n{4,}/g, "\n\n\n");
  // Streamed per-line blocks must keep their indentation (bullets, list items);
  // only whole-message formatting trims outer whitespace.
  return options.trimEdges === false ? polished : polished.trim();
}

function styleInlineMarkdown(line: string, mode: RenderDisplayMode) {
  if (mode === "plain") return line;
  return line
    .replace(/`([^`]+)`/g, `${ANSI.cyan}$1${ANSI.reset}`)
    .replace(/\*\*(.+?)\*\*/g, `${ANSI.bold}$1${ANSI.reset}`);
}

function styleRichMarkdownLine(line: string) {
  const heading = line.match(/^(#{1,3})\s+(.+)$/);
  if (heading) {
    const level = heading[1].length;
    const title = heading[2];
    if (level <= 2) return `${ANSI.bold}${title}${ANSI.reset}`;
    return `${ANSI.cyan}${title}${ANSI.reset}`;
  }
  if (/^---+$/.test(line.trim())) {
    return `${ANSI.dim}${line}${ANSI.reset}`;
  }
  return styleInlineMarkdown(line, "rich");
}

export function formatAssistantDisplay(
  text: string,
  mode: RenderDisplayMode = "rich",
  options: { trimEdges?: boolean } = {}
) {
  const polished = polishAssistantStructure(text, options);
  let inFence = false;
  return polished
    .split("\n")
    .map((line) => {
      if (isCodeFenceLine(line)) {
        inFence = !inFence;
        return mode === "plain" ? line : `${ANSI.dim}${line}${ANSI.reset}`;
      }
      if (inFence) return line;
      if (mode === "plain") return styleInlineMarkdown(line, "plain");
      return styleRichMarkdownLine(line);
    })
    .join("\n");
}

function emitFormattedAssistantBlock(
  write: (chunk: string) => void,
  text: string,
  renderMode: RenderDisplayMode,
  trailingNewline = false
) {
  if (!text) return;
  write(formatAssistantDisplay(text, renderMode, { trimEdges: false }));
  if (trailingNewline) write("\n");
}

export function createRenderAwareStreamWriter(args: {
  write: (chunk: string) => void;
  renderMode: RenderDisplayMode;
}) {
  let buffer = "";
  let inFence = false;

  const flushCompleteBlocks = () => {
    if (args.renderMode === "plain") {
      if (!buffer) return;
      args.write(buffer);
      buffer = "";
      return;
    }

    while (buffer.includes("\n")) {
      const lines = buffer.split("\n");
      if (lines.length < 2) break;
      const firstLine = lines[0] ?? "";

      if (isCodeFenceLine(firstLine)) {
        inFence = !inFence;
        args.write(`${ANSI.dim}${firstLine}${ANSI.reset}\n`);
        buffer = lines.slice(1).join("\n");
        continue;
      }
      if (inFence) {
        // Code lines pass through untouched: no trim, no table conversion.
        args.write(`${firstLine}\n`);
        buffer = lines.slice(1).join("\n");
        continue;
      }

      if (isTableRow(firstLine)) {
        // The line after the first row decides between a real table (separator
        // next) and an orphan row. Wait until that line is complete instead of
        // leaking the header as raw `| … |` text.
        const nextLineComplete = lines.length > 2;
        if (!nextLineComplete) break;

        if (isTableSeparator(lines[1] ?? "")) {
          let end = 2;
          while (
            end < lines.length &&
            isTableRow(lines[end] ?? "") &&
            !isTableSeparator(lines[end] ?? "")
          ) {
            end += 1;
          }
          const tableComplete = end < lines.length - 1;
          if (!tableComplete) break;

          emitFormattedAssistantBlock(
            args.write,
            lines.slice(0, end).join("\n"),
            args.renderMode,
            true
          );
          buffer = lines.slice(end).join("\n");
          continue;
        }
      }

      emitFormattedAssistantBlock(args.write, firstLine, args.renderMode, true);
      buffer = lines.slice(1).join("\n");
    }
  };

  return {
    push(chunk: string) {
      if (!chunk) return;
      if (args.renderMode === "plain") {
        args.write(chunk);
        return;
      }
      buffer += chunk;
      flushCompleteBlocks();
    },
    flush() {
      if (!buffer) return;
      if (args.renderMode === "plain") {
        args.write(buffer);
      } else if (inFence) {
        args.write(buffer);
      } else {
        emitFormattedAssistantBlock(args.write, buffer, args.renderMode);
      }
      buffer = "";
    },
  };
}