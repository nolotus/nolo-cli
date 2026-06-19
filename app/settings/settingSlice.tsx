// app/settings/settingSlice.ts

import {
  buildCreateSlice,
  asyncThunkCreator,
  createSelector,
  type PayloadAction,
} from "@reduxjs/toolkit";
import type { RootState } from "../store";
import { isProduction } from "../utils/env";
import { getIsDesktopApp } from "../utils/env";
import { getAllServers } from "../../database/actions/common";
import { SERVERS } from "../../database/config";
import { createUserKey, createUserPreferenceKey } from "../../database/keys";
import { selectUserId } from "../../auth/authSlice";
import {
  USER_PREFERENCE_NAMES,
  buildDefaultAgentPreferenceRegisterRecord,
  readUserPreferenceRegisterValue,
} from "../../database/userPreferenceRegister";

// 从分离的配置文件导入静态主题数据
import {
  DEFAULT_THEME_NAME,
  SPACE,
  THEME_COLORS,
} from "../theme/theme.config";
import {
  normalizeThemeName,
  resolveThemeModeIsDark,
  SYSTEM_DARK_MEDIA_QUERY,
} from "../theme/themeModeBootstrap";
import {
  DEFAULT_FONT_PRESET,
  FONT_PRESET_CSS_VARIABLES,
  type FontPreset,
  normalizeFontPreset,
} from "../theme/fontPreference";
import { legacyNoloAgentId, noloAgentId } from "../../core/init";
import { DEFAULT_ANIMATION_SET_INDEX } from "../constants/animationSets";
import {
  areSidebarVisibleTypesEqual,
  DEFAULT_SIDEBAR_VISIBLE_TYPES,
  LEGACY_DEFAULT_SIDEBAR_VISIBLE_TYPES,
  normalizeSidebarVisibleTypes,
  type SidebarVisibleType,
} from "../../create/space/sidebarVisibleTypes";
import { normalizeSpaceId } from "../../create/space/spaceKeys";
import {
  DEFAULT_USER_PREFERENCE_PROFILE,
  type KnowledgeCaptureLevel,
  type SpaceContextLevel,
  type TonePreset,
} from "../../ai/policy/types";
import {
  DEFAULT_AUTO_APPROVED_SELF_UPDATE_FIELDS,
  normalizeAgentUpdateFieldList,
  type AgentUpdateField,
} from "../../ai/policy/selfUpdateFields";
import { getSettingDbActionThunks } from "./dbActionThunks";
import {
  normalizeDefaultSpaceIdPreference,
  persistDefaultSpacePreference,
  readDefaultSpaceIdPreference,
} from "./defaultSpacePreference";
import { withSettingsRecordSchema } from "./settingsRecord";

// --- State 定义 (包含所有字段) ---
interface SettingState {
  isAutoSync: boolean;
  currentServer: string;
  defaultSpaceId?: string | null;
  syncServers: string[];
  showThinking: boolean;
  preferredAnimationSet: number;
  maxExecutionTime: number;
  maxCost: number;
  themeName: keyof typeof THEME_COLORS;
  themeMode: "system" | "light" | "dark";
  isDark: boolean; // resolved value: managed by setThemeMode + useSystemTheme
  sidebarWidth: number;
  headerHeight: number;
  density: "compact" | "spacious";
  fontPreset: FontPreset;

  // 编辑器配置
  editorDefaultMode: "markdown" | "block";
  editorLightCodeTheme: string;
  editorDarkCodeTheme: string;
  editorWordCountEnabled: boolean;
  editorShortcuts: {
    heading: boolean;
    ulist: boolean;
    olist: boolean;
    quote: boolean;
    code: boolean;
    tasklist: boolean;
  };
  editorFontSize: number;
  editorAutoSave: boolean;
  editorAutoSaveInterval: number;
  editorLineNumbers: boolean;
  editorWordWrap: boolean;
  editorSpellCheck: boolean;
  editorTabSize: number;
  editorFontFamily: string;

  // 是否允许读取当前空间内容作为上下文
  enableReadCurrentSpace: boolean;

  // 侧边栏默认显示的内容类型
  sidebarVisibleTypes: SidebarVisibleType[];

  // 通用提示词
  globalPrompt: string;

  // 用户偏好的语气 preset（尽量通用，不覆盖 agent 自身人格）
  userTonePreset: TonePreset;

  // AI 对知识沉淀（doc/table）的主动程度
  knowledgeCaptureLevel: KnowledgeCaptureLevel;

  // AI 使用当前空间作为上下文的积极程度
  spaceContextLevel: SpaceContextLevel;

  // updateSelf 默认哪些字段不再询问
  autoApproveSelfUpdateFields: AgentUpdateField[];

  // ADDED: AI Recent Content Limit
  aiRecentContentLimit: number;

  // 上下文保留程度 1-100（默认 50）
  // 值越高 = 保留越多历史上下文，新对话空间越小
  contextRetention: number;

  // 默认启动的智能体 ID
  defaultAgentId?: string;

  // PDF OCR 模型选择（"none" 表示不使用 OCR，用 pdf.js 提取文本）
  ocrModel: "none" | "google_document_ocr" | "olm_ocr";

  // 对话页面快捷滚动按钮
  showScrollToTopButton: boolean;
  showScrollToBottomButton: boolean;
  createMenuOpenCount: number;
  desktopChromeConnectorEnabled: boolean;
  deleteShortcut: string;

  [key: string]: any;
}

export const SYSTEM_DEFAULT_AGENT_ID = "system-default";

