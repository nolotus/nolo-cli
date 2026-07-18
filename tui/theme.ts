import { resolveCliColorEnabled } from "../client/terminalStyles";

/**
 * TUI color tokens mirroring the app theme system.
 *
 * Source of truth: packages/app/theme/colors.ts (catppuccin, the default
 * theme). The published nolo-cli package cannot import packages/app, so the
 * hex values are mirrored here — keep them in sync when the default theme
 * changes. Terminals without truecolor fall back to the nearest ANSI-16 code.
 */
const TUI_THEME = {
  /** catppuccin.light.primary — brand accent for chips/highlights. */
  accent: { hex: "1E66F5", ansiFallback: "\x1b[34m" },
  /** catppuccin.light.textQuaternary — quiet chrome like dividers. */
  chrome: { hex: "9799A4", ansiFallback: "\x1b[90m" },
} as const;

export type TuiThemeToken = keyof typeof TUI_THEME;

export function supportsTruecolor(env: Record<string, string | undefined> = process.env) {
  return /truecolor|24bit/i.test(env.COLORTERM ?? "");
}

function hexToSgr(hex: string): string {
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function themeColorSequence(
  token: TuiThemeToken,
  env: Record<string, string | undefined> = process.env,
): string {
  const entry = TUI_THEME[token];
  return supportsTruecolor(env) ? hexToSgr(entry.hex) : entry.ansiFallback;
}

export function themeText(
  text: string,
  token: TuiThemeToken,
  colorEnabled = resolveCliColorEnabled(),
): string {
  if (!colorEnabled) return text;
  return `${themeColorSequence(token)}${text}\x1b[39m`;
}
