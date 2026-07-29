import { readAction } from "../../database/actions/read";
import type { PageData } from "../../render/page/types";
import { evaluateSkillDocument } from "../skills/skillDiagnostics";

export interface EvalSkillToolArgs {
  id?: string;
  content?: string;
}

export const evalSkillFunctionSchema = {
  name: "evalSkill",
  description:
    "根据 skill 的 eval-config 评估它当前的工具绑定与提示是否满足预期。",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "可选：本地 skill 文档的 dbKey（如 page-xxx）。",
      },
      content: {
        type: "string",
        description: "可选：直接传入 skill markdown 内容进行评估。",
      },
    },
  } as const,
};

export async function evalSkillFunc(
  args: EvalSkillToolArgs,
  thunkApi: any
): Promise<{ rawData: unknown; displayData: string }> {
  const { id, content } = args;
  if (!id && !content?.trim()) {
    throw new Error("evalSkill 需要提供 id 或 content。");
  }

  let page: PageData | undefined;
  if (id) {
    page = (await readAction({ dbKey: id }, thunkApi)) as PageData;
    if (!page) {
      throw new Error(`未找到 skill 文档：${id}`);
    }
  }

  const result = await evaluateSkillDocument(
    {
      id: page?.dbKey ?? id,
      title: page?.title,
      content: content ?? page?.content ?? "",
      meta: page?.meta,
      tools: page?.tools,
    },
    {
      loadPage: async (dbKey) => {
        try {
          return (await readAction({ dbKey }, thunkApi)) as PageData;
        } catch {
          return undefined;
        }
      },
    }
  );

  const lines = [
    `Skill 评估：${result.name ?? result.skillId ?? id ?? "inline-skill"}`,
    `- 状态: ${result.ok ? "通过" : "未通过"}`,
    `- 生效工具: ${result.effectiveTools.join(", ") || "(无)"}`,
    ...(result.missingReferences.length
      ? [`- 缺失依赖: ${result.missingReferences.join(", ")}`]
      : []),
    ...result.cases.map((testCase, index) =>
      [
        `- Case ${index + 1}: ${testCase.passed ? "PASS" : "FAIL"} :: ${testCase.input}`,
        ...(testCase.missingTools?.length
          ? [`  - missingTools: ${testCase.missingTools.join(", ")}`]
          : []),
        ...(testCase.missingSignals?.length
          ? [`  - missingSignals: ${testCase.missingSignals.join(", ")}`]
          : []),
        ...(testCase.forbiddenSignalsFound?.length
          ? [`  - forbiddenSignalsFound: ${testCase.forbiddenSignalsFound.join(", ")}`]
          : []),
      ].join("\n")
    ),
  ];

  return {
    rawData: result,
    displayData: lines.join("\n"),
  };
}