// --- 初始状态 (包含所有字段的默认值) ---
const initialState: SettingState = {
  isAutoSync: false,
  currentServer: isProduction ? SERVERS.MAIN : SERVERS.US,
  defaultSpaceId: null,
  syncServers: Object.values(SERVERS),
  showThinking: true,
  preferredAnimationSet: DEFAULT_ANIMATION_SET_INDEX,
  maxExecutionTime: 600_000,
  maxCost: 1,
  themeName: DEFAULT_THEME_NAME,
  themeMode: "system" as const,
  isDark: false,
  sidebarWidth: 320,
  headerHeight: 56,
  density: "compact" as const,
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
  sidebarVisibleTypes: [...DEFAULT_SIDEBAR_VISIBLE_TYPES],
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
  contextRetention: 50,
  defaultAgentId: SYSTEM_DEFAULT_AGENT_ID,
  ocrModel: "google_document_ocr",
  showScrollToTopButton: false,
  showScrollToBottomButton: false,
  createMenuOpenCount: 0,
  desktopChromeConnectorEnabled: false,
  deleteShortcut: (typeof window !== "undefined" && typeof window.navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(window.navigator.platform))
    ? "meta+backspace"
    : "ctrl+backspace",
};

// --- Slice 创建 ---
const createSliceWithThunks = buildCreateSlice({
  creators: { asyncThunk: asyncThunkCreator },
});

const hasOwn = (target: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(target, key);

const normalizeSidebarVisibleTypesSetting = (
  value: unknown
): SidebarVisibleType[] => {
  const rawValues = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
  const normalized = normalizeSidebarVisibleTypes(rawValues);

  if (
    rawValues &&
    areSidebarVisibleTypesEqual(normalized, LEGACY_DEFAULT_SIDEBAR_VISIBLE_TYPES)
  ) {
    return [...DEFAULT_SIDEBAR_VISIBLE_TYPES];
  }

  return normalized;
};

const normalizeDefaultAgentIdSetting = (
  value: unknown
): string | undefined => {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  return value === legacyNoloAgentId ||
    value === noloAgentId ||
    value === SYSTEM_DEFAULT_AGENT_ID
    ? SYSTEM_DEFAULT_AGENT_ID
    : value;
};

const normalizeAuthorityHomeServerSetting = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
};

const normalizeTonePresetSetting = (value: unknown): TonePreset => {
  switch (value) {
    case "professional":
    case "friendly":
    case "direct":
    case "pragmatic":
    case "default":
      return value;
    default:
      return DEFAULT_USER_PREFERENCE_PROFILE.tone?.preset ?? "default";
  }
};

const normalizePolicyLevelSetting = (
  value: unknown,
  fallback: KnowledgeCaptureLevel | SpaceContextLevel
): KnowledgeCaptureLevel | SpaceContextLevel => {
  const n = Number(value);
  if (n === 1 || n === 2 || n === 3 || n === 4) {
    return n;
  }
  return fallback;
};

const resolveDefaultAgentIdSetting = (value: unknown): string =>
  normalizeDefaultAgentIdSetting(value) ?? SYSTEM_DEFAULT_AGENT_ID;

const selectResolvedDefaultAgentId = (value: unknown): string => {
  const normalizedValue = resolveDefaultAgentIdSetting(value);
  return normalizedValue === SYSTEM_DEFAULT_AGENT_ID
    ? noloAgentId
    : normalizedValue;
};

const hexToRgbString = (value?: string): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^#/, "");
  const safe = normalized.length === 3
    ? normalized
        .split("")
        .map((char) => char + char)
        .join("")
    : normalized;

  if (!/^[0-9a-fA-F]{6}$/.test(safe)) return null;

  const intValue = Number.parseInt(safe, 16);
  const r = (intValue >> 16) & 255;
  const g = (intValue >> 8) & 255;
  const b = intValue & 255;
  return `${r}, ${g}, ${b}`;
};

const alphaColor = (hex: string | undefined, alpha: number, fallback: string): string => {
  const rgb = hexToRgbString(hex);
  return rgb ? `rgba(${rgb}, ${alpha})` : fallback;
};

const getCachedDefaultAgentRegisterRecord = (
  getState: () => RootState,
  registerKey: string
) => {
  const record = getState().db.entities[registerKey];
  return record && typeof record === "object" ? record : null;
};

const persistDefaultAgentRegister = async (
  dispatch: any,
  getState: () => RootState,
  userId: string,
  value: string | null,
) => {
  const registerKey = createUserPreferenceKey.defaultAgent(userId);
  let previousRecord = getCachedDefaultAgentRegisterRecord(getState, registerKey);
  if (!previousRecord) {
    previousRecord = await dispatch(getSettingDbActionThunks().readAndWait(registerKey))
      .unwrap()
      .catch(() => null);
  }

  const previousValue =
    readUserPreferenceRegisterValue<string>(
      previousRecord,
      USER_PREFERENCE_NAMES.DEFAULT_AGENT
    ) ?? null;
  if (previousRecord && previousValue === value) {
    return;
  }

  await dispatch(
    getSettingDbActionThunks().write({
      customKey: registerKey,
      data: buildDefaultAgentPreferenceRegisterRecord({
        userId,
        defaultAgentId: value,
        previousRecord,
      }),
    })
  ).unwrap();
};

const omitKeys = <T extends Record<string, any>>(
  record: T,
  keys: readonly string[],
) => {
  const next = { ...record };
  keys.forEach((key) => {
    delete next[key];
  });
  return next;
};

