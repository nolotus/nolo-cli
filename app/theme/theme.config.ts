import {
  trail,
  iris,
  wave,
  rose,
  ember,
  catppuccin,
  // legacy theme objects kept for alias references
  neutral, ocean, forest,
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

// 2. 主题色系（6 个核心 — 每个覆盖一个画像，无冗余）
export const THEME_COLORS = {
  catppuccin, trail, wave, iris, rose, ember,
};

// 3. 旧主题名 → 保留主题的映射（DB 中可能存了旧 key）
export const THEME_NAME_ALIASES = {
  // 原核心主题被精简
  ocean: "catppuccin",
  forest: "wave",
  neutral: "catppuccin",
  // 原向后兼容 alias
  blue: "catppuccin",
  purple: "iris",
  green: "wave",
  orange: "ember",
  yellow: "ember",
  graphite: "catppuccin",
  pink: "rose",
  red: "ember",
  mocha: "catppuccin",
} as const;

export const DEFAULT_THEME_NAME = "catppuccin" as const;

