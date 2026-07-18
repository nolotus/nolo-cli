import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";
import { themeColorSequence, resolveTuiBrightness, type TuiBrightness } from "../tui/theme";

export type RenderDisplayMode = "plain" | "rich";

// ANSI style codes that don't depend on color (bold, dim, reset).
const STYLE = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

/**
 * Color SGR sequences resolved from the TUI theme. assistantOutput is used both
 * inside the TUI (where theme brightness is known) and in one-shot CLI output
 * (where we fall back to default brightness). The brightness is resolved once
 * per call chain so a single assistant reply stays internally consistent.
 */
function colorSeq(token: "accent" | "chrome" | "info" | "muted", brightness: TuiBrightness) {
  return themeColorSequence(token, process.env, brightness);
}

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

// ─── List rendering ─────────────────────────────────────────────────────────
// Normalize markdown list markers so bullet style stays consistent and
// indentation is preserved across levels. We keep the original leading
// whitespace as the indentation (it's what AI models produce), and only
// swap the marker.
//   "- item"   / "* item"  / "+ item"  →  "• item"
//   "1. item" / "2. item"             →  "1. item"  (keep number)
//   "- [ ] item"                      →  "☐ item"
//   "- [x] item"                      →  "☑ item"
// Nested lists keep their leading spaces, so multi-level structure is visible.
const UNORDERED_LIST_RE = /^(\s*)([-*+])\s+(.+)$/;
const ORDERED_LIST_RE = /^(\s*)(\d+)\.\s+(.+)$/;
const TASK_LIST_RE = /^(\s*)([-*+])\s+\[([ xX])\]\s+(.+)$/;

function normalizeListLine(line: string): string {
  // Task list: "- [ ] item" / "- [x] item" → "☐ item" / "☑ item"
  const task = line.match(TASK_LIST_RE);
  if (task) {
    const checked = task[3] === "x" || task[3] === "X";
    return `${task[1]}${checked ? "☑" : "☐"} ${task[4]}`;
  }
  const unordered = line.match(UNORDERED_LIST_RE);
  if (unordered) {
    return `${unordered[1]}• ${unordered[3]}`;
  }
  // Ordered list: keep the number but ensure consistent ". " spacing.
  const ordered = line.match(ORDERED_LIST_RE);
  if (ordered) {
    return `${ordered[1]}${ordered[2]}. ${ordered[3]}`;
  }
  return line;
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
    out.push(normalizeListLine(line));
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

/**
 * Render a markdown link `[text](url)` as a clickable OSC 8 hyperlink.
 * Terminals that support OSC 8 (iTerm2, Ghostty, WezTerm, Kitty, Windows
 * Terminal, etc.) let the user Ctrl/Cmd-Click to open the URL. Unsupported
 * terminals ignore the escape sequences and see plain "text (url)".
 *
 * We always emit the visible fallback "text (url)" inside the hyperlink so
 * the URL is readable even when OSC 8 is not available — the link layer is
 * purely additive.
 */
function renderMarkdownLink(match: string, text: string, url: string): string {
  const visible = `${text} (${url})`;
  // OSC 8: ESC ] 8 ; params URI ST  text  ESC ] 8 ; ; ST
  // ST (string terminator) is ESC \ — most terminals also accept BEL (\a).
  return `\x1b]8;;${url}\x1b\\${visible}\x1b]8;;\x1b\\`;
}

const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;

function styleInlineMarkdown(line: string, mode: RenderDisplayMode, brightness: TuiBrightness) {
  if (mode === "plain") return line;
  const info = colorSeq("info", brightness);
  const reset = STYLE.reset;
  const bold = STYLE.bold;
  return line
    .replace(MARKDOWN_LINK_RE, (m, t, u) => renderMarkdownLink(m, t, u))
    .replace(/`([^`]+)`/g, `${info}$1${reset}`)
    .replace(/\*\*(.+?)\*\*/g, `${bold}$1${reset}`);
}

function styleRichMarkdownLine(line: string, brightness: TuiBrightness) {
  const heading = line.match(/^(#{1,3})\s+(.+)$/);
  if (heading) {
    const level = heading[1].length;
    const title = heading[2];
    if (level <= 2) return `${STYLE.bold}${title}${STYLE.reset}`;
    return `${colorSeq("info", brightness)}${title}${STYLE.reset}`;
  }
  if (/^---+$/.test(line.trim())) {
    return `${STYLE.dim}${line}${STYLE.reset}`;
  }
  return styleInlineMarkdown(line, "rich", brightness);
}

export function formatAssistantDisplay(
  text: string,
  mode: RenderDisplayMode = "rich",
  options: { trimEdges?: boolean } = {}
) {
  const brightness = resolveTuiBrightness();
  const polished = polishAssistantStructure(text, options);
  let inFence = false;
  return polished
    .split("\n")
    .map((line) => {
      if (isCodeFenceLine(line)) {
        inFence = !inFence;
        return mode === "plain" ? line : `${STYLE.dim}${line}${STYLE.reset}`;
      }
      if (inFence) return line;
      if (mode === "plain") return styleInlineMarkdown(line, "plain", brightness);
      return styleRichMarkdownLine(line, brightness);
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
  const brightness = resolveTuiBrightness();
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
        args.write(`${STYLE.dim}${firstLine}${STYLE.reset}\n`);
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