const normalizeSettingChanges = (
  changes: Partial<SettingState>
): Partial<SettingState> => {
  let normalizedChanges = changes;

  if (hasOwn(normalizedChanges, "sidebarVisibleTypes")) {
    normalizedChanges = {
      ...normalizedChanges,
      sidebarVisibleTypes: normalizeSidebarVisibleTypesSetting(
        normalizedChanges.sidebarVisibleTypes
      ),
    };
  }

  if (hasOwn(normalizedChanges, "defaultAgentId")) {
    normalizedChanges = {
      ...normalizedChanges,
      defaultAgentId: normalizeDefaultAgentIdSetting(
        normalizedChanges.defaultAgentId
      ),
    };
  }

  if (hasOwn(normalizedChanges, "defaultSpaceId")) {
    normalizedChanges = {
      ...normalizedChanges,
      defaultSpaceId: normalizeDefaultSpaceIdPreference(
        normalizedChanges.defaultSpaceId
      ),
    };
  }

  if (hasOwn(normalizedChanges, "themeName")) {
    const themeName = normalizeThemeName(normalizedChanges.themeName);
    normalizedChanges = themeName
      ? {
          ...normalizedChanges,
          themeName,
        }
      : omitKeys(normalizedChanges, ["themeName"]);
  }

  if (hasOwn(normalizedChanges, "fontPreset")) {
    const fontPreset = normalizeFontPreset(normalizedChanges.fontPreset);
    normalizedChanges = fontPreset
      ? {
          ...normalizedChanges,
          fontPreset,
        }
      : omitKeys(normalizedChanges, ["fontPreset"]);
  }

  if (hasOwn(normalizedChanges, "userTonePreset")) {
    normalizedChanges = {
      ...normalizedChanges,
      userTonePreset: normalizeTonePresetSetting(
        normalizedChanges.userTonePreset
      ),
    };
  }

  if (hasOwn(normalizedChanges, "knowledgeCaptureLevel")) {
    normalizedChanges = {
      ...normalizedChanges,
      knowledgeCaptureLevel: normalizePolicyLevelSetting(
        normalizedChanges.knowledgeCaptureLevel,
        DEFAULT_USER_PREFERENCE_PROFILE.knowledgeCaptureLevel
      ) as KnowledgeCaptureLevel,
    };
  }

  if (hasOwn(normalizedChanges, "spaceContextLevel")) {
    normalizedChanges = {
      ...normalizedChanges,
      spaceContextLevel: normalizePolicyLevelSetting(
        normalizedChanges.spaceContextLevel,
        DEFAULT_USER_PREFERENCE_PROFILE.spaceContextLevel
      ) as SpaceContextLevel,
    };
  }

  if (hasOwn(normalizedChanges, "autoApproveSelfUpdateFields")) {
    normalizedChanges = {
      ...normalizedChanges,
      autoApproveSelfUpdateFields: normalizeAgentUpdateFieldList(
        normalizedChanges.autoApproveSelfUpdateFields
      ),
    };
  }

  return normalizedChanges;
};

const LOCAL_FIRST_APPEARANCE_KEYS: ReadonlySet<keyof SettingState> = new Set([
  "themeName",
  "themeMode",
  "isDark",
  "density",
  "fontPreset",
]);

const LOCAL_ONLY_SETTINGS_KEYS: ReadonlySet<keyof SettingState> = new Set([
  "themeName",
  "themeMode",
  "isDark",
  "density",
  "fontPreset",
]);

const isLocalFirstAppearanceChange = (
  changes: Partial<SettingState>
): boolean => {
  const keys = Object.keys(changes) as Array<keyof SettingState>;
  return (
    keys.length > 0 &&
    keys.every((key) => LOCAL_FIRST_APPEARANCE_KEYS.has(key))
  );
};

const stripRegisterBackedFieldsFromSettingsWrite = (
  changes: Partial<SettingState>
): Partial<SettingState> => {
  return omitKeys(changes, [
    "defaultSpaceId",
    "userAuthorityRegistry",
    ...LOCAL_ONLY_SETTINGS_KEYS,
  ]);
};

const sanitizeStoredSettingsRecord = (
  settingsRecord: any
): Record<string, any> | null => {
  if (!settingsRecord || typeof settingsRecord !== "object") {
    return null;
  }

  const sanitizedSettings = omitKeys(settingsRecord, [
    "defaultSpaceId",
    "schemaVersion",
    ...LOCAL_ONLY_SETTINGS_KEYS,
  ]);
  return Object.keys(sanitizedSettings).length > 0 ? sanitizedSettings : null;
};

export const hydrateStoredSettings = ({
  userId,
  settingsRecord,
  defaultSpaceId,
  authorityHomeServer,
}: {
  userId?: string | null;
  settingsRecord: any;
  defaultSpaceId?: string | null;
  authorityHomeServer?: string | null;
}): Record<string, any> | null => {
  const resolvedDefaultAgentId =
    normalizeDefaultAgentIdSetting(settingsRecord?.defaultAgentId) ??
    SYSTEM_DEFAULT_AGENT_ID;

  const baseSettings = sanitizeStoredSettingsRecord(settingsRecord) ?? {};
  const normalizedAuthorityHome =
    normalizeAuthorityHomeServerSetting(authorityHomeServer);
  const userAuthorityRegistry =
    userId && normalizedAuthorityHome
      ? {
          ...((baseSettings.userAuthorityRegistry &&
          typeof baseSettings.userAuthorityRegistry === "object")
            ? baseSettings.userAuthorityRegistry
            : {}),
          [userId]: normalizedAuthorityHome,
        }
      : baseSettings.userAuthorityRegistry;
  const hydratedSettings = {
    ...baseSettings,
    ...(userAuthorityRegistry ? { userAuthorityRegistry } : {}),
    defaultSpaceId: normalizeDefaultSpaceIdPreference(defaultSpaceId) ?? null,
    defaultAgentId: resolvedDefaultAgentId,
  };

  return Object.keys(hydratedSettings).length > 0 ? hydratedSettings : null;
};

