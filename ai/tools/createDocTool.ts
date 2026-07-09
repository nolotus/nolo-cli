// 文件路径: ai/tools/createDocTool.ts

import { createDoc } from "../../render/page/docSlice";
import { selectCurrentSpaceId } from "../../create/space/spaceSlice";
import type { RootState } from "../../app/store";

export interface CreateDocToolArgs {
  title?: string;
  spaceId?: string;
  categoryId?: string;
  content?: string;
}


export const createDocFunctionSchema = {
  name: "createDoc",
  description: [
    "在当前空间中创建一个新文档（page），可以指定标题、分类和初始内容。",
    "如果需要绑定到指定分类，请先通过其它工具（如 createCategory / queryContentsByCategory）获取真实的 categoryId 再调用本工具。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "页面标题。如果未提供，将在执行器中使用默认标题（例如“新页面”或日期格式）。",
      },
      spaceId: {
        type: "string",
        description: [
          "可选：要创建到哪个 space。",
          "优先级：如果传了真实 spaceId，就用它；如果不传，则优先使用当前已选中的 space；如果当前也没有 space，则仍允许创建为不归属任何 space 的文档。",
          '不需要指定时传空字符串 ""。',
        ].join("\n"),
      },
      categoryId: {
        type: "string",
        description: [
          "页面所属的分类ID（数据库中的真实 ID）：",
          "- 只有在你已经从其它工具的结果或用户输入中拿到 categoryId 时，才填写真实 ID；",
          '- 如果目前没有可用的分类ID（模型自己想的名称不算），请传空字符串 ""。',
        ].join("\n"),
      },
      content: {
        type: "string",
        description: [
          "页面的初始内容，使用 Markdown 格式。",
          "支持 mention 语法引用其他资源，格式：@[type:dbKey|显示标签]",
          "支持的类型：",
          "- @[page:PAGE-xxx|标题]     引用另一个页面，读取时会展开页面内容",
          "- @[agent:agent-xxx|名称]   引用一个 Agent，可作为 reference 挂载",
          "- @[space:space-xxx|名称]   引用一个 Space 目录",
          "例：@[page:PAGE-abc|产品规范] @[agent:agent-xyz|写作助手]",
          "不需要初始内容时传空字符串 \"\"。",
        ].join("\n"),
      },
    },
    required: ["title", "categoryId", "content"],
  } as const,
};

/**
 * [Executor] 'createDoc' 工具的执行函数。
 * @param args - LLM 提供的参数: { title?: string, categoryId?: string, content?: string }
 * @param thunkApi - Redux Thunk API
 * @returns {Promise<{rawData: unknown, displayData: string}>}
 */
export async function createDocFunc(
  args: CreateDocToolArgs,
  thunkApi: any
): Promise<{ rawData: unknown; displayData: string }> {
  const { getState } = thunkApi;
  const dispatch = thunkApi.dispatch.bind(thunkApi) as any;
  const state = getState() as RootState;

  console.log("[createDocTool] Received args:", args);

  // 为参数提供默认值和安全处理
  const rawTitle = (args.title ?? "").trim();
  const title = rawTitle || "新页面";

  const rawCategoryId = (args.categoryId ?? "").trim();
  // 空字符串视为“未指定分类”，交给后续 createPageAction 进一步校验过滤
  const categoryId = rawCategoryId || undefined;

  const explicitSpaceId = (args.spaceId ?? "").trim() || undefined;
  const currentSpaceId = selectCurrentSpaceId(state) || undefined;
  const spaceId = explicitSpaceId ?? currentSpaceId;

  const rawContent = (args.content ?? "").trim();
  const content = rawContent || undefined;

  try {
    console.log("[createDocTool] dispatching createDoc with:", {
      title,
      spaceId,
      categoryId,
      content,
    });
    const id = await dispatch(
      (createDoc as any)({ title, spaceId, categoryId, content })
    ).unwrap();

    console.log("[createDocTool] createDoc success, id:", id);

    const rawData = {
      success: true,
      id,
      dbKey: id,
      title,
      spaceId: spaceId ?? null,
      categoryId: categoryId ?? null,
    };

    const displayData = categoryId
      ? `页面《${title}》已成功创建并关联到分类。`
      : `页面《${title}》已成功创建。`;

    return { rawData, displayData };
  } catch (error: any) {
    console.error("[createDocTool] Error creating doc:", error);
    const msg =
      typeof error?.message === "string" ? error.message : JSON.stringify(error);
    throw new Error(`创建文档时出错: ${msg}`);
  }
}

// backward-compat aliases
/** @deprecated use createDocFunctionSchema */
export const createPageFunctionSchema = createDocFunctionSchema;
/** @deprecated use createDocFunc */
export { createDocFunc as createPageFunc };
