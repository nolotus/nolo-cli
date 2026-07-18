import { createDoc } from "../../render/page/docSlice";
import { selectCurrentSpaceId } from "../../create/space/spaceSlice";
import type { RootState } from "../../app/store";
import { asTrimmedString } from "../../core/trimmedString";
import { canonicalizeToolNames } from "./toolNameAliases";
import {
  buildSkillDocMarkdown,
  parseExternalSkillMarkdown,
  type SkillDocConfig,
} from "../skills/skillDocProtocol";
import { buildSkillFollowupResult } from "./skillFollowup";

export interface ImportSkillToolArgs {
  url?: string;
  content?: string;
  title?: string;
  spaceId?: string;
  categoryId?: string;
}

const normalizeUrl = (rawUrl: string): string => {
  const trimmed = rawUrl.trim();
  const githubBlobMatch = trimmed.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/
  );
  if (githubBlobMatch) {
    const [, owner, repo, ref, path] = githubBlobMatch;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
  }
  return trimmed;
};

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "imported-skill";

const mapImportedTools = (toolNames: string[]): string[] =>
  canonicalizeToolNames(
    toolNames.filter((toolName) => /^[a-zA-Z0-9_-]+$/.test(toolName))
  );

export const importSkillFunctionSchema = {
  name: "importSkill",
  description: [
    "从外部 SKILL.md、GitHub 地址或原始 Markdown 文本导入一个 skill，并保存为当前空间中的普通文档。",
    "导入后会自动附加隐藏的 skill-config 协议块；无法映射的脚本环境会降级为说明型 skill。",
    "导入成功后，如果用户还没说明下一步，优先调用 ui_ask_choice 继续询问：仅保存、挂到现有 Agent，还是新建一个 Agent 来使用它。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "可选：远程 SKILL.md 地址。支持 raw GitHub URL，也支持 github.com/.../blob/... 链接。",
      },
      content: {
        type: "string",
        description:
          "可选：原始 SKILL.md 或普通 Markdown 内容。如果提供，则优先使用它而不是 url。",
      },
      title: {
        type: "string",
        description: "可选：导入后文档标题。未提供时优先使用外部 skill name。",
      },
      spaceId: {
        type: "string",
        description: '可选：目标 spaceId；不传则优先使用当前 space。可传空字符串 ""。',
      },
      categoryId: {
        type: "string",
        description: '可选：目标分类 categoryId；不传时传空字符串 ""。',
      },
    },
  } as const,
};

export async function importSkillFunc(
  args: ImportSkillToolArgs,
  thunkApi: any
): Promise<{ rawData: unknown; displayData: string }> {
  const { dispatch, getState } = thunkApi;
  const state = getState() as RootState;
  const explicitContent = asTrimmedString(args.content);
  const url = typeof args.url === "string" ? normalizeUrl(args.url) : "";

  if (!explicitContent && !url) {
    throw new Error("importSkill 需要提供 content 或 url。");
  }

  let rawMarkdown = explicitContent;
  if (!rawMarkdown) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`导入 skill 失败：HTTP ${response.status}`);
    }
    rawMarkdown = (await response.text()).trim();
  }

  const parsed = parseExternalSkillMarkdown(rawMarkdown);
  const docTitle =
    (args.title ?? "").trim() ||
    parsed.name ||
    "Imported Skill";
  const normalizedTools = mapImportedTools(parsed.allowedTools);
  const description =
    parsed.description ||
    "Imported external skill. Review instructions and mapped tools before using it in agents.";
  const skillConfig: SkillDocConfig = {
    version: "0.1",
    kind: "skill",
    id: slugify(parsed.name || docTitle),
    name: parsed.name || docTitle,
    description,
    triggerMode: "explicit",
    toolNames: normalizedTools,
    budgetTier: "medium",
    dispatchPreferred: false,
    modalities: ["text"],
  };

  const importedBody = [
    parsed.body,
    parsed.compatibility ? `\n## Compatibility\n${parsed.compatibility}` : "",
    url ? `\nImported from: ${url}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const content = buildSkillDocMarkdown({
    body: importedBody,
    skillConfig,
  });

  const explicitSpaceId = (args.spaceId ?? "").trim() || undefined;
  const currentSpaceId = selectCurrentSpaceId(state) || undefined;
  const spaceId = explicitSpaceId ?? currentSpaceId;
  const categoryId = (args.categoryId ?? "").trim() || undefined;

  const createDocResult = await (dispatch as any)(
    (createDoc as any)({
      title: docTitle,
      spaceId,
      categoryId,
      content,
    })
  );
  const id = await createDocResult.unwrap();

  return buildSkillFollowupResult({
    dbKey: id,
    title: docTitle,
    skillId: skillConfig.id,
    spaceId: spaceId ?? null,
    toolNames: normalizedTools,
    importedFrom: url || null,
    hasEvalConfig: false,
  });
}