export const buildSettingsPersistencePlan = ({
  userId,
  currentSettings,
  changes,
  previousDefaultAgentRecord,
}: {
  userId: string;
  currentSettings: Partial<SettingState>;
  changes: Partial<SettingState>;
  previousDefaultAgentRecord: any;
}) => {
  const normalizedChanges = normalizeSettingChanges(changes);
  const persistedChanges =
    stripRegisterBackedFieldsFromSettingsWrite(normalizedChanges);
  const previousDefaultAgentId =
    normalizeDefaultAgentIdSetting(currentSettings.defaultAgentId) ??
    SYSTEM_DEFAULT_AGENT_ID;
  const nextDefaultAgentId =
    normalizeDefaultAgentIdSetting(normalizedChanges.defaultAgentId) ?? null;

  const previousDefaultAgentValue =
    readUserPreferenceRegisterValue<string>(
      previousDefaultAgentRecord,
      USER_PREFERENCE_NAMES.DEFAULT_AGENT
    ) ?? null;

  const defaultAgentRegisterWrite =
    hasOwn(normalizedChanges, "defaultAgentId") &&
    previousDefaultAgentId !== (nextDefaultAgentId ?? SYSTEM_DEFAULT_AGENT_ID) &&
    (!previousDefaultAgentRecord || previousDefaultAgentValue !== nextDefaultAgentId)
      ? {
          customKey: createUserPreferenceKey.defaultAgent(userId),
          data: buildDefaultAgentPreferenceRegisterRecord({
            userId,
            defaultAgentId: nextDefaultAgentId,
            previousRecord: previousDefaultAgentRecord,
          }),
        }
      : null;

  const settingsPatch =
    Object.keys(persistedChanges).length > 0
      ? {
          dbKey: createUserKey.settings(userId),
          changes: withSettingsRecordSchema(persistedChanges),
        }
      : null;

  return {
    normalizedChanges,
    defaultAgentRegisterWrite,
    settingsPatch,
  };
};

