// app/theme/colors.ts
// 9 个主题，每个都有完整 surface 覆盖，切换主题"气质全变"。

// ─── 公共语义色 ─────────────────────────────────────────────────────────────
const semantic = {
  light: { success: "#16A34A", warning: "#D97706", info: "#2563EB", error: "#DC2626" },
  dark:  { success: "#4ADE80", warning: "#FCD34D", info: "#60A5FA", error: "#F87171" },
};

// ─── surface 工厂：避免每个主题重复写影子/ghost/messageBackground ──────────
const mkLight = (bg: string, bg2: string, bg3: string, textPrimary: string, textSec: string, textTer: string, border: string, borderL: string) => ({
  background: bg, backgroundSecondary: bg2, backgroundTertiary: bg3,
  backgroundGhost: bg + "F0",
  backgroundHover: bg3, backgroundSelected: border,
  backgroundElevated: bg2,
  text: textPrimary, textSecondary: textSec, textTertiary: textTer,
  textQuaternary: textTer + "99", textLight: border, placeholder: textTer,
  border, borderLight: borderL, borderHover: textTer,
  messageBackground: bg2, codeBackground: bg3,
  shadowLight:  `rgba(0,0,0,0.04)`, shadowMedium: `rgba(0,0,0,0.08)`, shadowHeavy: `rgba(0,0,0,0.14)`,
  textOnPrimary: "#FFFFFF",
});

const mkDark = (bg: string, bg2: string, bg3: string, textPrimary: string, textSec: string, textTer: string, border: string, borderL: string, shadowBase = "0,0,0") => ({
  background: bg, backgroundSecondary: bg2, backgroundTertiary: bg3,
  backgroundGhost: bg2 + "F0",
  backgroundHover: bg3, backgroundSelected: border,
  backgroundElevated: bg3,
  text: textPrimary, textSecondary: textSec, textTertiary: textTer,
  textQuaternary: textTer + "88", textLight: border, placeholder: textTer,
  border, borderLight: borderL, borderHover: textTer,
  messageBackground: bg2, codeBackground: bg2,
  shadowLight:  `rgba(${shadowBase},0.18)`, shadowMedium: `rgba(${shadowBase},0.30)`, shadowHeavy: `rgba(${shadowBase},0.44)`,
  textOnPrimary: "#FFFFFF",
});

// ─── 1. Neutral — zinc，无主张 ──────────────────────────────────────────────
export const neutral = {
  light: { primary: "#71717A", primaryLight: "#A1A1AA", primaryDark: "#52525B",
    primaryGradient: "linear-gradient(135deg, #71717A, #A1A1AA)",
    primaryGhost: "rgba(113,113,122,0.08)", primaryHover: "rgba(113,113,122,0.10)",
    borderAccent: "#D4D4D8", ...semantic.light,
    ...mkLight("#FFFFFF", "#F4F4F5", "#E4E4E7", "#18181B", "#52525B", "#71717A", "#E4E4E7", "#F4F4F5"),
  },
  dark: { primary: "#A1A1AA", primaryLight: "#D4D4D8", primaryDark: "#71717A",
    primaryGradient: "linear-gradient(135deg, #A1A1AA, #D4D4D8)",
    primaryGhost: "rgba(161,161,170,0.10)", primaryHover: "rgba(161,161,170,0.12)",
    borderAccent: "#52525B", ...semantic.dark,
    ...mkDark("#18181B", "#27272A", "#3F3F46", "#FAFAFA", "#D4D4D8", "#A1A1AA", "#3F3F46", "#27272A", "24,24,27"),
    textOnPrimary: "#18181B",
  },
};

// ─── 2. Ocean — GitHub 风格深蓝，干净可信 ─────────────────────────────────
export const ocean = {
  light: {
    primary: "#0969DA", primaryLight: "#218BFF", primaryDark: "#0550AE",
    primaryGradient: "linear-gradient(135deg, #0969DA, #218BFF)",
    primaryGhost: "rgba(9,105,218,0.08)", primaryHover: "rgba(9,105,218,0.10)",
    borderAccent: "#54AEFF", ...semantic.light,
    ...mkLight("#FFFFFF", "#F6F8FA", "#EBF0F4", "#1C2128", "#57606A", "#6E7781", "#D0D7DE", "#F6F8FA"),
  },
  dark: {
    primary: "#58A6FF", primaryLight: "#79C0FF", primaryDark: "#388BFD",
    primaryGradient: "linear-gradient(135deg, #58A6FF, #79C0FF)",
    primaryGhost: "rgba(88,166,255,0.10)", primaryHover: "rgba(88,166,255,0.12)",
    borderAccent: "#1F6FEB", ...semantic.dark,
    ...mkDark("#0D1117", "#161B22", "#21262D", "#E6EDF3", "#8B949E", "#6E7681", "#30363D", "#161B22", "13,17,23"),
    textHeading: "#E6EDF3",
    textOnPrimary: "#0D1117",
  },
};

