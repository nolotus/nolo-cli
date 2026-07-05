// packages/app/settings/themeSelectors.ts
//
// 单一职责:复合 selectTheme 选择器——把 fieldSelectors 的输入聚合成一个完整的主题 token 树
// (含色板、间距、字号、圆角、motion、focus ring、RAC 别名等)。
//
// 不直接 import state;通过 fieldSelectors 间接取 state。

import { createSelector } from "@reduxjs/toolkit";
import { DEFAULT_THEME_NAME, SPACE, THEME_COLORS } from "../theme/theme.config";
import {
  DEFAULT_FONT_PRESET,
  FONT_PRESET_CSS_VARIABLES,
  normalizeFontPreset,
} from "../theme/fontPreference";

import { alphaColor, hexToRgbString } from "./settingNormalizers";
import {
  selectDensity,
  selectFontPreset,
  selectHeaderHeight,
  selectIsDark,
  selectSidebarWidth,
  selectThemeName,
} from "./fieldSelectors";

type ThemeMode = "light" | "dark";

interface ThemeMeta {
  radiusBoost?: number;
  motionEase?: string;
}

interface ThemeModeTokens {
  primary: string;
  primaryLight?: string;
  primaryDark?: string;
  primaryGhost: string;
  primaryHover?: string;
  primaryGradient?: string;
  borderAccent?: string;
  success: string;
  warning: string;
  info: string;
  error: string;
  background: string;
  backgroundSecondary: string;
  backgroundTertiary: string;
  backgroundGhost: string;
  backgroundHover: string;
  backgroundSelected?: string;
  backgroundElevated?: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  textQuaternary?: string;
  textLight?: string;
  textHeading?: string;
  textOnPrimary: string;
  placeholder?: string;
  border: string;
  borderLight: string;
  borderHover: string;
  messageBackground: string;
  codeBackground: string;
  shadowLight: string;
  shadowMedium: string;
  shadowHeavy: string;
}

interface ThemeData {
  meta?: ThemeMeta;
  light: ThemeModeTokens;
  dark: ThemeModeTokens;
}

const isThemeData = (value: unknown): value is ThemeData => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.light === "object" &&
    candidate.light !== null &&
    typeof candidate.dark === "object" &&
    candidate.dark !== null
  );
};

const readMeta = (themeData: ThemeData): ThemeMeta | undefined => themeData.meta;

const SPACIOUS_SPACE = {
  0: "0",
  1: "5px",
  2: "10px",
  3: "14px",
  4: "20px",
  5: "24px",
  6: "30px",
  7: "34px",
  8: "40px",
  10: "50px",
  12: "60px",
  14: "70px",
  16: "80px",
  20: "100px",
  24: "120px",
};

const SPACIOUS_FONT_SIZE = {
  xs: "12px",
  sm: "13px",
  base: "15px",
  md: "15.5px",
  lg: "17.5px",
  xl: "22px",
  "2xl": "26px",
  "3xl": "30px",
};

const SPACIOUS_LEADING = {
  tight: "1.4",
  normal: "1.6",
  relaxed: "1.75",
};

const SPACIOUS_CONTROL = {
  xs: "28px",
  sm: "32px",
  md: "40px",
  lg: "46px",
  xl: "56px",
};

const COMPACT_LEADING = {
  tight: "1.3",
  normal: "1.45",
  relaxed: "1.6",
};

const COMPACT_CONTROL = {
  xs: "24px",
  sm: "28px",
  md: "36px",
  lg: "40px",
  xl: "48px",
};

const COMPACT_FONT_SIZE = {
  xs: "11px",
  sm: "12px",
  base: "14px",
  md: "14px",
  lg: "16px",
  xl: "20px",
  "2xl": "24px",
  "3xl": "28px",
};

const FONT_WEIGHT = {
  normal: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
};

const TRACKING = {
  tight: "-0.02em",
  normal: "0",
  wide: "0.02em",
};

const Z_INDEX = {
  sticky: 100,
  dropdown: 1000,
  modalBackdrop: 1010,
  modal: 1020,
  toast: 1030,
  tooltip: 1040,
};