const settingSlice = createSliceWithThunks({
  name: "settings",
  initialState,
  reducers: (create) => ({
    _updateSettingsState: (
      state,
      action: PayloadAction<Partial<SettingState>>
    ) => {
      Object.assign(state, normalizeSettingChanges(action.payload));
    },
    clearDefaultSpaceId: (state) => {
      state.defaultSpaceId = initialState.defaultSpaceId;
    },
    addHostToCurrentServer: (state, action: PayloadAction<string>) => {
      const rawValue = action.payload;
      if (typeof rawValue !== "string" || rawValue.trim() === "") return;

      const trimmed = rawValue.trim();
      if (/^https?:\/\//i.test(trimmed)) {
        try {
          state.currentServer = new URL(trimmed).origin;
          return;
        } catch {
          return;
        }
      }

      const host = trimmed.replace(/^\/+|\/+$/g, "");
      const [hostname] = host.split(":");
      if (!hostname) return;
      const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
      const isLocal =
        ["nolotus.local", "localhost"].includes(hostname) || isIpAddress;
      const protocol = isLocal ? "http" : "https";
      state.currentServer = `${protocol}://${host}`;
    },
    getSettings: create.asyncThunk(
      async (_, { dispatch, getState }) => {
        const userId = selectUserId(getState() as RootState);
        if (!userId) return null;
        const settingsKey = createUserKey.settings(userId);
        const authorityHomeKey = createUserPreferenceKey.authorityHome(userId);
        const [settingsRecord, defaultSpaceId, authorityHomeRecord] = await Promise.all([
          dispatch(getSettingDbActionThunks().readAndWait(settingsKey))
            .unwrap()
            .catch(() => null),
          readDefaultSpaceIdPreference(dispatch, userId),
          dispatch(getSettingDbActionThunks().readAndWait(authorityHomeKey))
            .unwrap()
            .catch(() => null),
        ]);
        const authorityHomeServer =
          readUserPreferenceRegisterValue<string>(
            authorityHomeRecord,
            USER_PREFERENCE_NAMES.AUTHORITY_HOME
          ) ?? null;

        return hydrateStoredSettings({
          userId,
          settingsRecord,
          defaultSpaceId,
          authorityHomeServer,
        });
      },
      {
        fulfilled: (state, action) => {
          if (action.payload) {
            const normalizedPayload = normalizeSettingChanges(
              action.payload as Partial<SettingState>
            );
            const { currentServer: _ignored, ...settingsToApply } = normalizedPayload;
            Object.assign(state, settingsToApply);
          }
        },
      }
    ),
    setSettings: create.asyncThunk(
      async (changes: Partial<SettingState>, { dispatch, getState }) => {
        const currentSettings = (getState() as RootState).settings;
        const normalizedChanges = normalizeSettingChanges(changes);
        const nextDefaultSpaceId =
          normalizeDefaultSpaceIdPreference(normalizedChanges.defaultSpaceId) ??
          null;
        const previousDefaultAgentId =
          normalizeDefaultAgentIdSetting(
            currentSettings.defaultAgentId,
          ) ?? SYSTEM_DEFAULT_AGENT_ID;
        const userId = selectUserId(getState() as RootState);
        if (!userId) {
          if (!isLocalFirstAppearanceChange(normalizedChanges)) {
            throw new Error("User not found for persisting settings.");
          }

          dispatch(settingSlice.actions._updateSettingsState(normalizedChanges));
          return normalizedChanges;
        }
        const persistencePlan = buildSettingsPersistencePlan({
          userId,
          currentSettings,
          changes: normalizedChanges,
          previousDefaultAgentRecord: null,
        });
        dispatch(settingSlice.actions._updateSettingsState(persistencePlan.normalizedChanges));
        if (hasOwn(changes, "defaultSpaceId")) {
          await persistDefaultSpacePreference(
            dispatch,
            userId,
            nextDefaultSpaceId
          );
        }
        const nextDefaultAgentId =
          normalizeDefaultAgentIdSetting(persistencePlan.normalizedChanges.defaultAgentId) ??
          null;
        if (
          hasOwn(changes, "defaultAgentId") &&
          previousDefaultAgentId !== (nextDefaultAgentId ?? SYSTEM_DEFAULT_AGENT_ID)
        ) {
          await persistDefaultAgentRegister(
            dispatch,
            () => getState() as RootState,
            userId,
            nextDefaultAgentId,
          );
        }
        if (persistencePlan.settingsPatch) {
          await dispatch(
            getSettingDbActionThunks().upsert({
              dbKey: persistencePlan.settingsPatch.dbKey,
              data: persistencePlan.settingsPatch.changes,
            })
          ).unwrap();
        }
        return persistencePlan.normalizedChanges;
      }
    ),
    changeTheme: create.asyncThunk(
      async (themeName: keyof typeof THEME_COLORS, { dispatch }) =>
        dispatch(setSettings({ themeName })).unwrap()
    ),
    changeDensity: create.asyncThunk(
      async (density: "compact" | "spacious", { dispatch }) =>
        dispatch(setSettings({ density })).unwrap()
    ),
    changeFontPreset: create.asyncThunk(
      async (fontPreset: FontPreset, { dispatch }) =>
        dispatch(setSettings({ fontPreset })).unwrap()
    ),
    changeDarkMode: create.asyncThunk(async (isDark: boolean, { dispatch }) =>
      dispatch(setSettings({ isDark, themeMode: isDark ? "dark" : "light" })).unwrap()
    ),
    toggleShowThinking: create.asyncThunk(async (_, { dispatch, getState }) => {
      const currentShowThinking = (getState() as RootState).settings
        .showThinking;
      return dispatch(
        setSettings({ showThinking: !currentShowThinking })
      ).unwrap();
    }),
    setThemeFollowsSystem: create.asyncThunk(
      async (follows: boolean, { dispatch }) =>
        dispatch(setSettings({ themeMode: follows ? "system" : "light" })).unwrap()
    ),
    setSidebarWidth: create.asyncThunk(
      async (sidebarWidth: number, { dispatch }) =>
        dispatch(setSettings({ sidebarWidth })).unwrap()
    ),
    toggleEnableReadCurrentSpace: create.asyncThunk(
      async (_, { dispatch, getState }) => {
        const current = (getState() as RootState).settings
          .enableReadCurrentSpace;
        return dispatch(
          setSettings({
            enableReadCurrentSpace: !current,
            spaceContextLevel: current ? 1 : DEFAULT_USER_PREFERENCE_PROFILE.spaceContextLevel,
          })
        ).unwrap();
      }
    ),
    setEditorDefaultMode: create.asyncThunk(
      async (mode: "markdown" | "block", { dispatch }) =>
        dispatch(setSettings({ editorDefaultMode: mode })).unwrap()
    ),
    setEditorLightCodeTheme: create.asyncThunk(
      async (theme: string, { dispatch }) =>
        dispatch(setSettings({ editorLightCodeTheme: theme })).unwrap()
    ),
    setEditorDarkCodeTheme: create.asyncThunk(
      async (theme: string, { dispatch }) =>
        dispatch(setSettings({ editorDarkCodeTheme: theme })).unwrap()
    ),
    setEditorCodeTheme: create.asyncThunk(async (theme: string, { dispatch }) =>
      dispatch(
        setSettings({
          editorLightCodeTheme: theme,
          editorDarkCodeTheme: theme,
        })
      ).unwrap()
    ),
    toggleEditorWordCount: create.asyncThunk(
      async (_, { dispatch, getState }) => {
        const current = (getState() as RootState).settings
          .editorWordCountEnabled;
        return dispatch(
          setSettings({ editorWordCountEnabled: !current })
        ).unwrap();
      }
    ),
    toggleEditorShortcut: create.asyncThunk(
      async (key: string, { dispatch, getState }) => {
        const currentShortcuts = (getState() as RootState).settings
          .editorShortcuts;
        const newShortcuts = {
          ...currentShortcuts,
          [key]: !currentShortcuts[key],
        };
        return dispatch(
          setSettings({ editorShortcuts: newShortcuts })
        ).unwrap();
      }
    ),
    setEditorFontSize: create.asyncThunk(
      async (fontSize: number, { dispatch }) =>
        dispatch(setSettings({ editorFontSize: fontSize })).unwrap()
    ),
    toggleEditorAutoSave: create.asyncThunk(
      async (_, { dispatch, getState }) => {
        const current = (getState() as RootState).settings.editorAutoSave;
        return dispatch(setSettings({ editorAutoSave: !current })).unwrap();
      }
    ),
    setEditorAutoSaveInterval: create.asyncThunk(
      async (interval: number, { dispatch }) =>
        dispatch(setSettings({ editorAutoSaveInterval: interval })).unwrap()
    ),
    setGlobalPrompt: create.asyncThunk(
      async (prompt: string, { dispatch }) =>
        dispatch(setSettings({ globalPrompt: prompt })).unwrap()
    ),
    setUserTonePreset: create.asyncThunk(
      async (tone: TonePreset, { dispatch }) =>
        dispatch(setSettings({ userTonePreset: tone })).unwrap()
    ),
    setKnowledgeCaptureLevel: create.asyncThunk(
      async (level: KnowledgeCaptureLevel, { dispatch }) =>
        dispatch(setSettings({ knowledgeCaptureLevel: level })).unwrap()
    ),
    setSpaceContextLevel: create.asyncThunk(
      async (level: SpaceContextLevel, { dispatch }) =>
        dispatch(
          setSettings({
            spaceContextLevel: level,
            enableReadCurrentSpace: level > 1,
          })
        ).unwrap()
    ),
    // ADDED action
    setAiRecentContentLimit: create.asyncThunk(
      async (limit: number, { dispatch }) =>
        dispatch(setSettings({ aiRecentContentLimit: limit })).unwrap()
    ),
    setContextRetention: create.asyncThunk(
      async (retention: number, { dispatch }) =>
        dispatch(setSettings({ contextRetention: retention })).unwrap()
    ),
    setMaxExecutionTime: create.asyncThunk(
      async (time: number, { dispatch }) =>
        dispatch(setSettings({ maxExecutionTime: time })).unwrap()
    ),
    setDefaultAgentId: create.asyncThunk(
      async (agentId: string, { dispatch }) =>
        dispatch(setSettings({ defaultAgentId: agentId })).unwrap()
    ),
    setPreferredAnimationSet: create.asyncThunk(
      async (index: number, { dispatch }) =>
        dispatch(setSettings({ preferredAnimationSet: index })).unwrap()
    ),
    setThemeMode: create.asyncThunk(
      async (mode: "system" | "light" | "dark", { dispatch }) => {
        const changes: Partial<SettingState> = { themeMode: mode };
        const systemPrefersDark =
          typeof window !== "undefined" &&
          window.matchMedia(SYSTEM_DARK_MEDIA_QUERY).matches;
        changes.isDark = resolveThemeModeIsDark(mode, systemPrefersDark);
        return dispatch(setSettings(changes)).unwrap();
      }
    ),
  }),
});

