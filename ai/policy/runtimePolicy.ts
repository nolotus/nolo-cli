import type { Agent } from "../../app/types";
import type {
  AgentBasePolicy,
  DialogPolicyState,
  KnowledgeCaptureLevel,
  SelfEvolutionMode,
  SpaceContextLevel,
  TonePreset,
  ToneResolutionMode,
  UserPreferenceProfile,
} from "./types";
import {
  DEFAULT_AGENT_BASE_POLICY,
  DEFAULT_USER_PREFERENCE_PROFILE,
} from "./types";

export type CaptureIntent = "none" | "possible" | "strong";
export type SpaceNeed = "none" | "light" | "deep";
export type KnowledgeCaptureMode = "blocked" | "ask" | "suggest" | "auto";

export interface ResolvedRuntimePolicy {
  tonePreset: TonePreset;
  toneResolutionMode: ToneResolutionMode;
  knowledgeCapture: {
    level: KnowledgeCaptureLevel;
    mode: KnowledgeCaptureMode;
    explicitRequest: boolean;
    maxAutoCreatesPerDialog: number;
    currentAutoCreates: number;
    captureIntent: CaptureIntent;
  };
  spaceContext: {
    level: SpaceContextLevel;
    explicitRequest: boolean;
    need: SpaceNeed;
    maxReadCallsPerTurn: number;
    maxReadCallsPerDialog: number;
    currentAutoReads: number;
    preloadSummaryCount: number;
    preloadBudgetRatio: number;
  };
  selfEvolutionMode: SelfEvolutionMode;
}

const clampLevel = <T extends 1 | 2 | 3 | 4>(
  value: unknown,
  fallback: T,
): T => {
  const n = Number(value);
  if (n === 1 || n === 2 || n === 3 || n === 4) {
    return n as T;
  }
  return fallback;
};

const normalizeTonePreset = (value: unknown, fallback: TonePreset): TonePreset => {
  switch (value) {
    case "professional":
    case "friendly":
    case "direct":
    case "pragmatic":
    case "default":
      return value;
    default:
      return fallback;
  }
};

const normalizeToneResolutionMode = (
  value: unknown,
  fallback: ToneResolutionMode,
): ToneResolutionMode => {
  switch (value) {
    case "agent_first":
    case "user_first":
    case "blend":
      return value;
    default:
      return fallback;
  }
};

const normalizeSelfEvolutionMode = (
  value: unknown,
  fallback: SelfEvolutionMode,
): SelfEvolutionMode => {
  switch (value) {
    case "none":
    case "knowledge_only":
    case "prompt_and_refs":
    case "full":
      return value;
    default:
      return fallback;
  }
};

export const resolveAgentBasePolicy = (agentConfig?: Agent | any): AgentBasePolicy => {
  const raw = agentConfig?.basePolicy ?? {};

  return {
    version: 1,
    tone: {
      preset: normalizeTonePreset(
        raw?.tone?.preset,
        DEFAULT_AGENT_BASE_POLICY.tone?.preset ?? "default",
      ),
      resolutionMode: normalizeToneResolutionMode(
        raw?.tone?.resolutionMode,
        DEFAULT_AGENT_BASE_POLICY.tone?.resolutionMode ?? "blend",
      ),
    },
    knowledgeCaptureMaxLevel: clampLevel(
      raw?.knowledgeCaptureMaxLevel,
      DEFAULT_AGENT_BASE_POLICY.knowledgeCaptureMaxLevel,
    ),
    spaceContextMaxLevel: clampLevel(
      raw?.spaceContextMaxLevel,
      DEFAULT_AGENT_BASE_POLICY.spaceContextMaxLevel,
    ),
    selfEvolutionMode: normalizeSelfEvolutionMode(
      raw?.selfEvolutionMode,
      DEFAULT_AGENT_BASE_POLICY.selfEvolutionMode,
    ),
  };
};

