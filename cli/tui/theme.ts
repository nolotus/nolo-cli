import { resolveCliColorEnabled } from "../client/terminalStyles";

/**
 * TUI color tokens mirroring the app theme system.
 *
 * Source of truth: packages/app/theme/colors.ts (trail, the default
 * theme). The published nolo-cli package cannot import packages/app, so the
 * hex values are mirrored here — keep them in sync when the default theme
 * changes. Terminals without truecolor fall back to the nearest ANSI-16 code.
 *
 * Intentional divergence: a few trail tokens (light chrome/muted/warning, dark
 * muted) are tuned darker/dimmer than the app values they mirror. The app uses
 * those hexes for placeholder-grade text; the TUI uses the same tokens for
 * rules, tool labels and secondary body text, which need more contrast than a
 * placeholder. Light chrome/muted were nudged one more step (2026-07-27) after
 * owner feedback that trail light was comfortable but a touch washed out.
 * Light warning was deepened further (B57F2E → 9A6A1F, 2026-07-29) after owner
 * feedback that H2 headers (## Plan) looked yellow and floated off the white
 * background; muted was nudged denser (687584 → 5E6A78) so inline code in dense
 * prose stopped reading as a wash of saturated blue.
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
      chrome: { hex: "768594", ansiFallback: "\x1b[90m" }, // slate — two steps below app placeholder A3B0BD (was 8A97A5); rules/tool markers on white need the extra notch
      success: { hex: "3F8F5C", ansiFallback: "\x1b[32m" }, // moss green
      warning: { hex: "9A6A1F", ansiFallback: "\x1b[33m" }, // deeper amber — B57F2E still read as yellow/washed on white (H2 headers like ## Plan floated); 9A6A1F raises contrast
      info: { hex: "4A9FD4", ansiFallback: "\x1b[36m" }, // sky blue
      danger: { hex: "C45C4A", ansiFallback: "\x1b[31m" }, // reddish
      muted: { hex: "5E6A78", ansiFallback: "\x1b[90m" }, // denser slate — 687584 read too blue in dense prose (inline code/tool labels); 5E6A78 pulls blue down while staying darker than the old value
    },
    dark: {
      accent: { hex: "89B4FA", ansiFallback: "\x1b[34m" }, // blue
      chrome: { hex: "6C7086", ansiFallback: "\x1b[90m" },
      success: { hex: "A6E3A1", ansiFallback: "\x1b[32m" },
      warning: { hex: "F9E2AF", ansiFallback: "\x1b[33m" },
      info: { hex: "94E2D5", ansiFallback: "\x1b[36m" },
      danger: { hex: "F38BA8", ansiFallback: "\x1b[31m" },
      muted: { hex: "9AA3B8", ansiFallback: "\x1b[90m" }, // dimmed from A6ADC8 so secondary text sits a step below body text
    },
  },
  catppuccin: {
    light: {
      accent: { hex: "0969DA", ansiFallback: "\x1b[34m" },
      chrome: { hex: "57606A", ansiFallback: "\x1b[90m" },
      success: { hex: "116329", ansiFallback: "\x1b[32m" },
      warning: { hex: "9A6700", ansiFallback: "\x1b[33m" },
      info: { hex: "0969DA", ansiFallback: "\x1b[36m" },
      danger: { hex: "CF222E", ansiFallback: "\x1b[31m" },
      muted: { hex: "6E7781", ansiFallback: "\x1b[90m" },
    },
    dark: {
      accent: { hex: "58A6FF", ansiFallback: "\x1b[34m" }, // GitHub sky blue
      chrome: { hex: "6E7681", ansiFallback: "\x1b[90m" },
      success: { hex: "3FB950", ansiFallback: "\x1b[32m" },
      warning: { hex: "D29922", ansiFallback: "\x1b[33m" },
      info: { hex: "58A6FF", ansiFallback: "\x1b[36m" },
      danger: { hex: "FF7B72", ansiFallback: "\x1b[31m" },
      muted: { hex: "B1BAC4", ansiFallback: "\x1b[90m" },
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
      muted: { hex: "938AA9", ansiFallback: "\x1b[90m" },
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
      muted: { hex: "938AA9", ansiFallback: "\x1b[90m" },
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
      muted: { hex: "908CAA", ansiFallback: "\x1b[90m" },
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
      muted: { hex: "C1C7CD", ansiFallback: "\x1b[90m" },
    },
  },
};

let activeThemeName = "catppuccin";

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

/**
 * Brightness chosen at runtime — by the OSC 11 background probe at startup or
 * by `/theme light|dark`. Null means "nothing decided yet", so resolution falls
 * through to the COLORFGBG heuristic and finally the "dark" default.
 */
let activeBrightness: TuiBrightness | null = null;

export function getActiveBrightness(): TuiBrightness | null {
  return activeBrightness;
}