// --- 导出 Actions ---
export const {
  getSettings,
  setSettings,
  clearDefaultSpaceId,
  addHostToCurrentServer,
  changeTheme,
  changeDensity,
  changeFontPreset,
  changeDarkMode,
  toggleShowThinking,
  setThemeFollowsSystem,
  setSidebarWidth,
  toggleEnableReadCurrentSpace,
  setEditorDefaultMode,
  setEditorLightCodeTheme,
  setEditorDarkCodeTheme,
  setEditorCodeTheme,
  toggleEditorWordCount,
  toggleEditorShortcut,
  setEditorFontSize,
  toggleEditorAutoSave,
  setEditorAutoSaveInterval,
  setGlobalPrompt,
  setUserTonePreset,
  setKnowledgeCaptureLevel,
  setSpaceContextLevel,
  setAiRecentContentLimit,
  setContextRetention, // ADDED
  setMaxExecutionTime,
  setDefaultAgentId,
  setPreferredAnimationSet,
  setThemeMode,
} = settingSlice.actions;

// --- 导出 Selectors ---
export const selectSettings = (state: RootState) => state.settings;
const isLocalServerUrl = (value: string | undefined): boolean => {
  if (typeof value !== "string") return false;
  return /^https?:\/\/(?:(?:\d{1,3}\.){3}\d{1,3}|localhost|nolotus\.local)(?::\d+)?$/i.test(
    value.trim()
  );
};

const resolveDesktopSafeServer = (value: string | undefined): string => {
  if (!getIsDesktopApp()) return value || SERVERS.MAIN;
  return isLocalServerUrl(value) ? SERVERS.MAIN : value || SERVERS.MAIN;
};

export const selectCurrentServer = createSelector(
  [selectSettings],
  (settings) => resolveDesktopSafeServer(settings.currentServer)
);
export const selectSyncServers = createSelector([selectSettings], (settings): string[] =>
  (settings.syncServers || []).filter(
    (server) => !getIsDesktopApp() || !isLocalServerUrl(server)
  )
);
export const selectRemoteServer = selectCurrentServer;
export const selectRemoteSyncServers = selectSyncServers;
export const selectRemoteServers = createSelector(
  [selectRemoteServer, selectRemoteSyncServers],
  (currentServer, syncServers) => getAllServers(currentServer, syncServers)
);
export const selectDefaultSpaceId = (
  state: RootState
): string | null | undefined => state.settings.defaultSpaceId;

export const selectPreferredAnimationSet = (state: RootState): number =>
  state.settings.preferredAnimationSet ?? DEFAULT_ANIMATION_SET_INDEX;
export const selectShowThinking = (state: RootState): boolean =>
  state.settings.showThinking;
export const selectMaxCost = (state: RootState): number =>
  state.settings.maxCost;
export const selectMaxExecutionTime = (state: RootState): number =>
  state.settings.maxExecutionTime;
