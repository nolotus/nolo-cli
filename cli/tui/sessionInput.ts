import { compactWhitespace } from "../../core/compactWhitespace";
import type { TuiKeyInfo, TuiInputKeyResult } from "./sessionTypes";

// ─── Key handling ───────────────────────────────────────────────────────────

export const PASTE_TOKEN_PREFIX = "\x00PASTE\x00";

export function applyTuiInputKey(
  buffer: string,
  sequence: string | undefined,
  key: TuiKeyInfo = {},
  cursorPos?: number
): TuiInputKeyResult {
  const seq = sequence ?? "";
  const curPos = Math.max(0, Math.min(buffer.length, cursorPos ?? buffer.length));

  if (seq.startsWith(PASTE_TOKEN_PREFIX)) {
    const rawPayload = seq.slice(PASTE_TOKEN_PREFIX.length);
    const normalized = rawPayload.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const nextBuf = buffer.slice(0, curPos) + normalized + buffer.slice(curPos);
    return { buffer: nextBuf, cursorPos: curPos + normalized.length };
  }
  if (seq === "\u0003" || (key.ctrl && key.name === "c")) {
    return { buffer, cursorPos: curPos, abort: true };
  }
  if (seq === "\u000f" || (key.ctrl && key.name === "o")) {
    return { buffer, cursorPos: curPos, copyView: true };
  }
  if (
    seq === "\x1b[13;2~" ||
    seq === "\x1b[27;2;13~" ||
    seq === "\x1b\r" ||
    (key.shift && (key.name === "enter" || key.name === "return")) ||
    seq === "\n" ||
    (key.ctrl && key.name === "j")
  ) {
    const nextBuf = buffer.slice(0, curPos) + "\n" + buffer.slice(curPos);
    return { buffer: nextBuf, cursorPos: curPos + 1 };
  }
  if (key.name === "enter" || key.name === "return" || seq === "\r") {
    return { buffer: "", cursorPos: 0, submit: buffer };
  }

  // Navigation: Left / Right / Home (Ctrl+A) / End (Ctrl+E)
  if (isLeftArrowSequence(seq, key)) {
    return { buffer, cursorPos: Math.max(0, curPos - 1) };
  }
  if (isRightArrowSequence(seq, key)) {
    return { buffer, cursorPos: Math.min(buffer.length, curPos + 1) };
  }
  if (isHomeSequence(seq, key)) {
    return { buffer, cursorPos: 0 };
  }
  if (isEndSequence(seq, key)) {
    return { buffer, cursorPos: buffer.length };
  }

  // Delete word left (Ctrl+W / Ctrl+Backspace / Alt+Backspace): readline-style word delete.
  // Skips trailing whitespace, then deletes one word (non-whitespace run, or one CJK char).
  if (isDeleteWordSequence(seq, key)) {
    if (curPos === 0) return { buffer, cursorPos: curPos };
    const cutIdx = findWordStartLeft(buffer, curPos);
    const nextBuf = buffer.slice(0, cutIdx) + buffer.slice(curPos);
    return { buffer: nextBuf, cursorPos: cutIdx };
  }

  // Kill to line start (Ctrl+U): deletes from cursor to beginning of current line.
  // In a multiline buffer only the current line segment before the cursor is removed.
  if (isKillToLineStartSequence(seq, key)) {
    if (curPos === 0) return { buffer, cursorPos: curPos };
    const lineStart = buffer.lastIndexOf("\n", curPos - 1) + 1;
    const nextBuf = buffer.slice(0, lineStart) + buffer.slice(curPos);
    return { buffer: nextBuf, cursorPos: lineStart };
  }

  // Kill to line end (Ctrl+K): deletes from cursor to end of current line.
  // In a multiline buffer only the current line segment at/after the cursor is removed.
  if (isKillToLineEndSequence(seq, key)) {
    const nlIdx = buffer.indexOf("\n", curPos);
    const lineEnd = nlIdx === -1 ? buffer.length : nlIdx;
    const nextBuf = buffer.slice(0, curPos) + buffer.slice(lineEnd);
    return { buffer: nextBuf, cursorPos: curPos };
  }

  // Backspace (deletes character left of cursor)
  if (isBackspaceSequence(seq, key)) {
    if (curPos > 0) {
      const nextBuf = buffer.slice(0, curPos - 1) + buffer.slice(curPos);
      return { buffer: nextBuf, cursorPos: curPos - 1 };
    }
    return { buffer, cursorPos: curPos };
  }

  // Forward Delete (deletes character at cursor; fallback to backspace if at end)
  if (isForwardDeleteSequence(seq, key)) {
    if (curPos < buffer.length) {
      const nextBuf = buffer.slice(0, curPos) + buffer.slice(curPos + 1);
      return { buffer: nextBuf, cursorPos: curPos };
    }
    if (curPos > 0) {
      const nextBuf = buffer.slice(0, curPos - 1);
      return { buffer: nextBuf, cursorPos: curPos - 1 };
    }
    return { buffer, cursorPos: curPos };
  }

  if (seq === "\t" || key.name === "tab") {
    const completed = completeSlashPrefix(buffer) ?? buffer;
    return { buffer: completed, cursorPos: completed.length };
  }

  if (!seq || key.ctrl || key.meta || seq.startsWith("\x1b")) {
    return { buffer, cursorPos: curPos };
  }

  const nextBuf = buffer.slice(0, curPos) + seq + buffer.slice(curPos);
  return { buffer: nextBuf, cursorPos: curPos + seq.length };
}