// ─── 3. Iris — Linear 签名色，精致紫蓝 ────────────────────────────────────
export const iris = {
  light: {
    primary: "#5E6AD2", primaryLight: "#8B9CF4", primaryDark: "#4A55C0",
    primaryGradient: "linear-gradient(135deg, #5E6AD2, #8B9CF4)",
    primaryGhost: "rgba(94,106,210,0.08)", primaryHover: "rgba(94,106,210,0.10)",
    borderAccent: "#8B9CF4", ...semantic.light,
    ...mkLight("#FFFFFF", "#F7F6FF", "#EEEDFA", "#1A1730", "#4E4B6B", "#7874A0", "#D8D6F0", "#F7F6FF"),
  },
  dark: {
    primary: "#8B9CF4", primaryLight: "#ADB5F7", primaryDark: "#5E6AD2",
    primaryGradient: "linear-gradient(135deg, #8B9CF4, #ADB5F7)",
    primaryGhost: "rgba(139,156,244,0.10)", primaryHover: "rgba(139,156,244,0.12)",
    borderAccent: "#4A55C0", ...semantic.dark,
    ...mkDark("#0F0E17", "#16141F", "#1E1B2E", "#E8E5F7", "#A8A4C8", "#7B7698", "#272435", "#16141F", "15,14,23"),
    textHeading: "#E8E5F7",
    textOnPrimary: "#0F0E17",
  },
};

// ─── 4. Forest — 深绿，清新自然 ───────────────────────────────────────────
export const forest = {
  light: {
    primary: "#059669", primaryLight: "#10B981", primaryDark: "#047857",
    primaryGradient: "linear-gradient(135deg, #059669, #10B981)",
    primaryGhost: "rgba(5,150,105,0.08)", primaryHover: "rgba(5,150,105,0.10)",
    borderAccent: "#6EE7B7", ...semantic.light,
    ...mkLight("#F6FAF6", "#EDF5EC", "#DDF0DB", "#1A2E18", "#3D6B3A", "#5C8A58", "#C3E0C0", "#EDF5EC"),
  },
  dark: {
    primary: "#34D399", primaryLight: "#6EE7B7", primaryDark: "#10B981",
    primaryGradient: "linear-gradient(135deg, #34D399, #6EE7B7)",
    primaryGhost: "rgba(52,211,153,0.10)", primaryHover: "rgba(52,211,153,0.12)",
    borderAccent: "#059669", ...semantic.dark,
    ...mkDark("#0C1209", "#121A0E", "#1A2416", "#E4F0E2", "#87A882", "#5E7A5A", "#1A2416", "#121A0E", "12,18,9"),
    success: "#4ADE80", textHeading: "#C8EEC4",
    textOnPrimary: "#0C1209",
  },
};

