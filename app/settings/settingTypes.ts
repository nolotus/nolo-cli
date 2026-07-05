// packages/app/settings/settingTypes.ts
//
// 单一职责：声明 settings slice 的 Redux state 形状 + 共享常量。
// 不依赖任何业务模块,只 import 主题/字体/策略相关类型。

import type { FontPreset } from "../theme/fontPreference";
import type { THEME_COLORS } from "../theme/theme.config";
import type {
  KnowledgeCaptureLevel,
  SpaceContextLevel,
  TonePreset,
} from "../../ai/policy/types";
import type { AgentUpdateField } from "../../ai/policy/selfUpdateFields";

export interface SettingState {
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

  // 通用提示词
  globalPrompt: string;

  // 用户偏好的语气 preset(尽量通用,不覆盖 agent 自身人格)
  userTonePreset: TonePreset;

  // AI 对知识沉淀(doc/table)的主动程度
  knowledgeCaptureLevel: KnowledgeCaptureLevel;

  // AI 使用当前空间作为上下文的积极程度
  spaceContextLevel: SpaceContextLevel;

  // updateSelf 默认哪些字段不再询问
  autoApproveSelfUpdateFields: AgentUpdateField[];

  // AI Recent Content Limit
  aiRecentContentLimit: number;

  // 上下文保留程度 1-100(默认 50)
  // 值越高 = 保留越多历史上下文,新对话空间越小
  contextRetention: number;

  // 默认启动的智能体 ID
  defaultAgentId?: string;

  // 快速对话「快速」档使用的智能体 ID;SYSTEM_DEFAULT_AGENT_ID 表示回退到 nolo
  flashAgentId?: string;

  // 快速对话「平衡」档使用的智能体 ID;SYSTEM_DEFAULT_AGENT_ID 表示回退到 nolo
  balancedAgentId?: string;

  // 快速对话「质量」档使用的智能体 ID;SYSTEM_DEFAULT_AGENT_ID 表示回退到 nolo
  qualityAgentId?: string;

  // 快速对话「图片」档使用的智能体 ID;SYSTEM_DEFAULT_AGENT_ID 表示回退到 nolo
  imageAgentId?: string;

  // PDF OCR 模型选择("none" 表示不使用 OCR,用 pdf.js 提取文本)
  ocrModel: "none" | "google_document_ocr" | "olm_ocr";

  // 对话页面快捷滚动按钮
  showScrollToTopButton: boolean;
  showScrollToBottomButton: boolean;
  createMenuOpenCount: number;
  desktopChromeConnectorEnabled: boolean;
  deleteShortcut: string;

  // 用户-服务 authority 映射(仅在 hydrateStoredSettings 时填入;不入设置 record)
  userAuthorityRegistry?: Record<string, string>;

  [key: string]: unknown;
}

export const SYSTEM_DEFAULT_AGENT_ID = "system-default";
