import { themeColorSequence, resolveTuiBrightness, type TuiBrightness } from "../tui/theme";

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
function colorSeq(
  token: "accent" | "chrome" | "info" | "muted" | "success" | "warning",
  brightness: TuiBrightness
) {
  // "success" is added for syntax-highlight string literals; themeColorSequence
  // already supports it (it's a TuiThemeToken), so theme.ts needs no change.
  return themeColorSequence(token, process.env, brightness);
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

// ─── Code-block syntax highlighting (line-local) ───────────────────────────
// The highlighter is deliberately LINE-LOCAL: it only ever looks at the single
// line passed to it. The streaming path emits one line at a time and a line
// can't be revised once written, so any cross-line state would desync under
// streaming. Consequences (intentional trade-offs, NOT bugs to fix):
//   - Multi-line `/* ... */` block comments: only the part after `/*` on the
//     OPENING line is treated as a comment; middle/end lines are NOT.
//   - Python `"""..."""` triple-quoted strings: same — only the opening line.
// The only cross-line state allowed is the pre-existing `inFence` flag plus
// the current fence's language, both maintained by the callers.

/** ```ts / ```bash / ``` → "ts" / "bash" / "" (closing fence → ""). */
function readFenceLanguage(line: string): string {
  const m = line.match(/^\s*```\s*([a-zA-Z0-9+#_-]*)/);
  return m ? (m[1] ?? "").toLowerCase() : "";
}

type CodeLang = "js" | "py" | "sh" | "json" | "unknown";

/** Normalize a fence language hint into one of the supported highlight langs. */
function normalizeCodeLang(raw: string): CodeLang {
  switch (raw) {
    case "js":
    case "jsx":
    case "ts":
    case "tsx":
    case "javascript":
    case "typescript":
      return "js";
    case "py":
    case "python":
      return "py";
    case "sh":
    case "bash":
    case "zsh":
    case "shell":
    case "console":
      return "sh";
    case "json":
      return "json";
    default:
      return "unknown";
  }
}

const KEYWORDS: Record<Exclude<CodeLang, "unknown">, ReadonlySet<string>> = {
  js: new Set([
    "const", "let", "var", "function", "return", "if", "else", "for", "while",
    "class", "new", "await", "async", "import", "export", "from", "type",
    "interface", "extends", "implements", "null", "undefined", "true", "false",
  ]),
  py: new Set([
    "def", "class", "return", "if", "elif", "else", "for", "while", "import",
    "from", "as", "with", "try", "except", "finally", "lambda", "None", "True",
    "False", "self",
  ]),
  sh: new Set([
    "if", "then", "else", "fi", "for", "do", "done", "while", "case", "esac",
    "function", "export", "local", "return", "source", "echo", "cd",
  ]),
  json: new Set(["true", "false", "null"]),
};

// A single "segment" is a maximal run of plain (non-string, non-comment) text
// between string/comment regions. We collect string+comment regions first, then
// scan the gaps for keywords/numbers. This ordering is what keeps `"def"` from
// being colored as a keyword — strings are carved out before keyword matching.
type Region = { start: number; end: number; kind: "string" | "comment" };

/** Find string and comment regions in a line for the given language. */
function scanStringCommentRegions(line: string, lang: CodeLang): Region[] {
  const regions: Region[] = [];
  const n = line.length;
  let i = 0;
  // sh and py use `#` for comments; js and json use `//`. We only recognize the
  // line-comment form (line-local: no block-comment state).
  const commentMarkers: string[] =
    lang === "py" || lang === "sh" ? ["#"] : ["//"];
  while (i < n) {
    const ch = line[i];
    // Strings: ', ", ` (js only for backtick). Pair on the same line; an
    // unclosed quote runs to end-of-line.
    if (ch === "'" || ch === '"' || (lang === "js" && ch === "`")) {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < n) {
        if (line[i] === "\\") {
          i += 2; // skip escaped char
          continue;
        }
        if (line[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      regions.push({ start, end: i, kind: "string" });
      continue;
    }
    // Comments: highest priority once we hit a marker outside a string.
    let matched = false;
    for (const marker of commentMarkers) {
      if (line.startsWith(marker, i)) {
        regions.push({ start: i, end: n, kind: "comment" });
        i = n;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    i += 1;
  }
  // Regions are produced in increasing start order by construction.
  return regions;
}

/**
 * Highlight a single code line with theme tokens. Line-local only.
 * `lang === "unknown"` returns the EXACT pre-change result (whole line in info),
 * so unannotated code blocks are byte-identical to before — zero regression.
 */
function highlightCodeLine(line: string, lang: CodeLang, brightness: TuiBrightness): string {
  const info = colorSeq("info", brightness);
  if (lang === "unknown") {
    return `${info}${line}${STYLE.reset}`;
  }
  const regions = scanStringCommentRegions(line, lang);
  const keywords = KEYWORDS[lang];
  const accent = colorSeq("accent", brightness);
  const success = colorSeq("success", brightness);
  const warning = colorSeq("warning", brightness);
  const chrome = colorSeq("chrome", brightness);
  const dim = STYLE.dim;
  const reset = STYLE.reset;

  const out: string[] = [];
  let cursor = 0;
  for (const region of regions) {
    // Plain gap before this region: scan for keywords + numbers, default info.
    if (region.start > cursor) {
      out.push(emitPlainGap(line.slice(cursor, region.start), keywords, info, accent, warning, reset));
    }
    const text = line.slice(region.start, region.end);
    if (region.kind === "string") {
      out.push(`${success}${text}${reset}`);
    } else {
      out.push(`${chrome}${dim}${text}${reset}`);
    }
    cursor = region.end;
  }
  // Trailing plain gap after the last region.
  if (cursor < line.length) {
    out.push(emitPlainGap(line.slice(cursor), keywords, info, accent, warning, reset));
  }
  return out.join("");
}

/** Emit a plain (non-string, non-comment) gap: keywords→accent, numbers→warning, else→info. */
function emitPlainGap(
  text: string,
  keywords: ReadonlySet<string>,
  info: string,
  accent: string,
  warning: string,
  reset: string
): string {
  // Tokenize into word/number runs and everything else. Anything not matched
  // stays in the info base color so the block keeps a continuous background.
  const parts: string[] = [];
  const re = /([A-Za-z_]\w*)|(\d+(?:\.\d+)?)|([\s\S])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let started = false;
  while ((m = re.exec(text)) !== null) {
    if (!started) {
      // leading text before first token, if any (re always matches at 0 due to [\s\S])
      started = true;
    }
    if (m.index > last) {
      parts.push(`${info}${text.slice(last, m.index)}`);
    }
    if (m[1] !== undefined) {
      const word = m[1];
      if (keywords.has(word)) {
        parts.push(`${accent}${word}${reset}`);
      } else {
        parts.push(`${info}${word}`);
      }
    } else if (m[2] !== undefined) {
      parts.push(`${warning}${m[2]}${reset}`);
    } else {
      parts.push(`${info}${m[3]}`);
    }
    last = re.lastIndex;
  }
  if (last < text.length) {
    parts.push(`${info}${text.slice(last)}`);
  }
  return parts.join("");
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
  // Drop NUL before masking. The fence mask below encodes interior lines as
  // \x00F<n>\x00, so text that already contained a literal \x00 could be
  // mistaken for a sentinel and restored as the wrong line. NUL is never
  // meaningful in markdown — the TUI transcript path strips it anyway — so
  // removing it here closes the collision instead of relying on callers.
  const converted = convertMarkdownTablesForTerminal(text)
    .replace(/\r\n/g, "\n")
    .replace(/\x00/g, "");
  const lines = converted.split("\n");

  // 遮罩：逐行扫描并标记围栏内部。
  // 围栏标记行（```）本身不属于围栏内部内容，保持参与围栏外逻辑；
  // 而开围栏与闭围栏之间的行被判定为围栏内部，替换为形如 \x00F<n>\x00 的非空哨兵串，
  // 避免匹配标题加空行正则，且防止围栏内连续空行被正则 3 压缩。
  let inFence = false;
  const maskedLines = lines.map((line, index) => {
    if (isCodeFenceLine(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) {
      return `\x00F${index}\x00`;
    }
    return line;
  });

  const afterHeading = maskedLines
    .join("\n")
    // Blank line before a heading, and one after it. Only the "before" half
    // existed, so a heading sat flush against its own body text and sections
    // ran together — the breathing room is what makes the structure scannable
    // once the heading itself is just colored text with no "###" marker left.
    .replace(/([^\n])\n(#{1,3} )/g, "$1\n\n$2")
    .replace(/^(#{1,3} .+)\n(?!\n)/gm, "$1\n\n")
    .replace(/\n{4,}/g, "\n\n\n");

  // List ↔ prose breathing: insert a single blank line between a list-like
  // line and an adjacent non-list, non-empty line (both directions). Long
  // replies lean on `1.`/`•`/`☐`/`☑` lists, and without a gap the list block
  // runs into the next paragraph (or the prose into the list) so nothing is
  // scannable. Consecutive list items keep their tight grouping — no blank
  // between siblings. Fence interiors are already masked to `\x00F<n>\x00`
  // sentinels (not list-like), so code that happens to look like a list is
  // never touched.
  const LIST_LIKE = /^\s*(?:•|☐|☑|\d+\.)\s/;
  const headingLines = afterHeading.split("\n");
  const breathed: string[] = [];
  for (let i = 0; i < headingLines.length; i++) {
    breathed.push(headingLines[i]);
    const cur = headingLines[i];
    const next = headingLines[i + 1];
    if (cur === "" || next === undefined || next === "") continue;
    if (LIST_LIKE.test(cur) === LIST_LIKE.test(next)) continue;
    breathed.push("");
  }
  const polishedMasked = breathed.join("\n");

  // 还原：将哨兵串按行号还原为原始围栏行
  const polished = polishedMasked.replace(
    /\x00F(\d+)\x00/g,
    (_, id) => lines[Number(id)] ?? ""
  );

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

function styleInlineMarkdown(line: string, brightness: TuiBrightness) {
  // Inline code is muted, matching highlightMarkdown (tui/theme.ts). Both
  // renderers must agree: this one styles the streamed reply, the other styles
  // the same text once it is repainted from history — a mismatch makes the
  // colors visibly shift under the user mid-scroll.
  const inlineCode = colorSeq("muted", brightness);
  const reset = STYLE.reset;
  const bold = STYLE.bold;
  return line
    .replace(MARKDOWN_LINK_RE, (m, t, u) => renderMarkdownLink(m, t, u))
    .replace(/`([^`]+)`/g, `${inlineCode}$1${reset}`)
    .replace(/\*\*(.+?)\*\*/g, `${bold}$1${reset}`);
}

function styleRichMarkdownLine(line: string, brightness: TuiBrightness) {
  const heading = line.match(/^(#{1,3})\s+(.+)$/);
  if (heading) {
    const level = heading[1].length;
    const title = heading[2];
    // Three-tier heading hierarchy for scannable structure:
    //   H1 → accent + bold + underline (strongest visual anchor, section breaks)
    //   H2 → warning + bold (warm amber, subsection headers)
    //   H3 → info + bold (lighter, paragraph-level labels)
    // The old "all warning" approach made every heading look identical; the
    // even older "h3 = info, h1/h2 = bold-only" inverted hierarchy by giving
    // the deepest level the most color. This ordering is monotonically
    // decreasing in visual weight: accent > warning > info.
    if (level === 1) {
      return `${STYLE.bold}\x1b[4m${colorSeq("accent", brightness)}${title}${STYLE.reset}`;
    }
    if (level === 2) {
      return `${STYLE.bold}${colorSeq("warning", brightness)}${title}${STYLE.reset}`;
    }
    return `${STYLE.bold}${colorSeq("info", brightness)}${title}${STYLE.reset}`;
  }
  // Blockquote: "> text" → chrome left border + dimmed content, visually
  // distinct from body text without competing with headings or code.
  const blockquote = line.match(/^>\s?(.*)$/);
  if (blockquote) {
    const border = colorSeq("chrome", brightness);
    const content = blockquote[1];
    return `${border}│${STYLE.reset} ${STYLE.dim}${content}${STYLE.reset}`;
  }
  // Horizontal rule: use chrome-colored line instead of barely-visible dim.
  if (/^---+$/.test(line.trim())) {
    return `${colorSeq("chrome", brightness)}${"─".repeat(Math.min(line.trim().length, 40))}${STYLE.reset}`;
  }
  // List bullets: color the marker for visual rhythm without coloring the
  // entire line (which would fight inline markdown highlighting).
  const bullet = line.match(/^(\s*)(•)\s(.+)$/);
  if (bullet) {
    const styled = styleInlineMarkdown(bullet[3], brightness);
    return `${bullet[1]}${colorSeq("accent", brightness)}•${STYLE.reset} ${styled}`;
  }
  // Ordered list markers (`1.`, `2.` …) and task-list markers (☐/☑): accent the
  // marker so the leading number is as scannable as a bullet, while the body
  // still goes through inline markdown. Keeps `1.` from blending into prose.
  const ordered = line.match(/^(\s*)(\d+\.)\s(.+)$/);
  if (ordered) {
    const styled = styleInlineMarkdown(ordered[3], brightness);
    return `${ordered[1]}${colorSeq("accent", brightness)}${ordered[2]}${STYLE.reset} ${styled}`;
  }
  const task = line.match(/^(\s*)(☐|☑)\s(.+)$/);
  if (task) {
    const styled = styleInlineMarkdown(task[3], brightness);
    return `${task[1]}${colorSeq("accent", brightness)}${task[2]}${STYLE.reset} ${styled}`;
  }
  return styleInlineMarkdown(line, brightness);
}

export function formatAssistantDisplay(
  text: string,
  options: { trimEdges?: boolean } = {}
) {
  const brightness = resolveTuiBrightness();
  const polished = polishAssistantStructure(text, options);
  let inFence = false;
  let fenceLang: CodeLang = "unknown";
  return polished
    .split("\n")
    .map((line) => {
      if (isCodeFenceLine(line)) {
        if (inFence) {
          // Closing fence: clear the language we recorded at the opening.
          fenceLang = "unknown";
        } else {
          // Opening fence: record the language for the lines that follow.
          fenceLang = normalizeCodeLang(readFenceLanguage(line));
        }
        inFence = !inFence;
        return `${STYLE.dim}${line}${STYLE.reset}`;
      }
      if (inFence) {
        // Line-local highlighting: only this line, no cross-line state beyond
        // fenceLang.
        return highlightCodeLine(line, fenceLang, brightness);
      }
      return styleRichMarkdownLine(line, brightness);
    })
    .join("\n");
}

function emitFormattedAssistantBlock(
  write: (chunk: string) => void,
  text: string,
  trailingNewline = false
) {
  if (!text) return;
  write(formatAssistantDisplay(text, { trimEdges: false }));
  if (trailingNewline) write("\n");
}

/**
 * Stream-path line kind for list↔prose breathing. The whole-message polish
 * sees all lines at once; the stream writer emits one finished line at a time,
 * so it must remember the previous kind and inject the same blank line the
 * polish step would have inserted.
 */
type StreamLineKind = "list" | "prose" | "blank" | "other";

function classifyStreamLine(line: string): StreamLineKind {
  if (line === "") return "blank";
  // Raw markdown forms (stream input) plus already-normalized markers.
  if (
    TASK_LIST_RE.test(line) ||
    UNORDERED_LIST_RE.test(line) ||
    ORDERED_LIST_RE.test(line) ||
    /^\s*(?:•|☐|☑)\s/.test(line)
  ) {
    return "list";
  }
  return "prose";
}

function needsListProseBreath(
  prev: StreamLineKind | null,
  next: StreamLineKind
): boolean {
  if (prev === null || prev === "blank" || next === "blank") return false;
  const prevList = prev === "list";
  const nextList = next === "list";
  // prose↔list and other↔list both breathe; prose↔other does not.
  return prevList !== nextList;
}

export function createRenderAwareStreamWriter(args: {
  write: (chunk: string) => void;
}) {
  const brightness = resolveTuiBrightness();
  let buffer = "";
  let inFence = false;
  // Current fence language, recorded at the opening fence and cleared at the
  // closing fence. This is the only cross-line state the line-local highlighter
  // is allowed to consume (see highlightCodeLine).
  let fenceLang: CodeLang = "unknown";
  // Last emitted line kind outside (and across) fences — drives stream-path
  // list↔prose breathing so live TUI matches whole-message polish.
  let lastKind: StreamLineKind | null = null;

  const emitBreathIfNeeded = (nextKind: StreamLineKind) => {
    if (needsListProseBreath(lastKind, nextKind)) args.write("\n");
  };

  const flushCompleteBlocks = () => {
    while (buffer.includes("\n")) {
      const lines = buffer.split("\n");
      if (lines.length < 2) break;
      const firstLine = lines[0] ?? "";

      if (isCodeFenceLine(firstLine)) {
        if (inFence) {
          fenceLang = "unknown";
        } else {
          fenceLang = normalizeCodeLang(readFenceLanguage(firstLine));
        }
        inFence = !inFence;
        // Fence markers count as non-list ("other") so a list run flush against
        // ``` still gets the same blank polishAssistantStructure would insert.
        emitBreathIfNeeded("other");
        args.write(`${STYLE.dim}${firstLine}${STYLE.reset}\n`);
        lastKind = "other";
        buffer = lines.slice(1).join("\n");
        continue;
      }
      if (inFence) {
        // Line-local highlighting, matching formatAssistantDisplay. No trim,
        // no table conversion inside fences. Interior never breathes as lists.
        args.write(`${highlightCodeLine(firstLine, fenceLang, brightness)}\n`);
        lastKind = "other";
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

          // Tables render as bullet lists — breathe like entering a list, then
          // leave lastKind as list so following prose also breathes.
          emitBreathIfNeeded("list");
          emitFormattedAssistantBlock(
            args.write,
            lines.slice(0, end).join("\n"),
            true
          );
          lastKind = "list";
          buffer = lines.slice(end).join("\n");
          continue;
        }
      }

      const kind = classifyStreamLine(firstLine);
      emitBreathIfNeeded(kind);
      emitFormattedAssistantBlock(args.write, firstLine, true);
      lastKind = kind;
      buffer = lines.slice(1).join("\n");
    }
  };

  return {
    push(chunk: string) {
      if (!chunk) return;
      buffer += chunk;
      flushCompleteBlocks();
    },
    flush() {
      if (!buffer) return;
      if (inFence) {
        args.write(buffer);
      } else {
        emitFormattedAssistantBlock(args.write, buffer);
      }
      buffer = "";
    },
  };
}