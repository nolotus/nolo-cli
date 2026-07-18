// packages/app/settings/settingInitialState.ts
//
// 单一职责:计算 settings slice 的 initialState。
// 包含主题预加载(_preloadedTheme)以匹配内联 bootstrap 脚本,避免 GlobalThemeController
// 在 paint 前用过期默认值覆盖正确主题。

import { DEFAULT_USER_PREFERENCE_PROFILE } from "../../ai/policy/types";
import { DEFAULT_AUTO_APPROVED_SELF_UPDATE_FIELDS } from "../../ai/policy/selfUpdateFields";
import { SERVERS } from "../../database/config";
import { isProduction } from "../utils/env";
import { DEFAULT_FONT_PRESET } from "../theme/fontPreference";
import { DEFAULT_THEME_NAME } from "../theme/theme.config";
import {
  resolveThemeModePreload,
  SYSTEM_DARK_MEDIA_QUERY,
} from "../theme/themeModeBootstrap";

import { SYSTEM_DEFAULT_AGENT_ID, type SettingState } from "./settingTypes";

/**
 * Resolve themeMode + isDark from localStorage + system preference at load time,
 * matching the inline bootstrap script so GlobalThemeController never overwrites
 * the correct pre-paint theme with a stale hardcoded default.
 */
const _preloadedTheme =
  typeof window !== "undefined"
    ? resolveThemeModePreload({
        storage: typeof localStorage !== "undefined" ? localStorage : undefined,
        systemPrefersDark:
          typeof window.matchMedia === "function"
            ? window.matchMedia(SYSTEM_DARK_MEDIA_QUERY).matches
            : false,
      })
    : { themeMode: "system" as const, isDark: false };

export const initialState: SettingState = {
  isAutoSync: false,
  currentServer: isProduction ? SERVERS.MAIN : SERVERS.US,
  syncServers: Object.values(SERVERS),
  showThinking: true,
  preferredAnimationSet: 0,
  maxExecutionTime: 600_000,
  maxCost: 1,
  themeName: DEFAULT_THEME_NAME,
  themeMode: _preloadedTheme.themeMode,
  isDark: _preloadedTheme.isDark,
  sidebarWidth: 280,
  headerHeight: 56,
  density: "compact",
  fontPreset: DEFAULT_FONT_PRESET,
  editorDefaultMode: "markdown",
  editorLightCodeTheme: "default",
  editorDarkCodeTheme: "okaidia",
  editorWordCountEnabled: true,
  editorShortcuts: {
    heading: true,
    ulist: true,
    olist: true,
    quote: true,
    code: true,
    tasklist: true,
  },
  editorFontSize: 14,
  editorAutoSave: true,
  editorAutoSaveInterval: 30,
  editorLineNumbers: false,
  editorWordWrap: true,
  editorSpellCheck: true,
  editorTabSize: 2,
  editorFontFamily: "SF Mono, Monaco, Cascadia Code, Roboto Mono, monospace",
  enableReadCurrentSpace: true,
  globalPrompt:
    "以下是关于我的通用说明，请在任意场景下都以此来理解和服务我：\n" +
    "1. 我希望你用清晰、简洁的方式回答问题，并在必要时给出示例。\n" +
    "2. 如果有多种解决方案，请先给出推荐方案，再简要说明其他方案的优缺点。\n" +
    "3. 当你不确定答案时，请明确说明不确定，并推测可能的方向，而不是编造事实。\n" +
    "4. 如果涉及代码，请优先使用现代、通用的最佳实践。",
  userTonePreset: DEFAULT_USER_PREFERENCE_PROFILE.tone?.preset ?? "default",
  knowledgeCaptureLevel: DEFAULT_USER_PREFERENCE_PROFILE.knowledgeCaptureLevel,
  spaceContextLevel: DEFAULT_USER_PREFERENCE_PROFILE.spaceContextLevel,
  autoApproveSelfUpdateFields: [...DEFAULT_AUTO_APPROVED_SELF_UPDATE_FIELDS],
  aiRecentContentLimit: 50,
  defaultAgentId: SYSTEM_DEFAULT_AGENT_ID,
  ocrModel: "google_document_ocr",
  showScrollToTopButton: false,
  showScrollToBottomButton: false,
  createMenuOpenCount: 0,
  desktopChromeConnectorEnabled: false,
  developerModeEnabled: false,
  diagnosticModeEnabled: false,
  deleteShortcut:
    typeof window !== "undefined" &&
    typeof window.navigator !== "undefined" &&
    /Mac|iPod|iPhone|iPad/.test(window.navigator.platform)
      ? "meta+backspace"
      : "ctrl+backspace",
};