export const resolveUserPreferenceProfile = (
  settingsRecord?: Record<string, any> | null,
): UserPreferenceProfile => {
  const fallbackSpaceLevel =
    settingsRecord?.enableReadCurrentSpace === false
      ? 1
      : DEFAULT_USER_PREFERENCE_PROFILE.spaceContextLevel;

  return {
    version: 1,
    tone: {
      preset: normalizeTonePreset(
        settingsRecord?.userTonePreset,
        DEFAULT_USER_PREFERENCE_PROFILE.tone?.preset ?? "default",
      ),
    },
    knowledgeCaptureLevel: clampLevel(
      settingsRecord?.knowledgeCaptureLevel,
      DEFAULT_USER_PREFERENCE_PROFILE.knowledgeCaptureLevel,
    ),
    spaceContextLevel: clampLevel(
      settingsRecord?.spaceContextLevel,
      fallbackSpaceLevel,
    ),
  };
};

const containsAny = (text: string, patterns: string[]): boolean =>
  patterns.some((pattern) => text.includes(pattern));

const spaceNeedRank: Record<SpaceNeed, number> = {
  none: 0,
  light: 1,
  deep: 2,
};

const maxSpaceNeed = (left: SpaceNeed, right: SpaceNeed): SpaceNeed =>
  spaceNeedRank[left] >= spaceNeedRank[right] ? left : right;

const normalizeReferenceText = (value: unknown): string => {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return [
    record.title,
    record.name,
    record.type,
    record.dbKey,
    record.key,
  ]
    .filter((item): item is string => typeof item === "string")
    .join("\n");
};

export const inferCaptureIntent = (userInput: string): CaptureIntent => {
  const normalized = userInput.toLowerCase();

  if (
    containsAny(normalized, [
      "保存",
      "存一下",
      "沉淀",
      "记住",
      "写入文档",
      "建文档",
      "创建文档",
      "导入 skill",
      "导入这个 skill",
      "确认导入",
      "确认导入这个 skill",
      "导入这个技能",
      "确认导入这个技能",
      "创建 skill",
      "创建这个 skill",
      "skill 文档",
      "创建表格",
      "createtable",
      "addtablerow",
      "addtablerows",
      "建表",
      "建个表",
      "做个表",
      "做一张表",
      "写表",
      "写入表",
      "写入一行",
      "写入 table",
      "放到 table",
      "存到 table",
      "保存到 table",
      "记录下来",
      "采集",
      "做数据集",
      "做成数据集",
      "整理成数据集",
      "整理成表",
      "整理成一张表",
      "建立一个表",
      "建立一张表",
      "建立成表",
      "建立成一张表",
      "创建这个表格",
      "确认创建",
      "确认创建这张表格",
      "create doc",
      "import skill",
      "confirm import",
      "create skill",
      "create table",
      "write table",
      "save to table",
      "dataset",
      "save this",
      "remember this",
      "document this",
    ])
  ) {
    return "strong";
  }

  if (
    containsAny(normalized, [
      "总结",
      "方案",
      "调研",
      "规范",
      "会议纪要",
      "总结一下",
      "research",
      "proposal",
      "spec",
      "summary",
    ])
  ) {
    return "possible";
  }

  return "none";
};

export const inferSpaceNeed = (userInput: string): SpaceNeed => {
  const normalized = userInput.toLowerCase();

  if (
    containsAny(normalized, [
      "当前空间",
      "这个空间",
      "这些文档",
      "根据空间",
      "workspace",
      "current space",
      "these docs",
      "based on the docs",
    ])
  ) {
    return "deep";
  }

  if (
    containsAny(normalized, [
      "文档",
      "文件",
      "页面",
      "目录",
      "page",
      "pages",
      "docs",
      "files",
      "目录结构",
    ])
  ) {
    return "light";
  }

  return "none";
};

export const inferAgentSpaceNeed = (agentConfig?: Agent | any): SpaceNeed => {
  const references = Array.isArray(agentConfig?.references)
    ? agentConfig.references
    : [];
  if (!references.length) return "none";

  const combined = [
    agentConfig?.prompt,
    agentConfig?.systemPrompt,
    agentConfig?.instructions,
    agentConfig?.introduction,
    ...references.map(normalizeReferenceText),
  ]
    .filter((item): item is string => typeof item === "string")
    .join("\n")
    .toLowerCase();

  if (
    containsAny(combined, [
      "readDoc",
      "readdoc",
      "读取总索引",
      "读取对应 doc",
      "先读取",
      "课程资料",
      "挂载资料",
      "资料索引",
      "知识库",
      "总索引",
      "docs index",
      "doc index",
      "knowledge",
      "references",
      "source docs",
      "based on the docs",
    ])
  ) {
    return "deep";
  }

  return "light";
};

