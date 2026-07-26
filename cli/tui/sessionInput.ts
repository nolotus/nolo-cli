import { compactWhitespace } from "../../core/compactWhitespace";
import type { TuiKeyInfo, TuiInputKeyResult } from "./sessionTypes";

// ─── Key handling ───────────────────────────────────────────────────────────

export const PASTE_TOKEN_PREFIX = "\x00PASTE\x00";

export function applyTuiInputKey(
  buffer: string,
  sequence: string | undefined,
  key: TuiKeyInfo = {}
): TuiInputKeyResult {
  const seq = sequence ?? "";
  if (seq.startsWith(PASTE_TOKEN_PREFIX)) {
    const rawPayload = seq.slice(PASTE_TOKEN_PREFIX.length);
    const normalized = rawPayload.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return { buffer: `${buffer}${normalized}` };
  }
  if (seq === "\u0003" || (key.ctrl && key.name === "c")) {
    return { buffer, abort: true };
  }
  if (seq === "\u000f" || (key.ctrl && key.name === "o")) {
    return { buffer, copyView: true };
  }
  if (
    seq === "\x1b[13;2~" ||
    seq === "\x1b[27;2;13~" ||
    seq === "\x1b\r" ||
    (key.shift && (key.name === "enter" || key.name === "return")) ||
    seq === "\n" ||
    (key.ctrl && key.name === "j")
  ) {
    return { buffer: `${buffer}\n` };
  }
  if (key.name === "enter" || key.name === "return" || seq === "\r") {
    return { buffer: "", submit: buffer };
  }
  // Backspace / Delete (incl. modifier variants).
  // Plain: \b (0x08), \x7f (DEL). Alt+Backspace: \x1b\x7f / \x1b\b (split into
  // ESC + DEL by splitRawInput, so the DEL half reaches here as \x7f/\b).
  // Ctrl/Shift+Backspace on modern terminals: \x1b[3;5~ / \x1b[27;2;8~.
  // Forward Delete and modifier Delete: \x1b[3~ and \x1b[3;{modifier}~.
  // In a single-line buffer, forward-delete behaves like backspace.
  if (
    key.name === "backspace" ||
    key.name === "delete" ||
    seq === "\b" ||
    seq === "\x7f" ||
    isDeleteFamilyCsi(seq)
  ) {
    if (buffer.length > 0) {
      return { buffer: buffer.slice(0, -1) };
    }
    return { buffer };
  }
  if (seq === "\t" || key.name === "tab") {
    // Tab-complete slash commands: unique match fills the whole command
    // (plus a trailing space, ready for arguments), multiple matches extend
    // to their longest common prefix. Never inserts a literal tab.
    return { buffer: completeSlashPrefix(buffer) ?? buffer };
  }
  if (!seq || key.ctrl || key.meta || seq.startsWith("\x1b")) {
    return { buffer };
  }
  return { buffer: `${buffer}${seq}` };
}

/**
 * Match CSI sequences for Backspace/Delete with modifier keys.
 *
 * Terminals encode modifier keys in the CSI parameter: `\x1b[3;{m}~` for
 * Delete variants and some terminals use `\x1b[27;{m};{code}~` for Backspace
 * variants. We accept any modifier (2=shift, 3=alt, 5=ctrl, etc.) and any
 * base (3=Delete, 8=Backspace), since in a single-line TUI buffer they all
 * just delete the last character.
 */
function isDeleteFamilyCsi(seq: string): boolean {
  // Delete family: ESC [ 3 [; modifier] ~  (e.g. \x1b[3~, \x1b[3;2~, \x1b[3;5~)
  // eslint-disable-next-line no-control-regex
  if (/^\x1b\[3(?:;\d+)*~$/.test(seq)) return true;
  // Backspace family: ESC [ 27 ; modifier ; 8 ~ (e.g. \x1b[27;2;8~)
  // eslint-disable-next-line no-control-regex
  if (/^\x1b\[27;\d+;8~$/.test(seq)) return true;
  return false;
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
 * 这样 `/help`、`/switch list`、`/attach /tmp/x.png` 都正确判为 slash,
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