function isLeftArrowSequence(seq: string, key: TuiKeyInfo): boolean {
  if (key.name === "left") return true;
  if (seq === "\x1b[D" || seq === "\x1b[1;2D" || seq === "\x1b[1;5D" || seq === "\x1bOD") return true;
  return false;
}

function isRightArrowSequence(seq: string, key: TuiKeyInfo): boolean {
  if (key.name === "right") return true;
  if (seq === "\x1b[C" || seq === "\x1b[1;2C" || seq === "\x1b[1;5C" || seq === "\x1bOC") return true;
  return false;
}

function isHomeSequence(seq: string, key: TuiKeyInfo): boolean {
  if (key.name === "home") return true;
  if (key.ctrl && key.name === "a") return true;
  if (seq === "\u0001" || seq === "\x1b[H" || seq === "\x1b[1~" || seq === "\x1b[7~" || seq === "\x1bOH") return true;
  return false;
}

function isEndSequence(seq: string, key: TuiKeyInfo): boolean {
  if (key.name === "end") return true;
  if (key.ctrl && key.name === "e") return true;
  if (seq === "\u0005" || seq === "\x1b[F" || seq === "\x1b[4~" || seq === "\x1b[8~" || seq === "\x1bOF") return true;
  return false;
}

// CJK + fullwidth forms: each character is treated as its own "word" for Ctrl+W.
const CJK_CHAR = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

/**
 * Find the index where a left-ward word delete should cut.
 * Skips trailing whitespace, then deletes one word:
 * - a single CJK char (each char is a word), or
 * - a run of non-whitespace ASCII-ish chars.
 */
function findWordStartLeft(buffer: string, curPos: number): number {
  let i = curPos;
  while (i > 0 && /\s/.test(buffer[i - 1])) i--;
  if (i === 0) return 0;
  // CJK char is its own word — stop after deleting one.
  if (CJK_CHAR.test(buffer[i - 1])) return i - 1;
  // ASCII word run — stop at whitespace OR CJK boundary (don't eat into CJK).
  while (i > 0 && !/\s/.test(buffer[i - 1]) && !CJK_CHAR.test(buffer[i - 1])) i--;
  return i;
}

function isDeleteWordSequence(seq: string, key: TuiKeyInfo): boolean {
  if (key.ctrl && key.name === "w") return true;
  // Ctrl+Backspace and Alt+Backspace both delete a word left (readline convention).
  if ((key.ctrl || key.meta) && key.name === "backspace") return true;
  if (seq === "\x17" || seq === "\x1b\x7f") return true;
  return false;
}

function isKillToLineStartSequence(seq: string, key: TuiKeyInfo): boolean {
  if (key.ctrl && key.name === "u") return true;
  if (seq === "\x15") return true;
  return false;
}

