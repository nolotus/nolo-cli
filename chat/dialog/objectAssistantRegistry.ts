import type { Agent } from "../../app/types";
import type { AgentRuntimeOptions } from "../../ai/agent/types";
import { DataType } from "../../create/types";
import { createAgentKey } from "../../database/keys";
import { APP_BUILDER_PUBLIC_AGENT_KEY } from "../../app/constants/appEditor";
import { buildBuiltinObjectSkillReference } from "../../ai/skills/builtinObjectSkills";

import {
  PLATFORM_HOSTED_GLM_52_MODEL,
  PLATFORM_HOSTED_GLM_PRICE,
} from "../../ai/llm/platformHosted";
import { PLATFORM_HOSTED_KIMI_PROVIDER } from "../../ai/llm/kimi";

export type ObjectAssistantKind = "page" | "table" | "app" | "image" | "file";
export type BuiltinObjectAssistantKind = Exclude<ObjectAssistantKind, "app">;

export const OBJECT_ASSISTANT_SIDEBAR_PREFIX = "objectAssistant";

export const BUILTIN_OBJECT_ASSISTANT_IDS: Record<BuiltinObjectAssistantKind, string> = {
  page: "builtin-doc-assistant-v1",
  table: "builtin-table-assistant-v1",
  image: "builtin-image-assistant-v1",
  file: "builtin-file-assistant-v1",
};

type ObjectAssistantUiConfig = {
  panelTitle: string;
  activePanelTitle: string;
  loginMessage: string;
  emptyMessage: string;
};

const OBJECT_ASSISTANT_UI: Record<ObjectAssistantKind, ObjectAssistantUiConfig> = {
  app: {
    panelTitle: "应用助手",
    activePanelTitle: "应用助手",
    loginMessage: "登录后可在侧边栏使用助手继续修改当前应用",
    emptyMessage: "还没有收藏 AI 助手，先去 AI 广场逛逛吧",
  },
  page: {
    panelTitle: "文档助手",
    activePanelTitle: "文档助手",
    loginMessage: "登录后可在侧边栏使用文档助手",
    emptyMessage: "文档助手暂时不可用，请稍后重试",
  },
  table: {
    panelTitle: "表格助手",
    activePanelTitle: "表格助手",
    loginMessage: "登录后可在侧边栏使用表格助手",
    emptyMessage: "表格助手暂时不可用，请稍后重试",
  },
  image: {
    panelTitle: "图片助手",
    activePanelTitle: "图片助手",
    loginMessage: "登录后可在侧边栏使用图片助手",
    emptyMessage: "图片助手暂时不可用，请稍后重试",
  },
  file: {
    panelTitle: "文件助手",
    activePanelTitle: "文件助手",
    loginMessage: "登录后可在侧边栏使用文件助手",
    emptyMessage: "文件助手暂时不可用，请稍后重试",
  },
};

export const getObjectAssistantUiConfig = (kind: ObjectAssistantKind): ObjectAssistantUiConfig =>
  OBJECT_ASSISTANT_UI[kind];

export const getPreferredObjectAssistantKey = (
  kind: ObjectAssistantKind,
  userId?: string | null,
): string[] => {
  if (kind === "app") return [APP_BUILDER_PUBLIC_AGENT_KEY];
  if (!userId) return [];
  return [createAgentKey.private(userId, BUILTIN_OBJECT_ASSISTANT_IDS[kind])];
};

export const buildObjectAssistantSidebarId = (
  kind: ObjectAssistantKind,
  contentKey?: string | null,
) => `${OBJECT_ASSISTANT_SIDEBAR_PREFIX}:${kind}:${contentKey ?? "current"}`;

export const isObjectAssistantSidebarId = (id?: string | null) =>
  typeof id === "string" && id.startsWith(`${OBJECT_ASSISTANT_SIDEBAR_PREFIX}:`);

export const resolveBuiltinObjectAssistantKindByKey = (
  agentKey?: string | null,
  userId?: string | null,
): BuiltinObjectAssistantKind | null => {
  if (!agentKey || !userId) return null;

  const entries = Object.entries(BUILTIN_OBJECT_ASSISTANT_IDS) as Array<
    [BuiltinObjectAssistantKind, string]
  >;

  for (const [kind, id] of entries) {
    if (agentKey === createAgentKey.private(userId, id)) {
      return kind;
    }
  }

  return null;
};