const resolveTonePreset = (
  agentTone: TonePreset,
  userTone: TonePreset,
  mode: ToneResolutionMode,
): TonePreset => {
  if (mode === "agent_first") {
    return agentTone === "default" ? userTone : agentTone;
  }
  if (mode === "user_first") {
    return userTone === "default" ? agentTone : userTone;
  }
  if (userTone !== "default") return userTone;
  return agentTone;
};

const maxReadCallsPerTurnByLevel = (
  level: SpaceContextLevel,
  need: SpaceNeed,
): number => {
  if (need === "deep") {
    return { 1: 3, 2: 4, 3: 6, 4: 8 }[level];
  }
  if (need === "light") {
    return { 1: 1, 2: 2, 3: 3, 4: 4 }[level];
  }
  return { 1: 0, 2: 0, 3: 1, 4: 2 }[level];
};

const maxReadCallsPerDialogByLevel = (
  level: SpaceContextLevel,
  need: SpaceNeed,
): number => {
  if (need === "deep") {
    return { 1: 6, 2: 10, 3: 16, 4: 24 }[level];
  }
  if (need === "light") {
    return { 1: 2, 2: 3, 3: 4, 4: 6 }[level];
  }
  return { 1: 0, 2: 0, 3: 2, 4: 4 }[level];
};

const preloadSummaryCountByLevel = (level: SpaceContextLevel): number =>
  ({ 1: 0, 2: 0, 3: 8, 4: 16 }[level]);

const preloadBudgetRatioByLevel = (level: SpaceContextLevel): number =>
  ({ 1: 0, 2: 0.01, 3: 0.04, 4: 0.08 }[level]);

const knowledgeCaptureLevelLabel = (level: KnowledgeCaptureLevel): string =>
  ({
    1: "不主动创建",
    2: "先问再创建",
    3: "回答后建议创建",
    4: "高价值结果可自动创建",
  })[level];

const spaceContextLevelLabel = (level: SpaceContextLevel): string =>
  ({
    1: "不自动读取",
    2: "只看结构和标题",
    3: "轻量读取",
    4: "自适应读取",
  })[level];

export const resolveRuntimePolicy = (params: {
  agentConfig?: Agent | any;
  settingsRecord?: Record<string, any> | null;
  userInput: string;
  dialogPolicyState?: DialogPolicyState | null;
}): ResolvedRuntimePolicy => {
  const { agentConfig, settingsRecord, userInput, dialogPolicyState } = params;

  const agentBasePolicy = resolveAgentBasePolicy(agentConfig);
  const userPreferenceProfile = resolveUserPreferenceProfile(settingsRecord);

  const knowledgeLevel = Math.min(
    agentBasePolicy.knowledgeCaptureMaxLevel,
    userPreferenceProfile.knowledgeCaptureLevel,
  ) as KnowledgeCaptureLevel;
  const spaceLevel = Math.min(
    agentBasePolicy.spaceContextMaxLevel,
    userPreferenceProfile.spaceContextLevel,
  ) as SpaceContextLevel;

  const captureIntent = inferCaptureIntent(userInput);
  const userSpaceNeed = inferSpaceNeed(userInput);
  const agentSpaceNeed = inferAgentSpaceNeed(agentConfig);
  const spaceNeed = maxSpaceNeed(userSpaceNeed, agentSpaceNeed);
  const explicitCaptureRequest = captureIntent === "strong";
  const explicitSpaceRequest = userSpaceNeed !== "none";

  const currentAutoCreates = Math.max(
    0,
    Number(dialogPolicyState?.autoKnowledgeCaptureCount ?? 0),
  );
  const currentAutoReads = Math.max(
    0,
    Number(dialogPolicyState?.autoSpaceReadCount ?? 0),
  );

  let knowledgeMode: KnowledgeCaptureMode = "blocked";
  if (explicitCaptureRequest) {
    knowledgeMode = "auto";
  } else if (knowledgeLevel === 2) {
    knowledgeMode = "ask";
  } else if (knowledgeLevel === 3) {
    knowledgeMode = "suggest";
  } else if (knowledgeLevel >= 4 && captureIntent !== "none") {
    knowledgeMode = "auto";
  }

  return {
    tonePreset: resolveTonePreset(
      agentBasePolicy.tone?.preset ?? "default",
      userPreferenceProfile.tone?.preset ?? "default",
      agentBasePolicy.tone?.resolutionMode ?? "blend",
    ),
    toneResolutionMode: agentBasePolicy.tone?.resolutionMode ?? "blend",
    knowledgeCapture: {
      level: knowledgeLevel,
      mode: knowledgeMode,
      explicitRequest: explicitCaptureRequest,
      maxAutoCreatesPerDialog: explicitCaptureRequest ? 99 : 1,
      currentAutoCreates,
      captureIntent,
    },
    spaceContext: {
      level: spaceLevel,
      explicitRequest: explicitSpaceRequest,
      need: spaceNeed,
      maxReadCallsPerTurn: maxReadCallsPerTurnByLevel(spaceLevel, spaceNeed),
      maxReadCallsPerDialog: maxReadCallsPerDialogByLevel(spaceLevel, spaceNeed),
      currentAutoReads,
      preloadSummaryCount: preloadSummaryCountByLevel(spaceLevel),
      preloadBudgetRatio: preloadBudgetRatioByLevel(spaceLevel),
    },
    selfEvolutionMode: agentBasePolicy.selfEvolutionMode,
  };
};