export const selectIsDark = (state: RootState): boolean =>
  state.settings.isDark;
export const selectThemeMode = (state: RootState): "system" | "light" | "dark" =>
  state.settings.themeMode ?? "system";
export const selectHeaderHeight = (state: RootState): number =>
  state.settings.headerHeight;
export const selectThemeName = (state: RootState): keyof typeof THEME_COLORS =>
  state.settings.themeName;
export const selectThemeFollowsSystem = (state: RootState): boolean =>
  (state.settings.themeMode ?? "system") === "system";
export const selectSidebarWidth = (state: RootState): number =>
  state.settings.sidebarWidth;
export const selectDensity = (state: RootState): "compact" | "spacious" =>
  state.settings.density ?? "compact";
export const selectFontPreset = (state: RootState): FontPreset =>
  normalizeFontPreset(state.settings.fontPreset) ?? DEFAULT_FONT_PRESET;
export const selectEnableReadCurrentSpace = (state: RootState): boolean =>
  state.settings.enableReadCurrentSpace;
export const selectSidebarVisibleTypes = createSelector(
  [(state: RootState) => state.settings.sidebarVisibleTypes],
  (sidebarVisibleTypes): SidebarVisibleType[] =>
    normalizeSidebarVisibleTypesSetting(sidebarVisibleTypes)
);
export const selectGlobalPrompt = (state: RootState): string =>
  state.settings.globalPrompt;
export const selectUserTonePreset = (state: RootState): TonePreset =>
  normalizeTonePresetSetting(state.settings.userTonePreset);
export const selectKnowledgeCaptureLevel = (
  state: RootState
): KnowledgeCaptureLevel =>
  normalizePolicyLevelSetting(
    state.settings.knowledgeCaptureLevel,
    DEFAULT_USER_PREFERENCE_PROFILE.knowledgeCaptureLevel
  ) as KnowledgeCaptureLevel;
export const selectSpaceContextLevel = (
  state: RootState
): SpaceContextLevel =>
  state.settings.enableReadCurrentSpace === false
    ? 1
    :
  normalizePolicyLevelSetting(
    state.settings.spaceContextLevel,
    DEFAULT_USER_PREFERENCE_PROFILE.spaceContextLevel
  ) as SpaceContextLevel;
export const selectAutoApproveSelfUpdateFields = createSelector(
  [(state: RootState) => state.settings.autoApproveSelfUpdateFields],
  (fields) =>
    normalizeAgentUpdateFieldList(
      fields,
      DEFAULT_AUTO_APPROVED_SELF_UPDATE_FIELDS
    )
);
export const selectAiRecentContentLimit = (state: RootState): number =>
  state.settings.aiRecentContentLimit ?? 50; // ADDED
export const selectContextRetention = (state: RootState): number =>
  state.settings.contextRetention ?? 50;
export const selectDefaultAgentPreference = (state: RootState): string =>
  resolveDefaultAgentIdSetting(state.settings.defaultAgentId);
export const selectDefaultAgentId = (state: RootState): string =>
  selectResolvedDefaultAgentId(state.settings.defaultAgentId);

export const selectOcrModel = (
  state: RootState
): "none" | "google_document_ocr" | "olm_ocr" => {
  if (state.settings.ocrModel === "none") return "none";
  if (state.settings.ocrModel === "olm_ocr") return "olm_ocr";
  return "google_document_ocr";
};

export const selectShowScrollToTopButton = (state: RootState): boolean =>
  state.settings.showScrollToTopButton ?? false;
export const selectShowScrollToBottomButton = (state: RootState): boolean =>
  state.settings.showScrollToBottomButton ?? false;
export const selectCreateMenuOpenCount = (state: RootState): number => {
  const value = Number(state.settings.createMenuOpenCount);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
};
export const selectDesktopChromeConnectorEnabled = (state: RootState): boolean =>
  state.settings.desktopChromeConnectorEnabled === true;


export const selectEditorDefaultMode = (
  state: RootState
): "markdown" | "block" => state.settings.editorDefaultMode;
export const selectEditorLightCodeTheme = (state: RootState): string =>
  state.settings.editorLightCodeTheme;
export const selectEditorDarkCodeTheme = (state: RootState): string =>
  state.settings.editorDarkCodeTheme;
export const selectEditorCodeTheme = createSelector(
  [selectEditorLightCodeTheme, selectEditorDarkCodeTheme, selectIsDark],
  (lightTheme, darkTheme, isDark) => (isDark ? darkTheme : lightTheme)
);
export const selectEditorWordCountEnabled = (state: RootState): boolean =>
  state.settings.editorWordCountEnabled;
export const selectEditorShortcuts = (state: RootState) =>
  state.settings.editorShortcuts;
export const selectDeleteShortcut = (state: RootState): string =>
  state.settings.deleteShortcut;
export const selectEditorFontSize = (state: RootState): number =>
  state.settings.editorFontSize;
export const selectEditorAutoSave = (state: RootState): boolean =>
  state.settings.editorAutoSave;
