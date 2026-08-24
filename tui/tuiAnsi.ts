/**
 * TUI 显示层纯函数：ANSI 处理、显示宽度、截断与换行。
 *
 * 从 readlineWorkspace.ts 抽出，全部为无副作用字符串工具，唯一外部依赖是
 * i18n 的 locale（displayWidth 对 CJK 全角引号按 locale 判宽度）。
 */
import { getCliLocale } from "./i18n";
import stringWidth from "string-width";

export const ANSI_ESCAPE_REGEX =
  /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;

// OSC 8 hyperlinks: ESC ] 8 ; ; params URI ST ... ESC ] 8 ; ; ST
// ST (string terminator) is ESC \ or BEL. Match both open and close in one
// regex so stripAnsi / visibleWidth drop them along with CSI sequences.
// eslint-disable-next-line no-control-regex
const OSC_HYPERLINK_REGEX = /\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)\x1b\]8;;(?:\x07|\x1b\\)|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text
    .replace(OSC_HYPERLINK_REGEX, "")
    .replace(ANSI_ESCAPE_REGEX, "");
}

/** SGR (color/style) sequences only: ESC [ params m. */
// eslint-disable-next-line no-control-regex
const SGR_SEQUENCE_REGEX = /^\x1b\[[0-9;]*m/;
// eslint-disable-next-line no-control-regex
const TRAILING_SGR_REGEX = /(?:\x1b\[[0-9;]*m)+$/;

/**
 * Apply a terminal-style output chunk onto a transcript buffer.
 *
 * Spinner / progress writers use `\\r` to redraw one status line in place.
 * The history stream used to append those frames as plain text, which produced
 * a wall of "working locally (Ns)" lines and left raw `\\r` artifacts that
 * broke later rows. Interpret the common control semantics instead:
 * - keep SGR color/style sequences (the transcript renderer is ANSI-aware);
 *   strip every other escape sequence (cursor moves, erase, private modes)
 * - `\\r` rewinds to the start of the current line (after the last `\\n`)
 * - `\\b` deletes one character on the current line
 * - other C0 controls (except tab/newline) are dropped
 */
export function applyTerminalOutputToText(existing: string, chunk: string): string {
  if (!chunk) return existing;

  let text = existing;
  let index = 0;
  while (index < chunk.length) {
    if (chunk[index] === "\x1b") {
      const sgr = SGR_SEQUENCE_REGEX.exec(chunk.slice(index));
      if (sgr) {
        text += sgr[0];
        index += sgr[0].length;
        continue;
      }
      // OSC 8 hyperlinks: strip entirely (not a visible style for transcript).
      const osc = chunk.slice(index).match(/^\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/);
      if (osc) {
        index += osc[0].length;
        continue;
      }
      const csi = chunk.slice(index).match(/^\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/);
      if (csi) {
        index += csi[0].length;
        continue;
      }
      index += 1;
      continue;
    }
    const ch = chunk[index];
    if (ch === "\r") {
      const lastNl = text.lastIndexOf("\n");
      text = lastNl === -1 ? "" : text.slice(0, lastNl + 1);
      index += 1;
      continue;
    }
    if (ch === "\n") {
      text += "\n";
      index += 1;
      continue;
    }
    if (ch === "\b") {
      // Delete the last visible character, keeping any trailing SGR codes.
      const trailing = TRAILING_SGR_REGEX.exec(text);
      const sgrTail = trailing ? trailing[0] : "";
      const head = sgrTail ? text.slice(0, -sgrTail.length) : text;
      if (head.length > 0 && head[head.length - 1] !== "\n") {
        text = head.slice(0, -1) + sgrTail;
      }
      index += 1;
      continue;
    }
    const code = ch.charCodeAt(0);
    if ((code < 0x20 && ch !== "\t") || code === 0x7f) {
      index += 1;
      continue;
    }
    text += ch;
    index += 1;
  }
  return text;
}

export function displayWidth(str: string): number {
  const plain = stripAnsi(str);
  let width = stringWidth(plain);

  // Preserve the small set of product-specific width choices that differ
  // from Unicode's default narrow treatment in string-width. These symbols
  // are used as TUI chrome and render double-wide in our supported terminal
  // fonts. Emoji/grapheme clustering and all standard EAW decisions stay in
  // the library instead of being reimplemented here.
  for (const { segment } of graphemeSegmenter.segment(plain)) {
    if (stringWidth(segment) !== 1) continue;
    const code = segment.codePointAt(0) ?? 0;
    const forceWideSymbol =
      (code >= 0x2600 && code <= 0x27bf && !(code >= 0x2768 && code <= 0x2775)) ||
      (code >= 0x2b00 && code <= 0x2bff) ||
      (code >= 0x1f300 && code <= 0x1faff);
    const cjkQuote =
      getCliLocale() === "zh" &&
      (code === 0x201c || code === 0x201d || code === 0x2018 || code === 0x2019);
    if (forceWideSymbol || cjkQuote) width += 1;
  }
  return width;
}

/** Visible columns after stripping ANSI (status lines, borders, chips). */
export function visibleWidth(str: string): number {
  return displayWidth(stripAnsi(str));
}

/**
 * Truncate a possibly-ANSI string to `maxWidth` visible columns.
 * Preserves CSI sequences so colors don't bleed; always ends with reset when truncated.
 */
export function truncateAnsi(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  let width = 0;
  let out = "";
  let i = 0;
  let sawAnsi = false;
  while (i < text.length) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      sawAnsi = true;
      let j = i + 2;
      while (j < text.length) {
        const code = text.charCodeAt(j);
        j += 1;
        if (code >= 0x40 && code <= 0x7e) break;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    const codePoint = text.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(codePoint);
    const charWidth = displayWidth(char);
    if (width + charWidth > maxWidth) break;
    out += char;
    width += charWidth;
    i += char.length;
  }
  // Only force a reset when ANSI was present — plain text should stay plain.
  return sawAnsi ? `${out}\x1b[0m` : out;
}

export function fitAnsiLine(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const ellipsisWidth = displayWidth(ellipsis);
  // Double-width ellipsis (e.g. "⋯") that cannot fit: fall back to a single-width cut.
  if (width < ellipsisWidth) return truncateAnsi(text, width);
  if (width === ellipsisWidth) return truncateAnsi(ellipsis, width) || truncateAnsi(text, width);
  return `${truncateAnsi(text, width - ellipsisWidth)}${ellipsis}`;
}

export function countPhysicalLines(text: string, columns: number): number {
  const lines = text.split("\n");
  let total = 0;
  for (const line of lines) {
    const width = displayWidth(line);
    total += Math.max(1, Math.ceil(width / columns));
  }
  return Math.max(total, 1);
}

export function takeDisplayWidth(
  text: string,
  width: number,
): { prefix: string; rest: string } {
  let used = 0;
  let index = 0;
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (used + charWidth > width && used > 0) break;
    used += charWidth;
    index += char.length;
  }
  return { prefix: text.slice(0, index), rest: text.slice(index) };
}

export function padOrTruncateToWidth(text: string, width: number): string {
  const textWidth = visibleWidth(text);
  if (textWidth > width) {
    return truncateAnsi(text, width);
  }
  return `${text}${" ".repeat(width - textWidth)}`;
}

const SGR_RESET_REGEX = /^\x1b\[0?m$/;
export type WrapToken = {
  kind: "sgr" | "char";
  value: string;
  width: number;
  charIndex: number;
};

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function tokenizeAnsiLine(line: string): WrapToken[] {
  const tokens: WrapToken[] = [];
  let index = 0;
  while (index < line.length) {
    if (line[index] === "\x1b") {
      // OSC 8 hyperlinks (ESC ]8;;...ST) are zero-width style tokens.
      const osc = line.slice(index).match(/^\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/);
      if (osc) {
        tokens.push({ kind: "sgr", value: osc[0], width: 0, charIndex: index });
        index += osc[0].length;
        continue;
      }
      const sgr = SGR_SEQUENCE_REGEX.exec(line.slice(index));
      if (sgr) {
        tokens.push({ kind: "sgr", value: sgr[0], width: 0, charIndex: index });
        index += sgr[0].length;
        continue;
      }
      const csi = line.slice(index).match(/^\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/);
      if (csi) {
        tokens.push({ kind: "sgr", value: csi[0], width: 0, charIndex: index });
        index += csi[0].length;
        continue;
      }
    }
    let nextEsc = line.indexOf("\x1b", index);
    if (nextEsc === -1) nextEsc = line.length;
    const chunk = line.slice(index, nextEsc);
    for (const item of graphemeSegmenter.segment(chunk)) {
      tokens.push({
        kind: "char",
        value: item.segment,
        width: displayWidth(item.segment),
        charIndex: index + item.index,
      });
    }
    index = nextEsc;
  }
  return tokens;
}

/**
 * Build a character-offset mapping from stripped styled line back to raw source line.
 * Handles Markdown formatting ([link](url), `code`, **bold**, *italic*, ~~strike~~, # headings).
 */
export function buildSourceMapping(rawLine: string, styledLine: string, prefixCharCount: number): number[] {
  let contentStart = 0;
  const headingMatch = rawLine.match(/^(#{1,3})\s+(.+)$/);
  let lineToParse = rawLine;
  if (headingMatch) {
    contentStart = headingMatch[1]!.length + 1;
    while (contentStart < rawLine.length && rawLine[contentStart] === " ") contentStart++;
    lineToParse = rawLine.slice(contentStart);
  }

  const INLINE_RE = /(\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*(.+?)\*\*|(?<!\*)\*([^*]+?)\*(?!\*)|~~([^~]+?)~~)/g;
  const mapping: number[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE_RE.exec(lineToParse)) !== null) {
    const plainBefore = lineToParse.slice(lastIdx, match.index);
    for (let c = 0; c < plainBefore.length; c++) {
      mapping.push(contentStart + lastIdx + c);
    }

    const fullMatch = match[0];
    if (match[2] !== undefined && match[3] !== undefined) {
      // Link [text](url) -> visible "text (url)"
      const linkText = match[2];
      const linkUrl = match[3];
      const textOffset = contentStart + match.index + 1;
      for (let c = 0; c < linkText.length; c++) {
        mapping.push(textOffset + c);
      }
      const parenOffset = textOffset + linkText.length;
      mapping.push(parenOffset);
      mapping.push(parenOffset + 1);
      const urlOffset = parenOffset + 2;
      for (let c = 0; c < linkUrl.length; c++) {
        mapping.push(urlOffset + c);
      }
      mapping.push(urlOffset + linkUrl.length);
    } else if (match[4] !== undefined) {
      // `code` -> visible "code"
      const codeText = match[4];
      const codeOffset = contentStart + match.index + 1;
      for (let c = 0; c < codeText.length; c++) {
        mapping.push(codeOffset + c);
      }
    } else if (match[5] !== undefined) {
      // **bold** -> visible "bold"
      const boldText = match[5];
      const boldOffset = contentStart + match.index + 2;
      for (let c = 0; c < boldText.length; c++) {
        mapping.push(boldOffset + c);
      }
    } else if (match[6] !== undefined) {
      // *italic* -> visible "italic"
      const italicText = match[6];
      const italicOffset = contentStart + match.index + 1;
      for (let c = 0; c < italicText.length; c++) {
        mapping.push(italicOffset + c);
      }
    } else if (match[7] !== undefined) {
      // ~~strikethrough~~ -> visible "strikethrough"
      const strikeText = match[7];
      const strikeOffset = contentStart + match.index + 2;
      for (let c = 0; c < strikeText.length; c++) {
        mapping.push(strikeOffset + c);
      }
    }
    lastIdx = match.index + fullMatch.length;
  }

  const plainRest = lineToParse.slice(lastIdx);
  for (let c = 0; c < plainRest.length; c++) {
    mapping.push(contentStart + lastIdx + c);
  }

  return mapping;
}

export type WrappedTranscriptRow = {
  rendered: string;
  sourceStart: number;
  sourceEnd: number;
  prefixWidth: number;
  sourceMapping?: number[];
  /** True when the next physical row continues the same logical source line. */
  softWrapped?: boolean;
  /** Whitespace consumed at the wrap boundary and absent from rendered rows. */
  softWrapJoiner?: string;
};

/**
 * Wrap one transcript line to `columns` visible cells, tracking source start/end offsets.
 */
export function wrapTranscriptLineWithLayout(
  line: string,
  columns: number,
  hangingIndent = "",
  lineSourceStart = 0,
  prefixWidth = 0,
  prefixCharCount = 0,
  sourceMapping?: number[],
  rawLineLength?: number,
): WrappedTranscriptRow[] {
  if (line === "") {
    const rawLen = rawLineLength ?? 0;
    return [
      {
        rendered: "",
        sourceStart: lineSourceStart,
        sourceEnd: lineSourceStart + rawLen,
        prefixWidth,
      },
    ];
  }
  const tokens = tokenizeAnsiLine(line);
  const rows: WrappedTranscriptRow[] = [];

  let activeStyles: string[] = [];
  const applyStyleToken = (value: string) => {
    if (SGR_RESET_REGEX.test(value)) {
      activeStyles = [];
    } else {
      activeStyles.push(value);
    }
  };

  let start = 0;
  while (start < tokens.length) {
    // Only zero-width style tokens left: fold them into the previous line
    // instead of emitting a visually blank row.
    if (tokens.slice(start).every((token) => token.kind === "sgr")) {
      if (rows.length > 0) break;
    }
    const openingStyles = [...activeStyles];
    const isContinuation = rows.length > 0;
    const currentPrefixWidth = isContinuation ? visibleWidth(hangingIndent) : prefixWidth;
    const indentWidth = isContinuation ? visibleWidth(hangingIndent) : 0;
    const maxSegmentWidth = Math.max(1, columns - indentWidth);

    let width = 0;
    let end = start;
    let lastBreak = -1; // index just after a breakable char
    while (end < tokens.length) {
      const token = tokens[end]!;
      if (token.kind === "sgr") {
        end += 1;
        continue;
      }
      if (width + token.width > maxSegmentWidth && width > 0) break;
      width += token.width;
      end += 1;
      if ((token.value === " " || token.value === "\t") && token.charIndex >= prefixCharCount) {
        lastBreak = end;
      }
    }

    let segmentEnd = end;
    if (end < tokens.length && lastBreak > start) {
      // Mid-word overflow with a space earlier in the segment: break there.
      const overflowToken = tokens[end]!;
      if (overflowToken.kind === "char" && overflowToken.value !== " " && overflowToken.width === 1) {
        segmentEnd = lastBreak;
      }
    }
    if (segmentEnd === start) segmentEnd = start + 1;

    let segment = "";
    let sawStyle = openingStyles.length > 0;
    for (let i = start; i < segmentEnd; i += 1) {
      const token = tokens[i]!;
      segment += token.value;
      if (token.kind === "sgr") {
        sawStyle = true;
        applyStyleToken(token.value);
      }
    }
    const prefix = openingStyles.join("");
    const needsReset =
      (sawStyle || activeStyles.length > 0) && !segment.endsWith("\x1b[0m");
    const lineContent = `${prefix}${segment}${needsReset ? "\x1b[0m" : ""}`;
    const rowRendered = isContinuation && hangingIndent.length > 0 ? `${hangingIndent}${lineContent}` : lineContent;

    let segSourceStart = lineSourceStart;
    let segSourceEnd = lineSourceStart;
    let foundFirst = false;
    const rowMapping: number[] = [];

    // Calculate plainCharIndex up to segment start (excluding ANSI codes)
    let plainCharIndex = 0;
    for (let i = 0; i < start; i++) {
      const tok = tokens[i]!;
      if (tok.kind === "char" && tok.charIndex >= prefixCharCount) {
        plainCharIndex += tok.value.length;
      }
    }

    for (let i = start; i < segmentEnd; i++) {
      const tok = tokens[i]!;
      if (tok.kind === "char" && tok.charIndex >= prefixCharCount) {
        const mappedOffset = sourceMapping && sourceMapping[plainCharIndex] !== undefined
          ? sourceMapping[plainCharIndex]!
          : plainCharIndex;
        if (!foundFirst) {
          segSourceStart = lineSourceStart + mappedOffset;
          foundFirst = true;
        }
        for (let c = 0; c < tok.value.length; c++) {
          const idx = plainCharIndex + c;
          const mapped = sourceMapping && sourceMapping[idx] !== undefined ? sourceMapping[idx]! : idx;
          rowMapping.push(lineSourceStart + mapped);
        }
        const lastCharIdx = plainCharIndex + tok.value.length - 1;
        const mappedEndOffset = sourceMapping && sourceMapping[lastCharIdx] !== undefined
          ? sourceMapping[lastCharIdx]! + 1
          : plainCharIndex + tok.value.length;
        segSourceEnd = lineSourceStart + mappedEndOffset;
        plainCharIndex += tok.value.length;
      }
    }

    start = segmentEnd;
    let softWrapJoiner = "";
    // Continuation rows never start with the space we just wrapped at.
    while (start < tokens.length) {
      const token = tokens[start]!;
      if (token.kind === "char" && token.value === " " && token.charIndex >= prefixCharCount) {
        softWrapJoiner += token.value;
        const mappedOffset = sourceMapping && sourceMapping[plainCharIndex] !== undefined
          ? sourceMapping[plainCharIndex]! + 1
          : plainCharIndex + 1;
        segSourceEnd = lineSourceStart + mappedOffset;
        plainCharIndex += token.value.length;
        start += 1;
        continue;
      }
      break;
    }

    if (start >= tokens.length && rawLineLength !== undefined) {
      segSourceEnd = lineSourceStart + rawLineLength;
    }

    rows.push({
      rendered: rowRendered,
      sourceStart: segSourceStart,
      sourceEnd: segSourceEnd,
      prefixWidth: currentPrefixWidth,
      sourceMapping: rowMapping.length > 0 ? rowMapping : undefined,
      softWrapped: start < tokens.length,
      softWrapJoiner,
    });
  }

  return rows.length > 0
    ? rows
    : [
        {
          rendered: "",
          sourceStart: lineSourceStart,
          sourceEnd: lineSourceStart + (rawLineLength ?? 0),
          prefixWidth,
        },
      ];
}

/**
 * Wrap one transcript line to `columns` visible cells.
 *
 * Unlike `wrapTextToLines` (composer draft; must stay byte-per-cell simple so
 * cursor math holds), this wrapper:
 * - treats SGR color sequences as zero-width and re-opens the active style on
 * the continuation line, closing every styled line with a reset so colors
 * never bleed into the scrollbar column or the next row;
 * - prefers breaking after the last space/tab so latin words survive wrapping
 * (CJK breaks anywhere, which is correct for those scripts).
 */
export function wrapTranscriptLine(
  line: string,
  columns: number,
  hangingIndent = ""
): string[] {
  return wrapTranscriptLineWithLayout(line, columns, hangingIndent).map((r) => r.rendered);
}

/**
 * Build terminal window/tab title OSC escape sequences.
 * Strips ANSI codes, converts newlines to spaces, truncates to 80 display columns,
 * and emits both OSC 0 and OSC 2 using BEL (\x07) as string terminator.
 */
export function buildWindowTitle(title: string): string {
  // Strip ANSI first, then replace all C0/C1 control chars (including BEL \x07
  // and ESC \x1b) with spaces so they can't prematurely terminate the OSC 0/2
  // sequence or leak raw escapes into the terminal.
  const plain = stripAnsi(title).replace(/[\x00-\x1f\x7f]+/g, " ");
  let truncated = "";
  let width = 0;
  const maxCols = 80;
  for (const char of plain) {
    const charWidth = displayWidth(char);
    if (width + charWidth > maxCols) break;
    truncated += char;
    width += charWidth;
  }
  return `\x1b]0;${truncated}\x07\x1b]2;${truncated}\x07`;
}

export function wrapTextToLines(text: string, columns: number): string[] {
  const result: string[] = [];
  for (const logicalLine of text.split("\n")) {
    if (logicalLine === "") {
      result.push("");
      continue;
    }
    let remaining = logicalLine;
    while (remaining.length > 0) {
      const { prefix, rest } = takeDisplayWidth(remaining, columns);
      result.push(prefix);
      remaining = rest;
    }
  }
  return result;
}
