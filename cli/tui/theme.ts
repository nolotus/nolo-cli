import { resolveCliColorEnabled } from "../client/terminalStyles";

/**
 * TUI color tokens mirroring the app theme system.
 *
 * Source of truth: packages/app/theme/colors.ts (trail, the default
 * theme). The published nolo-cli package cannot import packages/app, so the
 * hex values are mirrored here — keep them in sync when the default theme
 * changes. Terminals without truecolor fall back to the nearest ANSI-16 code.
 */

/** Brightness of the terminal background — drives light/dark token selection. */
export type TuiBrightness = "light" | "dark";

export type TuiThemeToken =
  | "accent"
  | "chrome"
  | "success"
  | "warning"
  | "info"
  | "danger"
  | "muted";

type PaletteEntry = { hex: string; ansiFallback: string };

/**
 * Light = Trail Light, Dark = Trail Dark (see colors.ts).
 * ANSI-16 fallbacks are chosen so the hue family stays close across terminals.
 */
const TUI_THEME: Record<TuiBrightness, Record<TuiThemeToken, PaletteEntry>> = {
  light: {
    accent: { hex: "2E7DB5", ansiFallback: "\x1b[34m" }, // ocean blue
    chrome: { hex: "A3B0BD", ansiFallback: "\x1b[90m" }, // gray
    success: { hex: "3F8F5C", ansiFallback: "\x1b[32m" }, // moss green
    warning: { hex: "D4A054", ansiFallback: "\x1b[33m" }, // amber/orange
    info: { hex: "4A9FD4", ansiFallback: "\x1b[36m" }, // sky blue
    danger: { hex: "C45C4A", ansiFallback: "\x1b[31m" }, // reddish
    muted: { hex: "7A8796", ansiFallback: "\x1b[90m" }, // slate gray
  },
  dark: {
    accent: { hex: "89B4FA", ansiFallback: "\x1b[34m" }, // blue
    chrome: { hex: "6C7086", ansiFallback: "\x1b[90m" },
    success: { hex: "A6E3A1", ansiFallback: "\x1b[32m" },
    warning: { hex: "F9E2AF", ansiFallback: "\x1b[33m" },
    info: { hex: "94E2D5", ansiFallback: "\x1b[36m" },
    danger: { hex: "F38BA8", ansiFallback: "\x1b[31m" },
    muted: { hex: "A6ADC8", ansiFallback: "\x1b[37m" },
  },
};

export function supportsTruecolor(env: Record<string, string | undefined> = process.env) {
  return /truecolor|24bit/i.test(env.COLORTERM ?? "");
}

/**
 * Resolve the terminal background brightness.
 *
 * Strategy (first match wins):
 * 1. NOLO_TUI_THEME explicit override ("light" | "dark").
 * 2. COLORFGBG convention ("0;15" = light bg "15;0" = dark bg) — emitted by
 *    many terminals (Konsole, rxvt, some iTerm2/Ghostty configs).
 * 3. Default to "dark" — the most common developer terminal setting.
 */
export function resolveTuiBrightness(env: Record<string, string | undefined> = process.env): TuiBrightness {
  const explicit = (env.NOLO_TUI_THEME ?? "").trim().toLowerCase();
  if (explicit === "light") return "light";
  if (explicit === "dark") return "dark";

  const colorfgbg = env.COLORFGBG ?? "";
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    // COLORFGBG format is "fg;bg" — the background value (2nd field) determines
    // brightness: 0–6 = dark, 7–15 = light.
    const bg = parts.length > 1 ? Number.parseInt(parts[1] ?? "", 10) : NaN;
    if (!Number.isNaN(bg) && bg >= 0 && bg <= 6) return "dark";
    if (!Number.isNaN(bg) && bg >= 7 && bg <= 15) return "light";
  }

  return "dark";
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
  brightness: TuiBrightness = resolveTuiBrightness(env),
): string {
  const entry = TUI_THEME[brightness][token];
  return supportsTruecolor(env) ? hexToSgr(entry.hex) : entry.ansiFallback;
}

export function themeText(
  text: string,
  token: TuiThemeToken,
  colorEnabled = resolveCliColorEnabled(),
  env: Record<string, string | undefined> = process.env,
): string {
  if (!colorEnabled) return text;
  return `${themeColorSequence(token, env)}${text}\x1b[39m`;
}

export function highlightMarkdown(
  text: string,
  colorEnabled = resolveCliColorEnabled(),
  env: Record<string, string | undefined> = process.env,
): string {
  if (!colorEnabled) return text;

  let result = text;

  // 1. Code blocks: ```[lang]\n([\s\S]*?)\n```
  result = result.replace(/```[a-zA-Z-]*\n([\s\S]*?)\n```/g, (match, code) => {
    const infoColor = themeColorSequence("info", env);
    const reset = "\x1b[39m\x1b[22m";
    const border = themeText("│", "chrome", true, env);

    const formattedCode = code
      .split("\n")
      .map((line: string) => ` ${border}  ${infoColor}${line}${reset}`)
      .join("\n");

    return ` ${themeText("┌───", "chrome", true, env)}\n${formattedCode}\n ${themeText("└───", "chrome", true, env)}`;
  });

  // 2. Bold text: **bold** -> \x1b[1mbold\x1b[22m
  result = result.replace(/\*\*([\s\S]*?)\*\*/g, "\x1b[1m$1\x1b[22m");

  // 3. Inline code: `code` -> wrapped in info color
  const infoColor = themeColorSequence("info", env);
  const reset = "\x1b[39m";
  result = result.replace(/`([^`\n]+)`/g, `${infoColor}$1${reset}`);

  return result;
}