// ─── 4b. Trail — 户外品牌默认：冲浪(海蓝) + 滑雪(雪白灰) + 爬山(天云绿) ─
export const trail = {
  meta: { radiusBoost: 1, motionEase: "cubic-bezier(0.22, 1, 0.36, 1)" },
  light: {
    primary: "#2E7DB5",
    primaryLight: "#6BB5E0",
    primaryDark: "#1F5F94",
    primaryGradient: "linear-gradient(135deg, #2E7DB5, #6BB5E0)",
    primaryGhost: "rgba(46, 125, 181, 0.08)",
    primaryHover: "rgba(46, 125, 181, 0.11)",
    borderAccent: "#9EC9E8",
    success: "#3F8F5C",
    warning: "#D4A054",
    info: "#4A9FD4",
    error: "#C45C4A",
    accentTrail: "#C9924E",
    accentMoss: "#7A9B6E",
    accentTrailGhost: "rgba(201, 146, 78, 0.10)",
    accentMossGhost: "rgba(122, 155, 110, 0.10)",
    background:          "#FAFBFC",
    backgroundSecondary: "#F4F7FA",
    backgroundTertiary:  "#E8EDF2",
    backgroundGhost:     "rgba(250, 251, 252, 0.94)",
    backgroundHover:     "#DCE4EC",
    backgroundSelected:  "#C8D4E0",
    text:                "#1C2430",
    textSecondary:       "#5C6775",
    textTertiary:        "#7A8796",
    textQuaternary:      "#A3B0BD",
    textLight:           "#C5CED8",
    placeholder:         "#A3B0BD",
    border:              "#D8E0E8",
    borderHover:         "#B8C5D4",
    borderLight:         "#EEF2F6",
    messageBackground:   "#FFFFFF",
    codeBackground:      "#EEF2F6",
    shadowLight:         "rgba(28, 36, 48, 0.05)",
    shadowMedium:        "rgba(28, 36, 48, 0.09)",
    shadowHeavy:         "rgba(28, 36, 48, 0.14)",
    textHeading:         "#1C2430",
    textOnPrimary:       "#FFFFFF",
  },
  dark: {
    primary: "#5BA3D9",
    primaryLight: "#7FBEE8",
    primaryDark: "#3D85BF",
    primaryGradient: "linear-gradient(135deg, #5BA3D9, #7FBEE8)",
    primaryGhost: "rgba(91, 163, 217, 0.12)",
    primaryHover: "rgba(91, 163, 217, 0.16)",
    borderAccent: "#2F5F78",
    success: "#5CB87A",
    warning: "#E6B35C",
    info: "#6BB8E8",
    error: "#E07060",
    accentTrail: "#D4A96A",
    accentMoss: "#8FB896",
    accentTrailGhost: "rgba(212, 169, 106, 0.12)",
    accentMossGhost: "rgba(143, 184, 150, 0.12)",
    background:          "#0B1218",
    backgroundSecondary: "#111A22",
    backgroundTertiary:  "#1A2630",
    backgroundGhost:     "rgba(11, 18, 24, 0.94)",
    backgroundHover:     "#243240",
    backgroundSelected:  "#2E4050",
    text:                "#EEF3F8",
    textSecondary:       "#A8B8C8",
    textTertiary:        "#7A8FA3",
    textQuaternary:      "#5A6F82",
    textLight:           "#3A4F62",
    placeholder:         "#5A6F82",
    border:              "#243240",
    borderHover:         "#3A5060",
    borderLight:         "#111A22",
    messageBackground:   "#111A22",
    codeBackground:      "#070D12",
    shadowLight:         "rgba(4, 8, 12, 0.22)",
    shadowMedium:        "rgba(4, 8, 12, 0.34)",
    shadowHeavy:         "rgba(4, 8, 12, 0.46)",
    textHeading:         "#E8F4FC",
    textOnPrimary:       "#0B1218",
  },
};

