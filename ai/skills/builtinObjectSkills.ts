/**
 * Builtin object assistant skill definitions (doc + table + code).
 *
 * These skill pages are referenced by the builtin object assistant agents
 * instead of carrying tool lists directly on the agent record.
 */

import type { ReferenceItem } from "../../app/types";
import { DataType } from "../../create/types";
import { createKey } from "../../database/keys";
import { buildSkillDocMarkdown, type SkillDocConfig } from "./skillDocProtocol";

export const BUILTIN_OBJECT_SKILL_IDS = {
  table: "builtin-table-skill-v1",
  doc: "builtin-doc-skill-v1",
  code: "builtin-code-skill-v1",
} as const;

export function buildBuiltinObjectSkillDbKey(
  kind: "doc" | "table" | "code",
  userId: string,
): string {
  const skillId = BUILTIN_OBJECT_SKILL_IDS[kind];
  return createKey(DataType.DOC, userId, skillId);
}

export function buildBuiltinObjectSkillReference(
  kind: "doc" | "table" | "code",
  userId: string,
): ReferenceItem {
  const dbKey = buildBuiltinObjectSkillDbKey(kind, userId);
  const title =
    kind === "doc"
      ? "文档编辑技能"
      : kind === "table"
        ? "表格编辑技能"
        : "编码风格技能";
  return { dbKey, title, type: "instruction" };
}

function buildDocSkillConfig(): SkillDocConfig {
  return {
    version: "0.1",
    kind: "skill",
    id: BUILTIN_OBJECT_SKILL_IDS.doc,
    name: "文档编辑技能",
    description: "提供文档读取与更新能力，供文档助手使用。",
    triggerMode: "explicit",
    toolNames: ["readDoc", "updateDoc"],
    promptPatch: [
      "文档编辑指南：",
      "1. 修改前先 readDoc 读取当前文档真值，再基于现有内容用 updateDoc 做定点增量编辑。",
      "2. 不要脱离现有内容空想重写；润色/改写/续写都应保留用户原有的结构与事实。",
    ].join("\n"),
    discover: {
      keywords: ["文档", "润色", "改写", "续写", "排版", "文章", "document", "polish"],
    },
  };
}

function buildTableSkillConfig(): SkillDocConfig {
  return {
    version: "0.1",
    kind: "skill",
    id: BUILTIN_OBJECT_SKILL_IDS.table,
    name: "表格编辑技能",
    description: "提供表格创建、查询、新增、更新与删除能力，供表格助手使用。",
    triggerMode: "explicit",
    toolNames: [
      "createTable",
      "addTableRow",
      "addTableRows",
      "queryTableRows",
      "updateTableRow",
      "deleteTableRow",
    ],
    promptPatch: [
      "表格操作指南：",
      "1. 用户要新建表格时，调用 createTable，并从需求推断合理的字段设计（字段名、类型、必填、可选值）。",
      "2. 新增记录必须调用 addTableRow / addTableRows，不要只在回答里口头描述。",
      "3. addTableRow 的 values 是对象，key 必须用字段名（name，不是显示名 label）；尽量从用户自然语言推断并填满相关字段，必填字段尤其注意；用户没提到的字段可用空字符串或 null 占位；绝不要传空对象 {}。",
      "4. 更新或删除前，先用 queryTableRows 确认目标行，必要时向用户确认目标行/字段。",
    ].join("\n"),
    discover: {
      keywords: ["表格", "建表", "新增一行", "记录", "字段", "table", "spreadsheet", "csv"],
    },
  };
}

