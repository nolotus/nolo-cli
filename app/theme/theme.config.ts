import {
  neutral,
  trail,
  ocean,
  iris,
  forest,
  wave,
  rose,
  ember,
  catppuccin,
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
  neutral, trail, ocean, iris, forest, wave, rose, ember, catppuccin,
  // alias — DB 中可能存了旧 key，映射到最近似的新主题
  blue, purple, green, orange, yellow, graphite, pink, red, mocha,
};

export const THEME_NAME_ALIASES = {
  blue: "catppuccin",
  ocean: "catppuccin",
  purple: "iris",
  green: "forest",
  orange: "ember",
  yellow: "ember",
  graphite: "neutral",
  pink: "rose",
  red: "ember",
  mocha: "catppuccin",
} as const;

export const DEFAULT_THEME_NAME = "catppuccin" as const;