function isKillToLineEndSequence(seq: string, key: TuiKeyInfo): boolean {
  if (key.ctrl && key.name === "k") return true;
  if (seq === "\x0b") return true;
  return false;
}

function isBackspaceSequence(seq: string, key: TuiKeyInfo): boolean {
  if (key.name === "backspace") return true;
  if (seq === "\b" || seq === "\x7f") return true;
  // eslint-disable-next-line no-control-regex
  return /^\x1b\[27;\d+;8~$/.test(seq);
}

function isForwardDeleteSequence(seq: string, key: TuiKeyInfo): boolean {
  if (key.name === "delete") return true;
  // eslint-disable-next-line no-control-regex
  return /^\x1b\[3(?:;\d+)*~$/.test(seq);
}

// ─── Slash command registry & completion ────────────────────────────────────

export const SLASH_COMMANDS = [
  "/help",
  "/new",
  "/compact",
  "/theme",
  "/density",
  "/context",
  "/ctx",
  "/runtime",
  "/tools",
  "/thinking",
  "/switch",
  "/agent",
  "/agents",
  "/history",
  "/resume",
  "/lang",
  "/copy",
  "/mouse",
  "/doc",
  "/skill",
  "/customize",
  "/login",
  "/profile",
  "/update",
  "/version",
  "/tasks",
  "/jobs",
  "/procs",
  "/stop",
  "/exit",
  "/quit",
] as const;

/**
 * Tab completion for a partial slash command. Returns the new buffer, or
 * null when the buffer is not a completable command prefix (not a slash
 * command, already has arguments, or nothing matches).
 */
export function completeSlashPrefix(buffer: string): string | null {
  if (!buffer.startsWith("/") || /\s/.test(buffer)) return null;
  const matches = SLASH_COMMANDS.filter((cmd) => cmd.startsWith(buffer));
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    return `${matches[0]} `;
  }
  let prefix: string = matches[0];
  for (const cmd of matches) {
    while (!cmd.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix.length > buffer.length ? prefix : null;
}

export function completeSlashCommand(buffer: string): string[] {
  if (!buffer.startsWith("/")) return [];
  const trimmed = buffer.trim();
  if (trimmed.includes(" ")) return [];
  return SLASH_COMMANDS.filter((cmd) => cmd.startsWith(trimmed) && cmd !== trimmed);
}

// ─── Input classification ───────────────────────────────────────────────────

/**
 * 判断一行 input 是不是 slash 命令。
 *
 * 关键陷阱:Unix 绝对路径都以 `/` 开头(`/Users/foo`),而 slash 命令也是
 * `/foo`。直接 `startsWith("/")` 会把 paste 进来的文件路径当成 unknown slash
 * command。
 *
 * 判别规则:
 * - 必须以 `/` 开头
 * - 第一个 token(到首个空白前)必须 match `/[a-zA-Z_][a-zA-Z0-9._:-]*`
 *   这同时排除两个情况:
 *   1. 路径(`/Users/foo`,因为 token 含第二个 `/`,regex 不匹配)
 *   2. 数字开头(`/123abc` 不是合法命令名)
 *
 * 这样 `/help`、`/switch list` 都正确判为 slash,
 * `/Users/x.png 看图`、`/etc/hosts` 都正确判为 chat。
 */
export function isLikelySlashCommand(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return false;
  const spaceIdx = trimmed.search(/\s/);
  const firstToken = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  return /^\/[a-zA-Z_][a-zA-Z0-9._:-]*$/.test(firstToken);
}

/**
 * 把 hints 对应的 raw token 从 message 里 strip 掉。
 * 用于"看图 /Users/foo/a.png 怎么样"这种:路径不应该作为文本发给 LLM。
 *
 * - strip 后空了就保留原 message(避免空 message,workspace 仍然发图片)
 * - 失败的 hint 不会出现在这里(只有 sync 阶段确认的路径才会传进来)
 */
export function stripImageTokens(input: string, hints: { raw: string }[]): string {
  if (hints.length === 0) return input;
  let out = input;
  for (const hint of hints) {
    if (!hint.raw) continue;
    const escaped = hint.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), "");
  }
  return compactWhitespace(out);
}