// ─── 5. Wave — 完整 Kanagawa 体验 ─────────────────────────────────────────
export const wave = {
  light: {
    // Kanagawa Lotus — lotusBlue3 accent（日式水墨蓝，与 Wave dark 气质呼应）
    primary: "#4D699B",
    primaryLight: "#6680B3",
    primaryDark: "#3C5585",
    primaryGradient: "linear-gradient(135deg, #4D699B, #6680B3)",
    primaryGhost: "rgba(77, 105, 155, 0.08)",
    primaryHover: "rgba(77, 105, 155, 0.10)",
    borderAccent: "#8CA6CF",
    success: "#6F894E",
    warning: "#836F4A",
    info: "#4D699B",
    error: "#C84053",
    // Surface overrides — Kanagawa Lotus palette
    background:          "#F5F4EF",
    backgroundSecondary: "#FFFFFF",
    backgroundTertiary:  "#ECEAE3",
    backgroundGhost:     "rgba(245, 244, 239, 0.94)",
    backgroundHover:     "#E8E6DE",
    backgroundSelected:  "#DEDAD0",
    text:                "#1A1A22",
    textSecondary:       "#3D3B4F",
    textTertiary:        "#716E61",
    textQuaternary:      "#9E9B8E",
    textLight:           "#C3BBAA",
    placeholder:         "#9E9B8E",
    border:              "#D8D5C8",
    borderHover:         "#C4C0B2",
    borderLight:         "#ECEAE3",
    messageBackground:   "#FFFFFF",
    codeBackground:      "#ECEAE3",
    shadowLight:         "rgba(26, 26, 34, 0.05)",
    shadowMedium:        "rgba(26, 26, 34, 0.09)",
    shadowHeavy:         "rgba(26, 26, 34, 0.14)",
    textOnPrimary:       "#FFFFFF",
  },
  dark: {
    // Kanagawa Wave — crystalBlue accent（#7E9CD8 是函数名颜色，最标志性的 Kanagawa 蓝）
    primary: "#7E9CD8",
    primaryLight: "#9DB4E8",
    primaryDark: "#6688BC",
    primaryGradient: "linear-gradient(135deg, #7E9CD8, #9DB4E8)",
    primaryGhost: "rgba(126, 156, 216, 0.10)",
    primaryHover: "rgba(126, 156, 216, 0.16)",
    borderAccent: "#2D4F67",
    success: "#98BB6C",   // bamboo green
    warning: "#E6C384",   // autumn gold
    info: "#7FB4CA",      // waveBlue
    error: "#E82424",
    // Surface overrides — Kanagawa Wave palette
    background:          "#1F1F28",   // surumiBlack — 墨色
    backgroundSecondary: "#16161D",   // deeper ink
    backgroundTertiary:  "#2A2A37",   // waveBlue-dark
    backgroundGhost:     "rgba(22, 22, 29, 0.94)",
    backgroundHover:     "#363646",
    backgroundSelected:  "#54546D",
    text:                "#DCD7BA",   // fujiWhite — 宣纸暖白，365天的护眼体验
    textSecondary:       "#C8C093",   // oldWhite — 次级暖白
    textTertiary:        "#938AA9",   // springViolet2 — 注释紫，Kanagawa 气质核心
    textQuaternary:      "#727169",   // fujiGray
    textLight:           "#54546D",
    placeholder:         "#727169",
    border:              "#2A2A37",
    borderHover:         "#54546D",
    borderLight:         "#1F1F28",
    messageBackground:   "#16161D",
    codeBackground:      "#0D0C0C",   // 比背景更深的墨黑
    shadowLight:         "rgba(13, 12, 12, 0.18)",
    shadowMedium:        "rgba(13, 12, 12, 0.28)",
    shadowHeavy:         "rgba(13, 12, 12, 0.38)",
    textHeading:         "#DCD7BA",   // fujiWhite — 暖色标题
    textOnPrimary:       "#1F1F28",
  },
};

// ─── 6. Rose — Rosé Pine，温柔暖粉 + 完整 surface ─────────────────────────
export const rose = {
  light: {
    // Rosé Pine Dawn
    primary: "#D14D72",
    primaryLight: "#E87C9D",
    primaryDark: "#B03060",
    primaryGradient: "linear-gradient(135deg, #D14D72, #E87C9D)",
    primaryGhost: "rgba(209, 77, 114, 0.08)",
    primaryHover: "rgba(209, 77, 114, 0.10)",
    borderAccent: "#F2BFCC",
    success: "#56949F",
    warning: "#EA9D34",
    info: "#286983",
    error: "#B4637A",
    background:          "#FAF4ED",
    backgroundSecondary: "#FFFAF3",
    backgroundTertiary:  "#F2E9E1",
    backgroundGhost:     "rgba(250, 244, 237, 0.94)",
    backgroundHover:     "#EDE3DA",
    backgroundSelected:  "#DFD3C7",
    text:                "#575279",
    textSecondary:       "#6E6A86",
    textTertiary:        "#797593",
    textQuaternary:      "#9893A5",
    textLight:           "#CECACD",
    placeholder:         "#9893A5",
    border:              "#DFDAD9",
    borderHover:         "#C5BFB3",
    borderLight:         "#F2E9E1",
    messageBackground:   "#FFFAF3",
    codeBackground:      "#F2E9E1",
    shadowLight:         "rgba(87, 82, 121, 0.05)",
    shadowMedium:        "rgba(87, 82, 121, 0.09)",
    shadowHeavy:         "rgba(87, 82, 121, 0.14)",
    textOnPrimary:       "#FFFFFF",
  },
  dark: {
    // Rosé Pine main
    primary: "#EB6F92",
    primaryLight: "#F0A8BF",
    primaryDark: "#C4637A",
    primaryGradient: "linear-gradient(135deg, #EB6F92, #F0A8BF)",
    primaryGhost: "rgba(235, 111, 146, 0.10)",
    primaryHover: "rgba(235, 111, 146, 0.14)",
    borderAccent: "#6E3050",
    success: "#9CCFD8",
    warning: "#F6C177",
    info: "#C4A7E7",
    error: "#EB6F92",
    background:          "#191724",
    backgroundSecondary: "#1F1D2E",
    backgroundTertiary:  "#26233A",
    backgroundGhost:     "rgba(25, 23, 36, 0.94)",
    backgroundHover:     "#312E45",
    backgroundSelected:  "#403D52",
    text:                "#E0DEF4",
    textSecondary:       "#C4C1D9",
    textTertiary:        "#908CAA",
    textQuaternary:      "#6E6A86",
    textLight:           "#403D52",
    placeholder:         "#6E6A86",
    border:              "#26233A",
    borderHover:         "#6E6A86",
    borderLight:         "#1F1D2E",
    messageBackground:   "#1F1D2E",
    codeBackground:      "#12101E",
    shadowLight:         "rgba(12, 10, 20, 0.20)",
    shadowMedium:        "rgba(12, 10, 20, 0.30)",
    shadowHeavy:         "rgba(12, 10, 20, 0.44)",
    textHeading:         "#E0DEF4",
    textOnPrimary:       "#191724",
  },
};

