import { resolveCliColorEnabled } from "../client/terminalStyles";
import { surfaceBackgroundSequence, themeColorSequence, themeText } from "./theme";

/**
 * Shared look for every dialog frame (single-select, multi-select).
 *
 * The two renderers grew independently and ended up structurally identical but
 * entirely unstyled, so pickers rendered as flat text while the rest of the TUI
 * was themed. Centralizing the row/title/overflow styling here keeps them from
 * drifting again and makes every dialog follow the active `/theme`.
 *
 * Color is opt-out via `resolveCliColorEnabled()`: piped or NO_COLOR output
 * degrades to the exact plain text these frames produced before.
 */

/** Cursor marker for the focused row; blank keeps non-focused rows aligned. */
export const DIALOG_CURSOR = "❯";
export const DIALOG_CHECKED = "◉";
export const DIALOG_UNCHECKED = "○";

export function renderDialogTitle(
  title: string,
  colorEnabled = resolveCliColorEnabled(),
): string {
  return themeText(title, "chrome", colorEnabled);
}

/**
 * One selectable row. The focused row reads as a selection bar — a
 * low-contrast surface fill behind accent foreground text — so the cursor is
 * findable at a glance instead of relying on the `❯` glyph alone. Terminals
 * without truecolor get accent + bold instead: ANSI-16 has no safe subtle
 * background (see surfaceBackgroundSequence), and a solid inverse block
 * would invert readability.
 */
export function renderDialogRow(
  args: {
    label: string;
    detail?: string;
    focused: boolean;
    /** Omitted for single-select; `◉`/`○` for multi-select. */
    checkbox?: string;
  },
  colorEnabled = resolveCliColorEnabled(),
): string {
  const marker = args.focused ? DIALOG_CURSOR : " ";
  const checkbox = args.checkbox ? `${args.checkbox} ` : "";
  const detail = args.detail
    ? `  ${themeText(args.detail, "muted", colorEnabled)}`
    : "";
  const row = `${marker} ${checkbox}${args.label}${detail}`;
  if (!args.focused || !colorEnabled) return row;
  return `${surfaceBackgroundSequence()}${themeColorSequence("accent")}\x1b[1m${row}\x1b[0m`;
}

/** "... N more above/below" affordance shown when the list is windowed. */
export function renderDialogOverflow(
  text: string,
  colorEnabled = resolveCliColorEnabled(),
): string {
  return themeText(`  ${text}`, "chrome", colorEnabled);
}

export function renderDialogError(
  message: string,
  colorEnabled = resolveCliColorEnabled(),
): string {
  return themeText(`  ! ${message}`, "danger", colorEnabled);
}

/**
 * The command a confirm dialog is asking the user to approve, drawn in the
 * danger token so it stands apart from the chrome title/body and the user
 * can read exactly what they are about to sign. `renderDialogCommand` is a
 * styling primitive only — truncation/labeling is the caller's job so the
 * same look applies whether the command came from execShell or elsewhere.
 */
export function renderDialogCommand(
  text: string,
  colorEnabled = resolveCliColorEnabled(),
): string {
  return themeText(`  ${text}`, "danger", colorEnabled);
}
