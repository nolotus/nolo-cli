import type { PermissionRequest } from "../../agent-runtime/actionGate";
import {
  renderDialogCommand,
  renderDialogTitle,
} from "./dialogFrame";
import { t } from "./i18n";
import {
  runSelectDialog,
  type KeyReader,
  type SelectDialogItem,
} from "./selectDialog";

type ConfirmDialogItem = SelectDialogItem & {
  value: boolean;
};

/**
 * Conservative terminal width when the real width is unknown (non-TTY or a
 * stream that doesn't report columns). Keeps long commands from wrapping the
 * confirm frame into an unreadable wall of text.
 */
const FALLBACK_TERMINAL_WIDTH = 80;

/**
 * CJK ideographs, kana, Hangul and fullwidth forms occupy two terminal columns
 * each. `String.length` counts UTF-16 code units, so a path of Chinese
 * directory names measures roughly half its real width — enough to slip past a
 * length-based budget and wrap the frame it was supposed to fit inside.
 */
const WIDE_CHAR = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;

/** Terminal columns `text` occupies, counting wide characters as two. */
function displayWidth(text: string): number {
  let width = 0;
  // Iterate by code point so astral chars (emoji in a path) count once.
  for (const char of text) width += WIDE_CHAR.test(char) ? 2 : 1;
  return width;
}

/**
 * Truncate a command to fit within `maxWidth` columns (accounting for the
 * 2-space indent renderDialogCommand adds) and append a localized
 * "(truncated)" marker when it had to be cut. Measures in terminal columns,
 * not code units, so a CJK command is cut where it actually overflows. Pure
 * string math — no ANSI — so the same value works whether color is on or off.
 */
function truncateCommand(command: string, maxWidth: number): string {
  const indent = 2;
  const budget = Math.max(10, maxWidth - indent);
  if (displayWidth(command) <= budget) return command;
  const marker = ` ${t("dialogConfirmCommandTruncated")}`;
  const keep = Math.max(1, budget - displayWidth(marker));
  let kept = "";
  let width = 0;
  for (const char of command) {
    const charWidth = WIDE_CHAR.test(char) ? 2 : 1;
    if (width + charWidth > keep) break;
    kept += char;
    width += charWidth;
  }
  return `${kept}${marker}`;
}

export async function runConfirmDialog(args: {
  request: PermissionRequest;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WritableStream;
  readKey?: KeyReader;
  /**
   * Dock the prompt above the composer; see runSelectDialog.bottomAnchored.
   * Required in practice for confirms opened mid-turn: an unanchored frame is
   * painted into the scroll region and wiped by the next streaming repaint.
   */
  bottomAnchored?: boolean;
  bottomRow?: number;
}): Promise<boolean> {
  const output = args.output ?? process.stdout;
  const input = args.input ?? process.stdin;
  const interactive = Boolean((input as any).isTTY && (output as any).isTTY);
  if (!interactive) {
    return false;
  }

  const items: ConfirmDialogItem[] = [
    {
      label: t("dialogConfirmAllowLabel"),
      detail: t("dialogConfirmAllowDetail"),
      value: true,
    },
    {
      label: t("dialogConfirmCancelLabel"),
      detail: t("dialogConfirmCancelDetail"),
      value: false,
    },
  ];

  // Build the title block as pre-rendered lines so the command can carry its
  // own danger color (renderDialogTitle wraps the whole string in one color
  // and cannot color a sub-line differently). Layout matches select/multi:
  // label line, then body, then the command (if any), then the key hint.
  //
  // PermissionRequest is a generic type (any tool/action can raise one), so
  // only the known destructive-shell action gets the localized copy — that
  // one is worth translating because it is the request users actually hit,
  // and its request-side title/body are hardcoded Chinese. Every other action
  // renders its own title/body verbatim; hardcoding the shell wording here
  // would mislabel them.
  const isDestructiveShell = args.request.action === "destructive_shell_command";
  const titleText = isDestructiveShell
    ? t("dialogConfirmTitle")
    : args.request.title;
  const bodyText = isDestructiveShell
    ? t("dialogConfirmBody")
    : args.request.body;

  const terminalWidth =
    typeof (output as any).columns === "number" && (output as any).columns > 0
      ? (output as any).columns
      : FALLBACK_TERMINAL_WIDTH;

  const titleLines: string[] = [
    renderDialogTitle(`${titleText}  ${t("dialogConfirmHint")}`),
  ];
  if (bodyText) titleLines.push(renderDialogTitle(bodyText));
  if (args.request.command) {
    const shown = truncateCommand(args.request.command, terminalWidth);
    titleLines.push(renderDialogCommand(shown));
  }

  const result = await runSelectDialog({
    items,
    initialIndex: 1,
    titleLines,
    input,
    output,
    ...(args.readKey ? { readKey: args.readKey } : {}),
    ...(args.bottomAnchored ? { bottomAnchored: args.bottomAnchored } : {}),
    ...(args.bottomRow ? { bottomRow: args.bottomRow } : {}),
  });

  if (result.kind === "cancelled") {
    return false;
  }

  return (result.item as ConfirmDialogItem).value;
}