export const selectEditorAutoSaveInterval = (state: RootState): number =>
  state.settings.editorAutoSaveInterval;

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
    const mode = isDark ? "dark" : "light";
    const validThemeName = THEME_COLORS[themeName]
      ? themeName
      : DEFAULT_THEME_NAME;
    const validFontPreset =
      normalizeFontPreset(fontPreset) ?? DEFAULT_FONT_PRESET;
    const themeData = THEME_COLORS[validThemeName];
    const c = themeData[mode] as (typeof themeData)[typeof mode] & { textHeading?: string };
    const meta = (themeData as any).meta as { radiusBoost?: number; motionEase?: string } | undefined;
    const compact = density === "compact";
    return {
      sidebarWidth: `${sidebarWidth}px`,
      headerHeight: `${headerHeight}px`,
      sidebarItemHeight: compact ? "36px" : "40px",
      sidebarIconSize: compact ? "18px" : "20px",
      sidebarItemGap: compact ? "2px" : "4px",
      // Density-aware spacing scale (4px grid → 5px grid)
      space: compact
        ? SPACE
        : {
            0: "0", 1: "5px", 2: "10px", 3: "14px", 4: "20px", 5: "24px",
            6: "30px", 7: "34px", 8: "40px", 10: "50px", 12: "60px",
            14: "70px", 16: "80px", 20: "100px", 24: "120px",
          },
      // Semantic typography scale
      fontSize: {
        xs:   compact ? "11px" : "12px",
        sm:   compact ? "12px" : "13px",
        base: compact ? "14px" : "15px",
        md:   compact ? "14px" : "15.5px",
        lg:   compact ? "16px" : "17.5px",
        xl:   compact ? "20px" : "22px",
        "2xl": compact ? "24px" : "26px",
      },
      // Semantic line-height scale
      leading: {
        tight:   compact ? "1.3"  : "1.4",
        normal:  compact ? "1.45" : "1.6",
        relaxed: compact ? "1.6"  : "1.75",
      },
      // Component height scale (buttons, inputs, list items)
      control: {
        xs: compact ? "24px" : "28px",
        sm: compact ? "28px" : "32px",
        md: compact ? "36px" : "40px",
        lg: compact ? "40px" : "46px",
        xl: compact ? "48px" : "56px",
      },
      // Border radius scale — xs/sm/md map to control/surface/overlay tiers.
      // lg/xl remain as aliases for gradual migration of legacy CSS.
      radius: (() => {
        const boost = meta?.radiusBoost ?? 0;
        const xs = compact ? "10px" : "12px";
        const sm = compact ? `${14 + boost}px` : `${16 + boost}px`;
        const md = compact ? "20px" : "24px";
        return { xs, sm, md, lg: sm, xl: md };
      })(),
      motionEase: meta?.motionEase ?? "cubic-bezier(0.33, 0, 0.2, 1)",
      motionEaseTide: "cubic-bezier(0.22, 1, 0.36, 1)",
      motionEaseBreath: "cubic-bezier(0.4, 0, 0.6, 1)",
      motionDuration: "0.32s",
      motionDurationSlow: "0.52s",
      font: FONT_PRESET_CSS_VARIABLES[validFontPreset],
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
      surfaceInset: isDark ? c.backgroundSecondary : alphaColor(c.borderHover, 0.05, c.codeBackground),
      surfaceCode: c.codeBackground,
      surfaceInteractive: c.backgroundTertiary,
      surfaceInteractiveHover: c.backgroundHover,
      textMuted: c.textSecondary,
      textSubtle: c.textTertiary,
      textHeading: c.textHeading ?? c.text,
      borderMuted: alphaColor(c.borderHover, isDark ? 0.3 : 0.24, c.borderLight),
      accentSoft: alphaColor(c.primary, isDark ? 0.18 : 0.1, c.primaryGhost),
      shadow: c.shadowMedium,
      shadow1: `0 1px 2px ${c.shadowLight}`,
      shadow2: `0 8px 24px -12px ${c.shadowMedium}`,
      shadow3: `0 18px 44px -24px ${c.shadowHeavy}`,
      primaryBorder: c.borderAccent ?? c.primary,
      primaryBgStrong: alphaColor(c.primary, isDark ? 0.18 : 0.1, c.primaryGhost),
      success: c.success,
      warning: c.warning,
      info: c.info,
      successGhost: alphaColor(c.success, isDark ? 0.2 : 0.12, "rgba(16, 185, 129, 0.12)"),
      warningGhost: alphaColor(c.warning, isDark ? 0.2 : 0.12, "rgba(245, 158, 11, 0.12)"),
      infoGhost: alphaColor(c.info, isDark ? 0.2 : 0.12, "rgba(59, 130, 246, 0.12)"),
      errorGhost: alphaColor(c.error, isDark ? 0.2 : 0.12, "rgba(239, 68, 68, 0.12)"),
      primaryRgb: hexToRgbString(c.primary) ?? "59, 130, 246",
      focusRing: alphaColor(c.primary, isDark ? 0.3 : 0.22, c.primaryGhost),
    };
  }
);

export const selectEditorConfig = createSelector(
  [
    selectEditorDefaultMode,
    selectEditorLightCodeTheme,
    selectEditorDarkCodeTheme,
    selectEditorWordCountEnabled,
    selectEditorShortcuts,
    selectEditorFontSize,
    selectEditorAutoSave,
    selectEditorAutoSaveInterval,
    selectIsDark,
  ],
  (
    defaultMode,
    lightCodeTheme,
    darkCodeTheme,
    wordCountEnabled,
    shortcuts,
    fontSize,
    autoSave,
    autoSaveInterval,
    isDark
  ) => {
    const codeTheme = isDark ? darkCodeTheme : lightCodeTheme;
    return {
      defaultMode,
      codeTheme,
      lightCodeTheme,
      darkCodeTheme,
      wordCountEnabled,
      shortcuts,
      fontSize,
      autoSave,
      autoSaveInterval,
    };
  }
);

export default settingSlice.reducer;
