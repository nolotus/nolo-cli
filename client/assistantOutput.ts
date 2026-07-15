import { asTrimmedLowercaseString } from "../core/trimmedLowercaseString";

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

export function convertMarkdownTablesForTerminal(text: string) {
  const lines = text.split("\n");
  const out: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const next = lines[index + 1] ?? "";
    if (isTableRow(line) && isTableSeparator(next)) {
      const headers = splitTableCells(line);
      index += 1;
      while (index + 1 < lines.length && isTableRow(lines[index + 1] ?? "") && !isTableSeparator(lines[index + 1] ?? "")) {
        index += 1;
        const row = splitTableCells(lines[index] ?? "");
        const label = row[0] ?? "";
        const detail = row.slice(1).join(" — ").trim();
        out.push(detail ? `  • ${label} — ${detail}` : `  • ${label}`);
      }
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    out.push(line);
  }

  return out.join("\n");
}

export function polishAssistantStructure(text: string) {
  return convertMarkdownTablesForTerminal(text)
    .replace(/\r\n/g, "\n")
    .replace(/([^\n])\n(#{1,3} )/g, "$1\n\n$2")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function styleInlineMarkdown(line: string, mode: RenderDisplayMode) {
  if (mode === "plain") return line;
  return line.replace(/\*\*(.+?)\*\*/g, `${ANSI.bold}$1${ANSI.reset}`);
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

export function formatAssistantDisplay(text: string, mode: RenderDisplayMode = "rich") {
  const polished = polishAssistantStructure(text);
  if (mode === "plain") {
    return polished
      .split("\n")
      .map((line) => styleInlineMarkdown(line, "plain"))
      .join("\n");
  }
  return polished
    .split("\n")
    .map((line) => styleRichMarkdownLine(line))
    .join("\n");
}

function emitFormattedAssistantBlock(
  write: (chunk: string) => void,
  text: string,
  renderMode: RenderDisplayMode,
  trailingNewline = false
) {
  if (!text) return;
  write(formatAssistantDisplay(text, renderMode));
  if (trailingNewline) write("\n");
}

export function createRenderAwareStreamWriter(args: {
  write: (chunk: string) => void;
  renderMode: RenderDisplayMode;
}) {
  let buffer = "";

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

      if (isTableRow(lines[0] ?? "") && isTableSeparator(lines[1] ?? "")) {
        let end = 2;
        while (
          end < lines.length &&
          isTableRow(lines[end] ?? "") &&
          !isTableSeparator(lines[end] ?? "")
        ) {
          end += 1;
        }
        const tableComplete = end < lines.length || buffer.endsWith("\n");
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

      emitFormattedAssistantBlock(args.write, lines[0] ?? "", args.renderMode, true);
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
      } else {
        emitFormattedAssistantBlock(args.write, buffer, args.renderMode);
      }
      buffer = "";
    },
  };
}