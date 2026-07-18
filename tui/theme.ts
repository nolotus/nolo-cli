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
export type TuiThemeColors = Record<TuiThemeToken, PaletteEntry>;

export const THEME_PALETTES: Record<string, Record<TuiBrightness, TuiThemeColors>> = {
  trail: {
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
  },
  catppuccin: {
    light: {
      accent: { hex: "1E66F5", ansiFallback: "\x1b[34m" },
      chrome: { hex: "9CCFD8", ansiFallback: "\x1b[90m" },
      success: { hex: "40A02B", ansiFallback: "\x1b[32m" },
      warning: { hex: "DF8E1D", ansiFallback: "\x1b[33m" },
      info: { hex: "04A5E5", ansiFallback: "\x1b[36m" },
      danger: { hex: "D20F39", ansiFallback: "\x1b[31m" },
      muted: { hex: "7C7F93", ansiFallback: "\x1b[90m" },
    },
    dark: {
      accent: { hex: "89B4FA", ansiFallback: "\x1b[34m" }, // mocha blue
      chrome: { hex: "6C7086", ansiFallback: "\x1b[90m" },
      success: { hex: "A6E3A1", ansiFallback: "\x1b[32m" },
      warning: { hex: "F9E2AF", ansiFallback: "\x1b[33m" },
      info: { hex: "94E2D5", ansiFallback: "\x1b[36m" },
      danger: { hex: "F38BA8", ansiFallback: "\x1b[31m" },
      muted: { hex: "A6ADC8", ansiFallback: "\x1b[37m" },
    },
  },
  wave: {
    light: {
      accent: { hex: "4D699B", ansiFallback: "\x1b[34m" }, // ink blue
      chrome: { hex: "9E9B8E", ansiFallback: "\x1b[90m" },
      success: { hex: "6F894E", ansiFallback: "\x1b[32m" },
      warning: { hex: "836F4A", ansiFallback: "\x1b[33m" },
      info: { hex: "4D699B", ansiFallback: "\x1b[36m" },
      danger: { hex: "C84053", ansiFallback: "\x1b[31m" },
      muted: { hex: "716E61", ansiFallback: "\x1b[90m" },
    },
    dark: {
      accent: { hex: "7E9CD8", ansiFallback: "\x1b[34m" }, // crystalBlue
      chrome: { hex: "727169", ansiFallback: "\x1b[90m" },
      success: { hex: "98BB6C", ansiFallback: "\x1b[32m" },
      warning: { hex: "E6C384", ansiFallback: "\x1b[33m" },
      info: { hex: "7FB4CA", ansiFallback: "\x1b[36m" },
      danger: { hex: "E82424", ansiFallback: "\x1b[31m" },
      muted: { hex: "938AA9", ansiFallback: "\x1b[37m" },
    },
  },
  iris: {
    light: {
      accent: { hex: "5E6AD2", ansiFallback: "\x1b[34m" },
      chrome: { hex: "9E9AB5", ansiFallback: "\x1b[90m" },
      success: { hex: "16A34A", ansiFallback: "\x1b[32m" },
      warning: { hex: "D97706", ansiFallback: "\x1b[33m" },
      info: { hex: "5E6AD2", ansiFallback: "\x1b[36m" },
      danger: { hex: "E5484D", ansiFallback: "\x1b[31m" },
      muted: { hex: "6E6A8A", ansiFallback: "\x1b[90m" },
    },
    dark: {
      accent: { hex: "8B9CF4", ansiFallback: "\x1b[34m" },
      chrome: { hex: "5A5772", ansiFallback: "\x1b[90m" },
      success: { hex: "26BD6C", ansiFallback: "\x1b[32m" },
      warning: { hex: "F5A623", ansiFallback: "\x1b[33m" },
      info: { hex: "8B9CF4", ansiFallback: "\x1b[36m" },
      danger: { hex: "EC5B6E", ansiFallback: "\x1b[31m" },
      muted: { hex: "938AA9", ansiFallback: "\x1b[37m" },
    },
  },
  rose: {
    light: {
      accent: { hex: "D14D72", ansiFallback: "\x1b[35m" },
      chrome: { hex: "9893A5", ansiFallback: "\x1b[90m" },
      success: { hex: "56949F", ansiFallback: "\x1b[32m" },
      warning: { hex: "EA9D34", ansiFallback: "\x1b[33m" },
      info: { hex: "286983", ansiFallback: "\x1b[36m" },
      danger: { hex: "B4637A", ansiFallback: "\x1b[31m" },
      muted: { hex: "797593", ansiFallback: "\x1b[90m" },
    },
    dark: {
      accent: { hex: "EB6F92", ansiFallback: "\x1b[35m" },
      chrome: { hex: "6E6A86", ansiFallback: "\x1b[90m" },
      success: { hex: "9CCFD8", ansiFallback: "\x1b[32m" },
      warning: { hex: "F6C177", ansiFallback: "\x1b[33m" },
      info: { hex: "C4A7E7", ansiFallback: "\x1b[36m" },
      danger: { hex: "EB6F92", ansiFallback: "\x1b[31m" },
      muted: { hex: "908CAA", ansiFallback: "\x1b[37m" },
    },
  },
  mono: {
    light: {
      accent: { hex: "FF9500", ansiFallback: "\x1b[33m" },
      chrome: { hex: "9DA6AF", ansiFallback: "\x1b[90m" },
      success: { hex: "16A34A", ansiFallback: "\x1b[32m" },
      warning: { hex: "D97706", ansiFallback: "\x1b[33m" },
      info: { hex: "2563EB", ansiFallback: "\x1b[34m" },
      danger: { hex: "DC2626", ansiFallback: "\x1b[31m" },
      muted: { hex: "7B8793", ansiFallback: "\x1b[90m" },
    },
    dark: {
      accent: { hex: "FFBF66", ansiFallback: "\x1b[33m" },
      chrome: { hex: "7B8793", ansiFallback: "\x1b[90m" },
      success: { hex: "4DE800", ansiFallback: "\x1b[32m" },
      warning: { hex: "FCD34D", ansiFallback: "\x1b[33m" },
      info: { hex: "60A5FA", ansiFallback: "\x1b[34m" },
      danger: { hex: "F87171", ansiFallback: "\x1b[31m" },
      muted: { hex: "C1C7CD", ansiFallback: "\x1b[37m" },
    },
  },
};

let activeThemeName = "trail";

export function getActiveThemeName(): string {
  return activeThemeName;
}

export function setActiveThemeName(name: string): boolean {
  if (THEME_PALETTES[name]) {
    activeThemeName = name;
    return true;
  }
  return false;
}

export type TuiDensity = "cozy" | "spacious";

let activeDensity: TuiDensity = "spacious";

export function getActiveDensity(): TuiDensity {
  return activeDensity;
}

export function setActiveDensity(density: TuiDensity) {
  activeDensity = density;
}

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
  const palette = THEME_PALETTES[activeThemeName] ?? THEME_PALETTES.trail;
  const entry = palette[brightness][token];
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