function buildCodeSkillConfig(): SkillDocConfig {
  return {
    version: "0.1",
    kind: "skill",
    id: BUILTIN_OBJECT_SKILL_IDS.code,
    name: "编码风格技能",
    description: "提供编码规范与风格约束，供代码任务使用。",
    triggerMode: "explicit",
    toolNames: [],
    promptPatch: [
      "编码风格与规范指南：",
      "1. 文件拆分：优先拆分为多文件（MANY SMALL FILES），典型长度 200-400 行，单文件最多 800 行（800 max）。",
      "2. 函数与嵌套：函数保持短小（<50 lines），优先使用 early returns 提前返回，嵌套层级不超过 4 层（nesting ≤4）。",
      "3. 不可变性（immutability）：保持数据不可变，不要原地 mutate 现有对象或数组，必须返回新对象/数组。",
      "4. 错误处理与校验：显式处理所有错误（explicit error handling），在系统边界完成校验（validate at boundaries），不隐式吞错。",
      "5. 完成前 Checklist：完成前自查函数/文件尺寸、嵌套深度、不可变性与边界错误处理。",
    ].join("\n"),
    discover: {
      keywords: ["代码", "编码", "重构", "修bug", "code", "refactor", "bugfix", "coding-style"],
    },
  };
}

function buildDocSkillPageContent(): string {
  const skillConfig = buildDocSkillConfig();
  return buildSkillDocMarkdown({
    body: "# 文档编辑技能\n\n提供文档读取与更新能力。",
    skillConfig,
  });
}

function buildTableSkillPageContent(): string {
  const skillConfig = buildTableSkillConfig();
  return buildSkillDocMarkdown({
    body: "# 表格编辑技能\n\n提供表格创建、查询、新增、更新与删除能力。",
    skillConfig,
  });
}

function buildCodeSkillPageContent(): string {
  const skillConfig = buildCodeSkillConfig();
  return buildSkillDocMarkdown({
    body: "# 编码风格技能\n\n提供编码规范与风格约束。",
    skillConfig,
  });
}

/** 生成内置 skill page 的 content（含 skill-config 协议块），供落库与测试共用。 */
export function buildBuiltinObjectSkillPageContent(
  kind: "doc" | "table" | "code",
): string {
  if (kind === "doc") return buildDocSkillPageContent();
  if (kind === "table") return buildTableSkillPageContent();
  return buildCodeSkillPageContent();
}

/**
 * Ensure builtin object skill pages exist for the given userId.
 * Returns a thunk suitable for dispatch.
 */
export function ensureBuiltinObjectSkills(
  userId: string,
): (dispatch: any) => Promise<void> {
  return async (dispatch: any) => {
    const { readAndWait, write } = await import("../../database/dbSlice");

    const now = Date.now();
    const skills: Array<{
      kind: "doc" | "table" | "code";
      dbKey: string;
      title: string;
      content: string;
    }> = [
      {
        kind: "doc",
        dbKey: buildBuiltinObjectSkillDbKey("doc", userId),
        title: "文档编辑技能",
        content: buildBuiltinObjectSkillPageContent("doc"),
      },
      {
        kind: "table",
        dbKey: buildBuiltinObjectSkillDbKey("table", userId),
        title: "表格编辑技能",
        content: buildBuiltinObjectSkillPageContent("table"),
      },
      {
        kind: "code",
        dbKey: buildBuiltinObjectSkillDbKey("code", userId),
        title: "编码风格技能",
        content: buildBuiltinObjectSkillPageContent("code"),
      },
    ];

    for (const skill of skills) {
      try {
        const existing = await dispatch(readAndWait(skill.dbKey))
          .unwrap()
          .catch(() => null);
        if (!existing) {
          await dispatch(
            write({
              data: {
                id: BUILTIN_OBJECT_SKILL_IDS[skill.kind],
                dbKey: skill.dbKey,
                type: DataType.DOC,
                userId,
                title: skill.title,
                content: skill.content,
                created: new Date(now).toISOString(),
                createdAt: now,
                updatedAt: String(now),
              },
              customKey: skill.dbKey,
            }),
          ).unwrap();
        }
      } catch {
        // best-effort; caller handles errors
      }
    }
  };
}