export const buildBuiltinObjectAssistantAgent = (
  kind: BuiltinObjectAssistantKind,
  userId: string,
): Agent & { dbKey: string } => {
  const id = BUILTIN_OBJECT_ASSISTANT_IDS[kind];
  const dbKey = createAgentKey.private(userId, id) as string;
  const now = Date.now();

  const common = {
    id,
    dbKey,
    type: DataType.AGENT,
    userId,
    isPublic: false,
    provider: PLATFORM_HOSTED_KIMI_PROVIDER,
    model: PLATFORM_HOSTED_GLM_52_MODEL,
    apiSource: "platform" as const,
    useServerProxy: true,
    inputPrice: PLATFORM_HOSTED_GLM_PRICE.input,
    outputPrice: PLATFORM_HOSTED_GLM_PRICE.output,
    createdAt: now,
    updatedAt: String(now),
    dialogCount: 0,
    messageCount: 0,
    tokenCount: 0,
    tags: ["builtin", "sidebar-assistant", kind],
  };

  switch (kind) {
    case "page":
      return {
        ...common,
        name: "文档助手",
        introduction: "帮你润色、改写、续写、整理结构与排版的文档助手。",
        greeting: {
          text:
            "你好，我是文档助手 ✍️\n\n你可以直接对我说：\n• 帮我润色这篇文章\n• 把结构整理得更清楚\n• 给这一段改成更口语/更专业\n• 帮我补一个开头或结尾",
          menu: [
            { id: "polish", label: "润色当前文档", userMessage: "帮我润色当前文档，让表达更顺" },
            { id: "structure", label: "整理结构", userMessage: "帮我整理当前文档结构，看看标题和段落怎么更清楚" },
            { id: "continue", label: "继续写", userMessage: "基于当前文档继续往下写" },
          ],
        },
        references: [buildBuiltinObjectSkillReference("doc", userId)],
        prompt:
          "你是一个文档编辑助手。优先基于当前文档做增量修改，不要脱离现有内容空想重写。重点帮助用户润色、改写、续写、重组结构、生成标题和摘要。涉及修改时，优先读取当前文档真值，再进行定点编辑。",
      };
    case "table":
      return {
        ...common,
        name: "表格助手",
        introduction: "帮你理解表结构、补数据、改数据和整理字段的表格助手。",
        greeting: {
          text:
            "你好，我是表格助手 📊\n\n你可以直接对我说：\n• 帮我看看这张表还缺什么字段\n• 给表里加一条记录\n• 把某一列统一改一下\n• 按这个条件帮我整理数据",
          menu: [
            { id: "inspect", label: "看看这张表", userMessage: "帮我看看当前这张表的结构和可改进点" },
            { id: "add-row", label: "新增数据", userMessage: "我想往当前表里新增一条数据" },
            { id: "fix-data", label: "批量改数据", userMessage: "我想修改当前表里的部分数据" },
          ],
        },
        references: [buildBuiltinObjectSkillReference("table", userId)],
        prompt:
          "你是一个表格编辑助手。优先帮助用户理解当前表的字段、记录和结构，然后再做新增、查询、更新或删除。对用户说“这个表里的 xxx 怎么怎么改”时，默认理解为当前聚焦或最近提到的表；必要时先确认目标行/字段。",
      };
    case "image":
      return {
        ...common,
        name: "图片助手",
        introduction: "当前先作为图片分析与处理建议入口，后续可扩展为更完整的图片工作流助手。",
        greeting:
          "你好，我是图片助手 🖼️\n\n目前我可以先帮你分析图片内容、提炼重点、给出命名/整理建议。后续我们再把更深的图片编辑工作流接上。",
        tools: [],
        prompt:
          "你是一个图片助手。当前阶段重点是围绕当前图片做理解、描述、整理建议和后续处理建议。不要假装已经具备复杂图片编辑能力；如果用户要更强操作，明确说明当前可做的是分析与组织。",
      };
    case "file":
      return {
        ...common,
        name: "文件助手",
        introduction: "当前先作为文件理解与处理建议入口，后续可扩展为更完整的文件工作流助手。",
        greeting:
          "你好，我是文件助手 📎\n\n目前我可以先帮你理解这个文件适合怎么处理、怎么提取信息、下一步应该做什么。后续我们再把更完整的文件处理流程接上。",
        tools: [],
        prompt:
          "你是一个文件助手。当前阶段重点是围绕当前文件提供理解、整理、提取与后续处理建议。不要假装已经完成文件内容解析；必要时明确告诉用户当前更多是占位型工作流入口。",
      };
  }
};

export const buildBuiltinObjectAssistantAgentFromKey = (
  agentKey?: string | null,
  userId?: string | null,
): (Agent & { dbKey: string }) | null => {
  const kind = resolveBuiltinObjectAssistantKindByKey(agentKey, userId);
  if (!kind || !userId) return null;
  return buildBuiltinObjectAssistantAgent(kind, userId);
};

type RuntimeArgs = {
  kind: ObjectAssistantKind;
  contentKey?: string | null;
  title?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown>;
};

export const buildObjectAssistantRuntimeOptions = (
  args: RuntimeArgs,
): AgentRuntimeOptions => {
  const { kind, contentKey, title, summary, metadata = {} } = args;

  if (kind === "app") {
    return {
      extraTools: [
        "appRead",
        "appFileList",
        "appFileSearch",
        "appFileRead",
        "appFileWrite",
        "appFileReplace",
        "appPreflight",
        "appDeploy",
        "openAIGptImage",
      ],
      editingTarget: {
        kind: "app",
        key: contentKey ?? undefined,
        title: title ?? undefined,
        summary: summary ?? "当前应用可通过 AI 继续修改与重新部署，请围绕已有实现做增量迭代。",
        metadata,
      },
    };
  }

  if (kind === "table") {
    return {
      editingTarget: {
        kind: "table",
        key: contentKey ?? undefined,
        title: title ?? undefined,
        summary:
          summary ??
          "当前对象是一张数据表。优先帮助用户理解字段、记录和结构，再做新增或修改。",
        metadata,
      },
    };
  }

  if (kind === "page") {
    return {
      editingTarget: {
        kind: "page",
        key: contentKey ?? undefined,
        title: title ?? undefined,
        summary:
          summary ??
          "当前对象是一篇文档。优先围绕现有内容做润色、改写、续写、重组和排版建议。",
        metadata,
      },
    };
  }

  return {
    editingTarget: {
      kind,
      key: contentKey ?? undefined,
      title: title ?? undefined,
      summary:
        summary ??
        (kind === "image"
          ? "当前对象是一张图片，当前阶段优先做理解、描述和整理建议。"
          : "当前对象是一个文件，当前阶段优先做理解、整理和处理建议。"),
      metadata,
    },
  };
};