export const buildUserPolicyContext = (
  policy: ResolvedRuntimePolicy,
): string => {
  const lines = [
    `用户语气偏好：${policy.tonePreset}`,
    `知识沉淀级别：${policy.knowledgeCapture.level}（当前模式：${policy.knowledgeCapture.mode}）`,
    `空间上下文级别：${policy.spaceContext.level}（本轮最多自动 read ${policy.spaceContext.maxReadCallsPerTurn} 次）`,
    "如果工具返回 policy limit，不要重试同一路径，应改为解释限制、先给答案或向用户确认。",
  ];

  if (policy.knowledgeCapture.mode === "ask") {
    lines.push("当前用户偏好要求：创建知识文档前先询问用户。");
  } else if (policy.knowledgeCapture.mode === "suggest") {
    lines.push("当前用户偏好要求：先完成回答，再建议是否沉淀成文档/表格。");
  }

  return lines.join("\n");
};

export const buildStaticUserPolicyContext = (params: {
  agentConfig?: Agent | any;
  settingsRecord?: Record<string, any> | null;
}): string => {
  const agentBasePolicy = resolveAgentBasePolicy(params.agentConfig);
  const userPreferenceProfile = resolveUserPreferenceProfile(params.settingsRecord);
  const tonePreset = resolveTonePreset(
    agentBasePolicy.tone?.preset ?? "default",
    userPreferenceProfile.tone?.preset ?? "default",
    agentBasePolicy.tone?.resolutionMode ?? "blend",
  );
  const knowledgeLevel = Math.min(
    agentBasePolicy.knowledgeCaptureMaxLevel,
    userPreferenceProfile.knowledgeCaptureLevel,
  ) as KnowledgeCaptureLevel;
  const spaceLevel = Math.min(
    agentBasePolicy.spaceContextMaxLevel,
    userPreferenceProfile.spaceContextLevel,
  ) as SpaceContextLevel;

  return [
    `用户语气偏好：${tonePreset}`,
    `知识沉淀级别：${knowledgeLevel}（${knowledgeCaptureLevelLabel(knowledgeLevel)}）`,
    `空间上下文级别：${spaceLevel}（${spaceContextLevelLabel(spaceLevel)}）`,
    "请尽量保留 agent 自身角色设定，同时按用户偏好调整表达和自动化程度。",
  ].join("\n");
};

export const resolveSpaceContextPreloadPlan = (level: SpaceContextLevel) => ({
  preloadSummaryCount: preloadSummaryCountByLevel(level),
  preloadBudgetRatio: preloadBudgetRatioByLevel(level),
  includeRecentContent: level >= 3,
});

export const isBudgetedWorkspaceReadKey = (dbKey: string): boolean => {
  const normalized = dbKey.toLowerCase();
  return (
    normalized.startsWith("page-") ||
    normalized.startsWith("dialog-") ||
    normalized.startsWith("space-") ||
    normalized.startsWith("table-") ||
    normalized.startsWith("table_row-") ||
    normalized.startsWith("row-") ||
    normalized.startsWith("meta-")
  );
};
