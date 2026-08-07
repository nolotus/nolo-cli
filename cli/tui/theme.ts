import { resolveCliColorEnabled } from "../client/terminalStyles";
import { displayWidth } from "./tuiAnsi";

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
      accent: { hex: "89B4FA", ansiFallback: "\x1b[34m" }, // Catppuccin Mocha Blue
      chrome: { hex: "6C7086", ansiFallback: "\x1b[90m" },
      success: { hex: "A6E3A1", ansiFallback: "\x1b[32m" },
      warning: { hex: "F9E2AF", ansiFallback: "\x1b[33m" },
      info: { hex: "89B4FA", ansiFallback: "\x1b[36m" },
      danger: { hex: "F38BA8", ansiFallback: "\x1b[31m" },
      muted: { hex: "A6ADC8", ansiFallback: "\x1b[90m" },
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

const TRUECOLOR_TERM_PROGRAMS = new Set([
  "iterm.app",
  "wezterm",
  "ghostty",
  "vscode",
  "hyper",
  "tabby",
  "rio",
  "warpterminal",
]);

/**
 * Truecolor support detection.
 *
 * COLORTERM is the canonical signal but a lot of terminals don't set it
 * (tmux, some SSH setups, VS Code's integrated terminal), which silently
 * dropped every background-tinted surface in the TUI. TERM_PROGRAM is the
 * reliable second signal. Apple_Terminal is deliberately excluded: it is a
 * 256-color terminal and would approximate 24-bit SGR into the wrong hue.
 */
export function supportsTruecolor(env: Record<string, string | undefined> = process.env) {
  const explicit = (env.NOLO_TUI_TRUECOLOR ?? "").trim().toLowerCase();
  if (explicit === "1" || explicit === "true") return true;
  if (explicit === "0" || explicit === "false") return false;
  if (/truecolor|24bit/i.test(env.COLORTERM ?? "")) return true;
  if (/direct|24bit/i.test(env.TERM ?? "")) return true;
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();
  return TRUECOLOR_TERM_PROGRAMS.has(program);
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
  catppuccin: { light: "E8ECF0", dark: "181825" },
  wave: { light: "E5E1D6", dark: "2A2A37" },
  iris: { light: "E9E8F2", dark: "2A2740" },
  rose: { light: "F2EAE4", dark: "26233A" },
  mono: { light: "E8EAED", dark: "2A2A2A" },
};

const TERMINAL_BASE: Record<TuiBrightness, string> = {
  dark: "1E1E2E",
  light: "FFFFFF",
};

/**
 * Real terminal background hex, set from the OSC 11 probe result. Null means
 * "no probe result", so resolution falls back to TERMINAL_BASE. Kept as raw
 * hex (no ANSI) — callers render it through hexToBgSgr/blendHex.
 */
let activeTerminalBaseHex: string | null = null;