const FALLBACK_PRIMARY_RGB = "59, 130, 246";
const FALLBACK_SUCCESS_GHOST = "rgba(16, 185, 129, 0.12)";
const FALLBACK_WARNING_GHOST = "rgba(245, 158, 11, 0.12)";
const FALLBACK_INFO_GHOST = "rgba(59, 130, 246, 0.12)";
const FALLBACK_ERROR_GHOST = "rgba(239, 68, 68, 0.12)";
const FALLBACK_INVALID_BG = "rgba(239, 68, 68, 0.5)";
const DEFAULT_MOTION_EASE = "cubic-bezier(0.33, 0, 0.2, 1)";
const TIDE_MOTION_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const BREATH_MOTION_EASE = "cubic-bezier(0.4, 0, 0.6, 1)";

export const selectTheme = createSelector(
  [
    selectThemeName,
    selectIsDark,
    selectSidebarWidth,
    selectHeaderHeight,
    selectDensity,
    selectFontPreset,
  ],
  (themeName, isDark, sidebarWidth, headerHeight, density, fontPreset) => {
    const mode: ThemeMode = isDark ? "dark" : "light";
    const validThemeName = THEME_COLORS[themeName]
      ? themeName
      : DEFAULT_THEME_NAME;
    const validFontPreset =
      normalizeFontPreset(fontPreset) ?? DEFAULT_FONT_PRESET;
    const themeCandidate = THEME_COLORS[validThemeName] as unknown;
    if (!isThemeData(themeCandidate)) {
      throw new Error(
        `selectTheme: theme "${String(validThemeName)}" is missing required light/dark tables`,
      );
    }
    const themeData: ThemeData = themeCandidate;
    const c = themeData[mode];
    const meta = readMeta(themeData);
    const compact = density === "compact";

    return {
      sidebarWidth: `${sidebarWidth}px`,
      headerHeight: `${headerHeight}px`,
      sidebarItemHeight: compact ? "36px" : "40px",
      sidebarIconSize: compact ? "18px" : "20px",
      sidebarItemGap: compact ? "2px" : "4px",
      // Density-aware spacing scale (4px grid → 5px grid)
      space: compact ? SPACE : SPACIOUS_SPACE,
      // Semantic typography scale
      fontSize: compact ? COMPACT_FONT_SIZE : SPACIOUS_FONT_SIZE,
      // Font weight scale
      fontWeight: FONT_WEIGHT,
      // Letter spacing scale
      tracking: TRACKING,
      // Semantic line-height scale
      leading: compact ? COMPACT_LEADING : SPACIOUS_LEADING,
      // Component height scale (buttons, inputs, list items)
      control: compact ? COMPACT_CONTROL : SPACIOUS_CONTROL,
      // Border radius scale — xs/sm/md map to control/surface/overlay tiers.
      // lg/xl remain as aliases for gradual migration of legacy CSS.
      radius: (() => {
        const boost = meta?.radiusBoost ?? 0;
        const xs = compact ? "10px" : "12px";
        const sm = compact ? `${14 + boost}px` : `${16 + boost}px`;
        const md = compact ? "20px" : "24px";
        return { xs, sm, md, lg: sm, xl: md };
      })(),
      motionEase: meta?.motionEase ?? DEFAULT_MOTION_EASE,
      motionEaseTide: TIDE_MOTION_EASE,
      motionEaseBreath: BREATH_MOTION_EASE,
      motionDuration: "0.32s",
      motionDurationSlow: "0.52s",
      font: FONT_PRESET_CSS_VARIABLES[validFontPreset],
      // Z-index scale aligned with existing hardcoded layers
      z: Z_INDEX,
      // Semantic spacing aliases
      contentPadding: compact ? "16px" : "20px",
      sectionGap: compact ? "32px" : "40px",
      cardPadding: compact ? "16px" : "20px",
      inputPadding: compact ? "8px 12px" : "10px 14px",
      ...c,
      borderSubtle: c.borderLight,
      borderFaint: alphaColor(c.border, isDark ? 0.22 : 0.35, c.borderLight),
      borderStrong: c.borderHover,
      surface: c.backgroundSecondary,
      surfaceElevated: c.backgroundTertiary,
      surfaceCanvas: c.background,
      surfaceSidebar: isDark ? c.backgroundSecondary : c.background,
      surfacePanel: c.backgroundSecondary,
      surfaceCard: c.messageBackground,
      surfaceRaised: isDark ? c.backgroundTertiary : c.backgroundSecondary,
      surfaceInset: isDark
        ? c.backgroundSecondary
        : alphaColor(c.borderHover, 0.05, c.codeBackground),
      surfaceCode: c.codeBackground,
      surfaceInteractive: c.backgroundTertiary,
      surfaceInteractiveHover: c.backgroundHover,
      textMuted: c.textSecondary,
      textSubtle: c.textTertiary,
      textHeading: c.textHeading ?? c.text,
      borderMuted: alphaColor(
        c.borderHover,
        isDark ? 0.3 : 0.24,
        c.borderLight,
      ),
      accentSoft: alphaColor(c.primary, isDark ? 0.18 : 0.1, c.primaryGhost),
      shadow: c.shadowMedium,
      shadow1: `0 1px 2px ${c.shadowLight}`,
      shadow2: `0 8px 24px -12px ${c.shadowMedium}`,
      shadow3: `0 18px 44px -24px ${c.shadowHeavy}`,
      primaryBorder: c.borderAccent ?? c.primary,
      primaryBgStrong: alphaColor(
        c.primary,
        isDark ? 0.18 : 0.1,
        c.primaryGhost,
      ),
      success: c.success,
      warning: c.warning,
      info: c.info,
      successGhost: alphaColor(
        c.success,
        isDark ? 0.2 : 0.12,
        FALLBACK_SUCCESS_GHOST,
      ),
      warningGhost: alphaColor(
        c.warning,
        isDark ? 0.2 : 0.12,
        FALLBACK_WARNING_GHOST,
      ),
      infoGhost: alphaColor(c.info, isDark ? 0.2 : 0.12, FALLBACK_INFO_GHOST),
      errorGhost: alphaColor(
        c.error,
        isDark ? 0.2 : 0.12,
        FALLBACK_ERROR_GHOST,
      ),
      primaryRgb: hexToRgbString(c.primary) ?? FALLBACK_PRIMARY_RGB,
      focusRing: alphaColor(c.primary, isDark ? 0.3 : 0.22, c.primaryGhost),
      // Generic interactive state tokens (dark-mode aware)
      hoverBg: alphaColor(c.text, isDark ? 0.06 : 0.04, c.backgroundTertiary),
      activeBg: alphaColor(c.text, isDark ? 0.1 : 0.08, c.backgroundTertiary),
      disabledText: c.textTertiary,
      disabledBg: c.backgroundSecondary,
      // Code block tokens
      codeBg: c.codeBackground,
      codeText: c.text,
      // Text selection token
      selectionBg: alphaColor(c.primary, isDark ? 0.2 : 0.15, c.primaryGhost),
      // ── --focus 全局 token(消除 ~30 处内联 fallback)──────────
      focus: alphaColor(c.primary, isDark ? 0.3 : 0.22, c.primaryGhost),
      // ── RAC 别名层(让 RAC 组件自动获得项目主题色)──────────
      focusRingColor: c.primary,
      invalidColor: c.error,
      buttonBackground: alphaColor(
        c.primary,
        isDark ? 0.12 : 0.08,
        c.primaryGhost,
      ),
      buttonBackgroundPressed: alphaColor(
        c.primary,
        isDark ? 0.18 : 0.12,
        c.primaryGhost,
      ),
      highlightBackground: c.primary,
      highlightForeground: c.textOnPrimary,
      highlightBackgroundPressed: c.primary,
      highlightOverlay: alphaColor(
        c.primary,
        isDark ? 0.15 : 0.1,
        c.primaryGhost,
      ),
      highlightBackgroundInvalid: alphaColor(
        c.error,
        isDark ? 0.55 : 0.5,
        FALLBACK_INVALID_BG,
      ),
      fieldBackground: c.backgroundSecondary,
      fieldTextColor: c.text,
      linkColor: c.primary,
      linkColorSecondary: c.text,
      linkColorPressed: c.primaryDark,
      borderColorDisabled: c.borderLight,
    };
  },
);
