import { readAction } from "../../database/actions/read";
import type { PageData } from "../../render/page/types";
import { diagnoseSkillDocument } from "../skills/skillDiagnostics";

export interface DoctorSkillToolArgs {
  id?: string;
  content?: string;
}

export const doctorSkillFunctionSchema = {
  name: "doctorSkill",
  description:
    "检查一个 skill 文档的协议、工具绑定和常见问题，返回错误、警告和改进建议。",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "可选：本地 skill 文档的 dbKey（如 page-xxx）。",
      },
      content: {
        type: "string",
        description: "可选：直接传入 skill markdown 内容进行诊断。",
      },
    },
  } as const,
};

export async function doctorSkillFunc(
  args: DoctorSkillToolArgs,
  thunkApi: any
): Promise<{ rawData: unknown; displayData: string }> {
  const { id, content } = args;
  if (!id && !content?.trim()) {
    throw new Error("doctorSkill 需要提供 id 或 content。");
  }

  let page: PageData | undefined;
  if (id) {
    page = (await readAction({ dbKey: id }, thunkApi)) as PageData;
    if (!page) {
      throw new Error(`未找到 skill 文档：${id}`);
    }
  }

  const result = await diagnoseSkillDocument(
    {
      id: page?.dbKey ?? id,
      title: page?.title,
      content: content ?? page?.content ?? "",
      meta: page?.meta,
      tools: page?.tools,
    }
  );

  const lines = [
    `Skill 检查：${result.name ?? result.skillId ?? id ?? "inline-skill"}`,
    `- 状态: ${result.ok ? "通过" : "存在错误"}`,
    `- 归一化工具: ${result.canonicalToolNames.join(", ") || "(无)"}`,
    `- Eval 用例数: ${result.evalCaseCount}`,
    ...(result.errors.length ? ["- 错误:", ...result.errors.map((item) => `  - ${item}`)] : []),
    ...(result.warnings.length
      ? ["- 警告:", ...result.warnings.map((item) => `  - ${item}`)]
      : []),
    ...(result.notes.length ? ["- 建议:", ...result.notes.map((item) => `  - ${item}`)] : []),
  ];

  return {
    rawData: result,
    displayData: lines.join("\n"),
  };
}
