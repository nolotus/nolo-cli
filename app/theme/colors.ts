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

// ─── 3. Iris — Linear 签名色，精致紫蓝、科技工具感 ────────────────────────
//   摆脱工厂：紫黑画布 + 微妙层级（Linear 靠边框和明度差，不靠大跳色）；
//   accent 三层 blue/lavender/iris 拉开，语义色贴冷调，阴影带紫调；
//   圆角收窄、动效偏干脆——premium tool 的气质。
export const iris = {
  meta: { radiusBoost: -2, motionEase: "cubic-bezier(0.16, 1, 0.3, 1)" },
  light: {
    primary: "#5E6AD2",
    primaryLight: "#8B9CF4",
    primaryDark: "#4A55C0",
    primaryGradient: "linear-gradient(135deg, #5E6AD2, #8B9CF4)",
    primaryGhost: "rgba(94, 106, 210, 0.07)",
    primaryHover: "rgba(94, 106, 210, 0.10)",
    borderAccent: "#ADB5F7",
    success: "#16A34A",
    warning: "#D97706",
    info: "#5E6AD2",
    error: "#E5484D",
    background:          "#FBFBFD",
    backgroundSecondary: "#F4F4F9",
    backgroundTertiary:  "#ECECF3",
    backgroundGhost:     "rgba(251, 251, 253, 0.94)",
    backgroundHover:     "#E4E4ED",
    backgroundSelected:  "#D8D8E3",
    backgroundElevated:  "#F7F7FB",
    text:                "#1A1730",
    textSecondary:       "#4E4B6B",
    textTertiary:        "#6E6A8A",
    textQuaternary:      "#9E9AB5",
    textLight:           "#C4C2D4",
    placeholder:         "#9E9AB5",
    border:              "#E4E4ED",
    borderHover:         "#CFCFD9",
    borderLight:         "#F2F2F7",
    messageBackground:   "#FFFFFF",
    codeBackground:      "#F2F2F7",
    shadowLight:         "rgba(26, 23, 48, 0.04)",
    shadowMedium:        "rgba(26, 23, 48, 0.08)",
    shadowHeavy:         "rgba(26, 23, 48, 0.13)",
    textHeading:         "#1A1730",
    textOnPrimary:       "#FFFFFF",
  },
  dark: {
    primary: "#8B9CF4",
    primaryLight: "#ADB5F7",
    primaryDark: "#5E6AD2",
    primaryGradient: "linear-gradient(135deg, #8B9CF4, #ADB5F7)",
    primaryGhost: "rgba(139, 156, 244, 0.10)",
    primaryHover: "rgba(139, 156, 244, 0.14)",
    borderAccent: "#4A55C0",
    success: "#26BD6C",
    warning: "#F5A623",
    info: "#8B9CF4",
    error: "#EC5B6E",
    background:          "#0F0E17",
    backgroundSecondary: "#16141F",
    backgroundTertiary:  "#1E1B2E",
    backgroundGhost:     "rgba(15, 14, 23, 0.94)",
    backgroundHover:     "#28253A",
    backgroundSelected:  "#36334D",
    backgroundElevated:  "#1E1B2E",
    text:                "#E8E5F7",
    textSecondary:       "#C0BDD8",
    textTertiary:        "#938AA9",
    textQuaternary:      "#5A5772",
    textLight:           "#36334D",
    placeholder:         "#5A5772",
    border:              "#272435",
    borderHover:         "#3A3650",
    borderLight:         "#16141F",
    messageBackground:   "#16141F",
    codeBackground:      "#0A0911",
    shadowLight:         "rgba(10, 9, 17, 0.20)",
    shadowMedium:        "rgba(10, 9, 17, 0.32)",
    shadowHeavy:         "rgba(10, 9, 17, 0.44)",
    textHeading:         "#E8E5F7",
    textOnPrimary:       "#0F0E17",
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

// ─── 7. Mono — 灰橙极简，open-props 中性灰 + 暖橙强调 ─────────────────────
//   整组只用两态：light（gray-0..3 画布 + orange-6 品牌）和 dim（gray-5..8 画布 + orange-4 品牌）。
//   dark 字段是 framework 强制的兼容位，等同 dim，避免系统 dark 模式接管后样式错乱。
//   主品牌始终橙色，中性灰让出层级；圆角与动效走简洁利落路线。
export const mono = {
  meta: { radiusBoost: 0, motionEase: "cubic-bezier(0.4, 0, 0.2, 1)" },
  light: {
    // open-props: --orange-6 = #FF9500, --orange-3 = #FFD599, --orange-7 = #E68600
    primary:         "#FF9500",
    primaryLight:    "#FFD599",
    primaryDark:     "#E68600",
    primaryGradient: "linear-gradient(135deg, #FF9500, #FFD599)",
    primaryGhost:    "rgba(255,149,0,0.08)",
    primaryHover:    "rgba(255,149,0,0.12)",
    borderAccent:    "#FFBF66",
    success:         "#16A34A",
    warning:         "#D97706",
    info:            "#2563EB",
    error:           "#DC2626",
    // 采用 open-props 默认的冷系 slate-gray 调色（H=210, S=10%），完美消除泥土发灰感
    background:          "#FCFCFD",  // gray-0
    backgroundSecondary: "#F9FAFA",  // gray-1
    backgroundTertiary:  "#F1F2F4",  // gray-2
    backgroundGhost:     "rgba(252,252,253,0.94)",
    backgroundHover:     "#EBEDEF",  // gray-3
    backgroundSelected:  "#C1C7CD",  // gray-6
    backgroundElevated:  "#FFFFFF",
    text:                "#292E32",  // gray-12
    textSecondary:       "#57616B",  // gray-10
    textTertiary:        "#7B8793",  // gray-8
    textQuaternary:      "#9DA6AF",  // gray-7
    textLight:           "#C1C7CD",
    placeholder:         "#9DA6AF",
    border:              "#E6E8EA",  // gray-4
    borderHover:         "#C1C7CD",
    borderLight:         "#F1F2F4",
    messageBackground:   "#FFFFFF",
    codeBackground:      "#F1F2F4",
    // 基于 slate-gray 调色 #292E32 (RGB 41, 46, 50) 的有机冷调阴影
    shadowLight:         "rgba(41, 46, 50, 0.05)",
    shadowMedium:        "rgba(41, 46, 50, 0.09)",
    shadowHeavy:         "rgba(41, 46, 50, 0.15)",
    textHeading:         "#292E32",
    textOnPrimary:       "#FFFFFF",
  },
  // dim 是 mono 的"主"暗态：用 open-props 经典 slate-gray 暗色（gray-12..9）做画布，
  // 完美对应参考图中的深石墨色/冷灰色调，对比极强、层次细腻。
  dark: {
    // open-props: --orange-3 = #FFD599, --orange-4 = #FFBF66, --orange-5 = #FFAA33
    primary:         "#FFBF66",
    primaryLight:    "#FFD599",
    primaryDark:     "#FFAA33",
    primaryGradient: "linear-gradient(135deg, #FFBF66, #FFAA33)",
    primaryGhost:    "rgba(255,191,102,0.12)",
    primaryHover:    "rgba(255,191,102,0.18)",
    borderAccent:    "#FFAA33",
    success:         "#4ADE80",
    warning:         "#FCD34D",
    info:            "#60A5FA",
    error:           "#F87171",
    // open-props 冷系 slate-gray 暗色画布（H=210, S=10%）
    background:          "#292E32",  // gray-12
    backgroundSecondary: "#3E454C",  // gray-11
    backgroundTertiary:  "#57616B",  // gray-10
    backgroundGhost:     "rgba(41,46,50,0.94)",
    backgroundHover:     "#4F5862",  // ~gray-10.5
    backgroundSelected:  "#6E7A87",  // gray-9
    backgroundElevated:  "#3E454C",
    text:                "#EBEDEF",  // gray-3
    textSecondary:       "#DDE0E3",  // gray-5
    textTertiary:        "#C1C7CD",  // gray-6
    textQuaternary:      "#7B8793",  // gray-8
    textLight:           "#3E454C",
    placeholder:         "#7B8793",
    // 边框必须比所在表面亮一档,否则夜间卡片/分割线全部融进背景
    border:              "#4A525A",
    borderHover:         "#6E7A87",
    borderLight:         "#343A40",
    messageBackground:   "#3E454C",
    codeBackground:      "#1A1D20",  // 略深于 canvas 的冷墨色
    // 基于深 slate-gray #0F1113 (RGB 15, 17, 19) 的有机阴影，在冷深色背景上极其细腻浮空
    shadowLight:         "rgba(15, 17, 19, 0.28)",
    shadowMedium:        "rgba(15, 17, 19, 0.45)",
    shadowHeavy:         "rgba(15, 17, 19, 0.65)",
    textHeading:         "#F1F2F4",  // 近白标题;橙色 heading 在夜间大标题上过于突兀
    textOnPrimary:       "#2E2E2E",
  },
};

// ─── 8. Catppuccin — 拿铁白净通透 + 莫卡粉彩层次 ───────────────────────────
//   摆脱 mkLight/mkDark 工厂：Latte 主画布提到近白，三级背景逐级下沉；
//   Mocha 修正被工厂碾平的层级（surface0 上浮做 tertiary/hover，crust 下沉做 code）。
//   accent 用 blue/lavender/sky 三层拉开，语义色用官方 palette，阴影带主题自身色调。
export const catppuccin = {
  meta: { radiusBoost: 2, motionEase: "cubic-bezier(0.22, 1, 0.36, 1)" },
  light: {
    // Catppuccin Latte — 白底冷调
    primary: "#1E66F5",
    primaryLight: "#7287FD",
    primaryDark: "#0D52D4",
    primaryGradient: "linear-gradient(135deg, #1E66F5, #7287FD)",
    primaryGhost: "rgba(30, 102, 245, 0.08)",
    primaryHover: "rgba(30, 102, 245, 0.10)",
    borderAccent: "#89B4FA",
    success: "#40A02B",
    warning: "#DF8E1D",
    info: "#04A5E5",
    error: "#D20F39",
    background:          "#FCFDFE",
    backgroundSecondary: "#F1F4F9",
    backgroundTertiary:  "#E6E9F1",
    backgroundGhost:     "rgba(252, 253, 254, 0.94)",
    backgroundHover:     "#DCE0EA",
    backgroundSelected:  "#CCD2DF",
    backgroundElevated:  "#EBEFF6",  // 雾灰下沉面板：与 #FCFDFE 画布/字段拉开对比，修复 surface 层级倒挂
    text:                "#4C4F69",
    textSecondary:       "#5C5F77",
    textTertiary:        "#6C6F85",
    textQuaternary:      "#9799A4",
    textLight:           "#BCC0CF",
    placeholder:         "#8C8FA1",
    border:              "#DCDFE8",
    borderHover:         "#C6C9D5",
    borderLight:         "#EFF2F7",
    messageBackground:   "#FFFFFF",
    codeBackground:      "#EEF1F6",
    shadowLight:         "rgba(76, 79, 105, 0.05)",
    shadowMedium:        "rgba(76, 79, 105, 0.09)",
    shadowHeavy:         "rgba(76, 79, 105, 0.14)",
    textOnPrimary:       "#FFFFFF",
  },
  dark: {
    // Catppuccin Mocha — 层级修正
    primary: "#89B4FA",
    primaryLight: "#B4BEFE",
    primaryDark: "#1E66F5",
    primaryGradient: "linear-gradient(135deg, #89B4FA, #B4BEFE)",
    primaryGhost: "rgba(137, 180, 250, 0.10)",
    primaryHover: "rgba(137, 180, 250, 0.14)",
    borderAccent: "#313244",
    success: "#A6E3A1",
    warning: "#F9E2AF",
    info: "#94E2D5",
    error: "#F38BA8",
    background:          "#1E1E2E",
    backgroundSecondary: "#181825",
    backgroundTertiary:  "#313244",
    backgroundGhost:     "rgba(24, 24, 37, 0.94)",
    backgroundHover:     "#45475A",
    backgroundSelected:  "#585B70",
    backgroundElevated:  "#313244",
    text:                "#CDD6F4",
    textSecondary:       "#BAC2DE",
    textTertiary:        "#A6ADC8",
    textQuaternary:      "#6C7086",
    textLight:           "#585B70",
    placeholder:         "#6C7086",
    border:              "#313244",
    borderHover:         "#585B70",
    borderLight:         "#181825",
    messageBackground:   "#181825",
    codeBackground:      "#11111B",
    shadowLight:         "rgba(17, 17, 27, 0.22)",
    shadowMedium:        "rgba(17, 17, 27, 0.34)",
    shadowHeavy:         "rgba(17, 17, 27, 0.46)",
    textHeading:         "#F5E0DC",
    textOnPrimary:       "#1E1E2E",
  },
};

// ─── 向后兼容 alias（DB 中可能存了旧 key） ─────────────────────────────────
export const blue     = ocean;
export const purple   = iris;
export const green    = forest;
export const graphite = neutral;
export const mocha    = catppuccin;
export const pink     = rose;
// ember 已下线：旧 key 统一落到 mono
export const red      = mono;
export const orange   = mono;
export const yellow   = mono;
export const ember    = mono;