// ─── 7. Ember — 琥珀暖焰，暗夜篝火气质 ──────────────────────────────────
export const ember = {
  light: {
    primary: "#D97706", primaryLight: "#F59E0B", primaryDark: "#B45309",
    primaryGradient: "linear-gradient(135deg, #D97706, #F59E0B)",
    primaryGhost: "rgba(217,119,6,0.08)", primaryHover: "rgba(217,119,6,0.10)",
    borderAccent: "#FCD34D", ...semantic.light,
    ...mkLight("#FFFBF4", "#FFF7E6", "#FDEECB", "#2C1A04", "#6B4718", "#8A6230", "#E8D5A3", "#FFF7E6"),
  },
  dark: {
    primary: "#F59E0B", primaryLight: "#FCD34D", primaryDark: "#D97706",
    primaryGradient: "linear-gradient(135deg, #F59E0B, #FCD34D)",
    primaryGhost: "rgba(245,158,11,0.10)", primaryHover: "rgba(245,158,11,0.12)",
    borderAccent: "#92400E", ...semantic.dark,
    ...mkDark("#1A1207", "#221809", "#2E220C", "#F0E2C0", "#C4A056", "#8A7040", "#3A2A10", "#221809", "26,18,7"),
    textHeading: "#FCD34D",
    textOnPrimary: "#1A1207",
  },
};

// ─── 8. Catppuccin — 莫卡(Mocha)与拿铁(Latte)，经典粉彩主题 ─────────────────
export const catppuccin = {
  light: {
    // Catppuccin Latte
    primary: "#1e66f5",       // Blue
    primaryLight: "#89b4fa",  // Blue Light
    primaryDark: "#4c4f69",   // Text
    primaryGradient: "linear-gradient(135deg, #1e66f5, #89b4fa)",
    primaryGhost: "rgba(30, 102, 245, 0.08)",
    primaryHover: "rgba(30, 102, 245, 0.10)",
    borderAccent: "#ccd0da",
    success: "#40a02b",
    warning: "#df8e1d",
    info: "#1e66f5",
    error: "#d20f39",
    ...mkLight("#eff1f5", "#e6e9ef", "#dce0e8", "#4c4f69", "#5c5f77", "#6c6f85", "#ccd0da", "#e6e9ef"),
  },
  dark: {
    // Catppuccin Mocha
    primary: "#89b4fa",       // Blue
    primaryLight: "#b4befe",  // Lavender
    primaryDark: "#1e66f5",
    primaryGradient: "linear-gradient(135deg, #89b4fa, #b4befe)",
    primaryGhost: "rgba(137, 180, 250, 0.10)",
    primaryHover: "rgba(137, 180, 250, 0.14)",
    borderAccent: "#313244",
    success: "#a6e3a1",
    warning: "#f9e2af",
    info: "#89b4fa",
    error: "#f38ba8",
    ...mkDark("#1e1e2e", "#181825", "#11111b", "#cdd6f4", "#bac2de", "#a6adc8", "#313244", "#181825", "30,30,46"),
    textHeading: "#f5e0dc",
    textOnPrimary: "#11111b",
  },
};

// ─── 向后兼容 alias（DB 中可能存了旧 key） ─────────────────────────────────
export const blue     = ocean;
export const purple   = iris;
export const green    = forest;
export const graphite = neutral;
export const mocha    = catppuccin;
export const pink     = rose;
export const red      = ember;
export const orange   = ember;
export const yellow   = ember;