export function setActiveBrightness(brightness: TuiBrightness | null) {
  activeBrightness = brightness;
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

  // A value set by /theme light|dark or by the startup OSC 11 probe. It sits
  // below the env override (an explicit export still wins) but above the
  // COLORFGBG guess, which almost no terminal actually emits — the empty
  // COLORFGBG fallthrough to "dark" is what painted the dark palette's pastels
  // onto light backgrounds and made the whole UI look washed out.
  if (activeBrightness) return activeBrightness;

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

/**
 * Chip background per theme. Kept out of TuiThemeToken on purpose: those tokens
 * are foreground colors consumed by themeText, and a "surface" entry there
 * would be a token whose ANSI-16 fallback cannot express what it means.
 *
 * Each value is a low-contrast wash against that brightness's terminal
 * background — enough to read as a chip, not enough to fight the text.
 */
const SURFACE_HEX: Record<string, Record<TuiBrightness, string>> = {
  trail: { light: "E4E8EC", dark: "313244" },
  catppuccin: { light: "E8ECF0", dark: "161B22" },
  wave: { light: "E5E1D6", dark: "2A2A37" },
  iris: { light: "E9E8F2", dark: "2A2740" },
  rose: { light: "F2EAE4", dark: "26233A" },
  mono: { light: "E8EAED", dark: "2A2A2A" },
};

const TERMINAL_BASE: Record<TuiBrightness, string> = {
  dark: "1E1E2E",
  light: "FFFFFF",
};

/** Parse a 6-digit hex channel triple, or null when the input isn't one. */
function readHexChannels(hex: string): [number, number, number] | null {
  if (!/^[0-9A-F]{6}$/.test(hex)) return null;
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

/** `\x1b[48;2;…m` background SGR for a 6-digit hex, or "" if it isn't one. */
function hexToBgSgr(hex: string): string {
  const channels = readHexChannels(hex.replace(/^#/, "").toUpperCase());
  if (!channels) return "";
  const [r, g, b] = channels;
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * 把 fg 按 weight(0..1) 混合到 base 上，返回 6 位大写 hex（不带 #）。
 *
 * Malformed input falls back to `base` rather than producing channel NaNs: this
 * is exported, and `Math.round(NaN).toString(16)` yields the literal "NaN",
 * which would silently ship an `\x1b[48;2;NaN;…m` sequence to the terminal.
 */
export function blendHex(fg: string, base: string, weight: number): string {
  const w = Math.min(1, Math.max(0, weight));
  const normFg = fg.replace(/^#/, "").toUpperCase();
  const normBase = base.replace(/^#/, "").toUpperCase();
  if (w === 0) return normBase;
  if (w === 1) return normFg;
  if (!readHexChannels(normFg) || !readHexChannels(normBase)) return normBase;
  const fgR = Number.parseInt(normFg.slice(0, 2), 16);
  const fgG = Number.parseInt(normFg.slice(2, 4), 16);
  const fgB = Number.parseInt(normFg.slice(4, 6), 16);
  const baseR = Number.parseInt(normBase.slice(0, 2), 16);
  const baseG = Number.parseInt(normBase.slice(2, 4), 16);
  const baseB = Number.parseInt(normBase.slice(4, 6), 16);
  const r = Math.round(baseR + (fgR - baseR) * w).toString(16).padStart(2, "0").toUpperCase();
  const g = Math.round(baseG + (fgG - baseG) * w).toString(16).padStart(2, "0").toUpperCase();
  const b = Math.round(baseB + (fgB - baseB) * w).toString(16).padStart(2, "0").toUpperCase();
  return `${r}${g}${b}`;
}

export type DiffLineSequence = { fg: string; bg: string };

export function diffLineSequences(
  env: Record<string, string | undefined> = process.env,
  brightness: TuiBrightness = resolveTuiBrightness(env),
): { added: DiffLineSequence; removed: DiffLineSequence } | null {
  if (!supportsTruecolor(env)) return null;

  const palette = THEME_PALETTES[activeThemeName] ?? THEME_PALETTES.trail;
  const successHex = palette[brightness].success.hex;
  const dangerHex = palette[brightness].danger.hex;

  const weight = brightness === "dark" ? 0.14 : 0.10;
  const baseHex = TERMINAL_BASE[brightness];

  const addedBgHex = blendHex(successHex, baseHex, weight);
  const removedBgHex = blendHex(dangerHex, baseHex, weight);

  return {
    added: {
      fg: hexToSgr(successHex),
      bg: hexToBgSgr(addedBgHex),
    },
    removed: {
      fg: hexToSgr(dangerHex),
      bg: hexToBgSgr(removedBgHex),
    },
  };
}

/**
 * Background SGR for the status chip, or "" when the terminal cannot render it
 * faithfully. ANSI-16 has no safe subtle background — the nearest options are
 * solid blocks that invert readability — so non-truecolor terminals get no
 * chip fill and fall back to plain separated segments.
 */
export function surfaceBackgroundSequence(
  env: Record<string, string | undefined> = process.env,
  brightness: TuiBrightness = resolveTuiBrightness(env),
): string {
  if (!supportsTruecolor(env)) return "";
  return hexToBgSgr((SURFACE_HEX[activeThemeName] ?? SURFACE_HEX.trail)[brightness]);
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

function renderDiffCodeBlock(
  code: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const border = themeText("│", "chrome", true, env);
  const addedColor = themeColorSequence("success", env);
  const deletedColor = themeColorSequence("danger", env);
  const hunkColor = themeColorSequence("info", env);
  const contextColor = themeColorSequence("chrome", env);
  const reset = "\x1b[0m";

  const lines = code.split("\n").map((line: string) => {
    let color = contextColor;
    if (line.startsWith("@@")) {
      color = hunkColor;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      color = addedColor;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      color = deletedColor;
    }
    return ` ${border}  ${color}${line}${reset}`;
  });

  return ` ${themeText("┌───", "chrome", true, env)}\n${lines.join("\n")}\n ${themeText("└───", "chrome", true, env)}`;
}

export function highlightMarkdown(
  text: string,
  colorEnabled = resolveCliColorEnabled(),
  env: Record<string, string | undefined> = process.env,
): string {
  if (!colorEnabled) return text;

  let result = text;

  // 1. Code blocks: ```[lang]\n([\s\S]*?)\n```
  result = result.replace(/```([a-zA-Z-]*)\n([\s\S]*?)\n```/g, (match, lang, code) => {
    if (lang.toLowerCase() === "diff") {
      return renderDiffCodeBlock(code, env);
    }
    const infoColor = themeColorSequence("info", env);
    const reset = "\x1b[39m\x1b[22m";
    const border = themeText("│", "chrome", true, env);

    const formattedCode = code
      .split("\n")
      .map((line: string) => ` ${border}  ${infoColor}${line}${reset}`)
      .join("\n");

    return ` ${themeText("┌───", "chrome", true, env)}\n${formattedCode}\n ${themeText("└───", "chrome", true, env)}`;
  });

  // 2. Headings: three-tier hierarchy matching the streaming renderer
  // (assistantOutput.ts styleRichMarkdownLine). Must run before bold/inline
  // so heading text isn't partially consumed by those patterns.
  //   H1 → accent + bold + underline
  //   H2 → warning + bold
  //   H3 → info + bold
  result = result.replace(/^(#{1,3})\s+(.+)$/gm, (match, hashes, title) => {
    const level = hashes.length;
    const reset = "\x1b[0m";
    if (level === 1) {
      return `\x1b[1m\x1b[4m${themeColorSequence("accent", env)}${title}${reset}`;
    }
    if (level === 2) {
      return `\x1b[1m${themeColorSequence("warning", env)}${title}${reset}`;
    }
    return `\x1b[1m${themeColorSequence("info", env)}${title}${reset}`;
  });

  // 2b. 状态行弱化：以"进入 nolo-plan"开头的整行 → chrome + dim。repo
  //     规范强制每条回复首句为该状态行，连续多条堆叠时噪声大。必须与
  //     assistantOutput.ts styleRichMarkdownLine 对齐（同一回复流式与
  //     历史重绘颜色不能跳变）。
  result = result.replace(
    /^(进入 nolo-plan[^\n]*)$/gm,
    (match, content) =>
      `${themeColorSequence("chrome", env)}\x1b[2m${content}\x1b[0m`
  );

  // 3. Blockquotes: "> text" → chrome left border + dimmed content
  result = result.replace(/^>\s?(.*)$/gm, (match, content) => {
    const border = themeColorSequence("chrome", env);
    return `${border}│\x1b[39m \x1b[2m${content}\x1b[22m`;
  });

  // 4. Bold text: **bold** -> \x1b[1mbold\x1b[22m
  result = result.replace(/\*\*([\s\S]*?)\*\*/g, "\x1b[1m$1\x1b[22m");

  // 5. Inline code: `code` -> muted, not info. Sharing the info hue with code
  // blocks made prose read as a wall of bright cyan; muted keeps identifiers
  // distinguishable while the block border carries the stronger accent.
  const mutedColor = themeColorSequence("muted", env);
  const reset = "\x1b[39m";
  result = result.replace(/`([^`\n]+)`/g, `${mutedColor}$1${reset}`);

  // 6. Italic + strikethrough: run after bold so ** is consumed first.
  //    *italic* -> dim; ~~strike~~ -> dim + strikethrough.
  //    Only `*italic*` is supported, NOT `_italic_`: CommonMark gives `_` an
  //    intra-word limitation (snake_case must not trigger italic) that needs a
  //    word-boundary guard. Agent output contains snake_case variables often;
  //    supporting `_italic_` would corrupt them. Must match styleInlineMarkdown
  //    in assistantOutput.ts (streaming path) so the same reply doesn't shift
  //    styling mid-scroll.
  result = result.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, `\x1b[2m$1\x1b[22m`);
  result = result.replace(/~~([^~\n]+?)~~/g, `\x1b[2m\x1b[9m$1\x1b[29m\x1b[22m`);

  return result;
}