import {
  neutral,
  trail,
  ocean,
  iris,
  forest,
  wave,
  rose,
  ember,
  // backward compat aliases
  blue, purple, green, orange, yellow, graphite, pink, red, mocha,
} from "./colors";

/**
 * 包含所有静态主题配置，包括间距、主题色、基础底色。
 * settingSlice 用这些常量动态构建当前主题。
 */

// 1. 空间尺寸系统
export const SPACE = {
  0: "0",
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "20px",
  6: "24px",
  7: "28px",
  8: "32px",
  10: "40px",
  12: "48px",
  14: "56px",
  16: "64px",
  20: "80px",
  24: "96px",
};

// 2. 主题色系（8 个核心 + 向后兼容 alias）
export const THEME_COLORS = {
  neutral, trail, ocean, iris, forest, wave, rose, ember,
  // alias — DB 中可能存了旧 key，映射到最近似的新主题
  blue, purple, green, orange, yellow, graphite, pink, red, mocha,
};

export const THEME_NAME_ALIASES = {
  blue: "ocean",
  purple: "iris",
  green: "forest",
  orange: "ember",
  yellow: "ember",
  graphite: "neutral",
  pink: "rose",
  red: "ember",
  mocha: "rose",
} as const;

export const DEFAULT_THEME_NAME = "ocean" as const;

// 3. 基础底色 — 纯中性 zinc/slate，无冷暖偏向
// 主题通过 surface 字段覆盖这些值，获得完整主题体验（如 wave = Kanagawa）
export const BASE_COLORS = {
  light: {
    background:          "#FFFFFF",
    backgroundSecondary: "#F4F4F5",   // zinc-100
    backgroundTertiary:  "#E4E4E7",   // zinc-200
    backgroundGhost:     "rgba(255, 255, 255, 0.94)",
    backgroundHover:     "#D4D4D8",   // zinc-300
    backgroundSelected:  "#A1A1AA",   // zinc-400

    text:                "#18181B",   // zinc-900
    textSecondary:       "#52525B",   // zinc-600
    textTertiary:        "#71717A",   // zinc-500
    textQuaternary:      "#A1A1AA",   // zinc-400
    textLight:           "#D4D4D8",   // zinc-300
    placeholder:         "#A1A1AA",   // zinc-400

    border:              "#E4E4E7",   // zinc-200
    borderHover:         "#A1A1AA",   // zinc-400
    borderLight:         "#F4F4F5",   // zinc-100

    error: "#DC2626",

    shadowLight:  "rgba(0, 0, 0, 0.04)",
    shadowMedium: "rgba(0, 0, 0, 0.08)",
    shadowHeavy:  "rgba(0, 0, 0, 0.14)",

    messageBackground: "#FFFFFF",
    codeBackground:    "#F4F4F5",
  },
  dark: {
    background:          "#18181B",   // zinc-900
    backgroundSecondary: "#27272A",   // zinc-800
    backgroundTertiary:  "#3F3F46",   // zinc-700
    backgroundGhost:     "rgba(24, 24, 27, 0.94)",
    backgroundHover:     "#52525B",   // zinc-600
    backgroundSelected:  "#3F3F46",   // zinc-700

    text:                "#FAFAFA",   // zinc-50
    textSecondary:       "#D4D4D8",   // zinc-300
    textTertiary:        "#A1A1AA",   // zinc-400
    textQuaternary:      "#71717A",   // zinc-500
    textLight:           "#52525B",   // zinc-600
    placeholder:         "#71717A",   // zinc-500

    border:              "#3F3F46",   // zinc-700
    borderHover:         "#71717A",   // zinc-500
    borderLight:         "#27272A",   // zinc-800

    error: "#F87171",

    shadowLight:  "rgba(0, 0, 0, 0.16)",
    shadowMedium: "rgba(0, 0, 0, 0.28)",
    shadowHeavy:  "rgba(0, 0, 0, 0.40)",

    messageBackground: "#27272A",
    codeBackground:    "#09090B",     // zinc-950
  },
};

// 向后兼容 — settingSlice 中的旧引用
export const MODE_COLORS = BASE_COLORS;