/** Record the terminal's actual background hex, or clear it with null. */
export function setActiveTerminalBaseHex(hex: string | null) {
  if (hex === null) {
    activeTerminalBaseHex = null;
    return;
  }
  // Validate before storing: a dirty value would flow into blendHex and emit
  // NaN SGR channels. readHexChannels requires uppercase, so normalize first.
  activeTerminalBaseHex = readHexChannels(hex.replace(/^#/, "").toUpperCase())
    ? hex.replace(/^#/, "").toUpperCase()
    : null;
}

export function getActiveTerminalBaseHex(): string | null {
  return activeTerminalBaseHex;
}

/**
 * Record a freshly detected terminal background (brightness + exact base hex)
 * and report whether anything changed. Single source of truth shared by the
 * manual `/theme refresh` command and the auto-follow poller, so the two never
 * drift. Returns true when a repaint is warranted (brightness or exact color
 * changed), false when the terminal already matched.
 */
export function applyDetectedBackground(detected: {
  brightness: TuiBrightness;
  hex: string;
}): boolean {
  // Normalize before comparing against the stored base (uppercase, no '#');
  // keeps a lower-case / '#'-prefixed input from re-triggering every poll.
  const normalizedHex = detected.hex.replace(/^#/, "").toUpperCase();
  const changed =
    detected.brightness !== activeBrightness ||
    normalizedHex !== activeTerminalBaseHex;
  setActiveBrightness(detected.brightness);
  setActiveTerminalBaseHex(detected.hex);
  return changed;
}

/** Base hex for a brightness: the probed terminal color, or the fallback. */
function resolveTerminalBaseHex(brightness: TuiBrightness): string {
  return activeTerminalBaseHex ?? TERMINAL_BASE[brightness];
}

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

export type DiffLineKind = "added" | "removed" | "context" | "hunk";
export type DiffLineSequence = { fg: string; bg: string; bar: string };

export function diffLineSequences(
  env: Record<string, string | undefined> = process.env,
  brightness: TuiBrightness = resolveTuiBrightness(env),
): Record<DiffLineKind, DiffLineSequence> | null {
  if (!supportsTruecolor(env)) return null;

  const palette = THEME_PALETTES[activeThemeName] ?? THEME_PALETTES.trail;
  const successHex = palette[brightness].success.hex;
  const dangerHex = palette[brightness].danger.hex;
  const infoHex = palette[brightness].info.hex;

  const weight = brightness === "dark" ? 0.18 : 0.12;
  const baseHex = resolveTerminalBaseHex(brightness);

  const addedBgHex = blendHex(successHex, baseHex, weight);
  const removedBgHex = blendHex(dangerHex, baseHex, weight);
  const hunkBgHex = blendHex(infoHex, baseHex, weight * 0.6);

  const successSgr = hexToSgr(successHex);
  const dangerSgr = hexToSgr(dangerHex);
  const infoSgr = hexToSgr(infoHex);

  return {
    added: {
      fg: successSgr,
      bg: hexToBgSgr(addedBgHex),
      bar: `${successSgr}▌\x1b[39m`,
    },
    removed: {
      fg: dangerSgr,
      bg: hexToBgSgr(removedBgHex),
      bar: `${dangerSgr}▌\x1b[39m`,
    },
    hunk: {
      fg: infoSgr,
      bg: hexToBgSgr(hunkBgHex),
      bar: " ",
    },
    context: { fg: "", bg: "", bar: " " },
  };
}

/**
 * Render one diff line as a Zed-style band: left color bar + tinted full-width
 * background + colored text.
 *
 * `padTo` is the block's widest line, NOT the terminal width. Padding to the
 * terminal width fights wrapTranscriptLine (which wraps at columns-1, so every
 * line would wrap one extra time), breaks on resize because the string is
 * already fixed, and leaves trailing spaces when the user copies the output.
 * A block-local rectangle reads the same and stays resize-safe.
 */
export function renderDiffLine(args: {
  kind: DiffLineKind;
  /** Full line text INCLUDING its +/-/@@ prefix. */
  text: string;
  /** Display width to pad the tint to. Omit for no padding. */
  padTo?: number;
  env?: Record<string, string | undefined>;
  colorEnabled?: boolean;
}): string {
  const { kind, text } = args;
  const env = args.env ?? process.env;
  const colorEnabled = args.colorEnabled ?? resolveCliColorEnabled();
  if (!colorEnabled) return text;

  const seqs = diffLineSequences(env);
  if (!seqs) {
    // Degraded terminal: foreground color only, no background, no bar.
    if (kind === "context") return text;
    const token: TuiThemeToken =
      kind === "added" ? "success" : kind === "removed" ? "danger" : "info";
    return `${themeColorSequence(token, env)}${text}\x1b[39m`;
  }

  const seq = seqs[kind];
  const padding =
    args.padTo === undefined
      ? ""
      : " ".repeat(Math.max(0, args.padTo - displayWidth(text)));
  // \x1b[0m resets both fg and bg so the tint never leaks to the next line.
  return `${seq.bar}${seq.bg}${seq.fg}${text}${padding}\x1b[0m`;
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

/**
 * Classify one diff fence line. Shared by the streaming highlighter
 * (assistantOutput.ts highlightCodeLine) so streamed and history-redraw paths
 * paint identically. `+++` / `---` file headers are context, not added/removed.
 */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "added";
  if (line.startsWith("-") && !line.startsWith("---")) return "removed";
  return "context";
}
