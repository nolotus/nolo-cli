import { callToolApi } from "./toolApiClient";
import type { MemoryKind } from "../memory/types";

export interface DeleteMemoryToolArgs {
  ids?: string[];
  contentKeyword?: string;
  kinds?: MemoryKind[];
  tags?: string[];
  confirmed?: boolean;
  deletionToken?: string;
  reason: string;
}

// Schema 定义在无依赖的姊妹模块里，供 CLI/desktop 本地 runtime 复用。
export { deleteMemoryFunctionSchema } from "./deleteMemoryToolSchema";

export async function deleteMemoryFunc(
  args: DeleteMemoryToolArgs,
  thunkApi: any
): Promise<{ rawData: unknown; displayData: string }> {
  const reason = String(args.reason ?? "").trim();
  if (!reason && !args.ids?.length && !args.contentKeyword && !args.tags?.length) {
    throw new Error("deleteMemory 需要提供明确的删除原因与至少一项过滤条件（ids、contentKeyword 或 tags）。");
  }

  const isConfirmed = args.confirmed === true;
  if (isConfirmed && !args.deletionToken?.trim()) {
    throw new Error(
      "deleteMemory 在确认删除阶段（confirmed: true）必须提供预检阶段获取的 deletionToken。请先调用本工具进行预检预览。"
    );
  }

  const result = await callToolApi<{
    success: boolean;
    dryRun?: boolean;
    matchedCount: number;
    deletedCount: number;
    deletedIds: string[];
    deletionToken?: string;
    preview?: Array<{ id: string; content: string; kind: string }>;
  }>(
    thunkApi,
    "/api/memory/delete",
    {
      ids: args.ids,
      contentSubstring: args.contentKeyword,
      kinds: args.kinds,
      tags: args.tags,
      dryRun: !isConfirmed,
      deletionToken: args.deletionToken,
      reason,
    },
    { withAuth: true }
  );

  if (!result || result.success === false) {
    throw new Error("删除长期记忆请求未成功完成。");
  }

  if (!isConfirmed) {
    const matched = result.matchedCount ?? 0;
    if (matched === 0) {
      return {
        rawData: result,
        displayData: "未找到匹配的记忆，无需删除。",
      };
    }
    const previewList = (result.preview ?? [])
      .map((item, idx) => `${idx + 1}. [${item.kind}] ${item.content}`)
      .join("\n");
    return {
      rawData: result,
      displayData: [
        `【待用户确认】匹配到 ${matched} 条符合条件的记忆，即将物理删除。`,
        previewList ? `预览前 ${result.preview?.length} 条：\n${previewList}` : "",
        `这是不可逆操作。请向用户展示上述预览并获得明确确认。确认后，请传入 confirmed: true${result.deletionToken ? ` 与 deletionToken: "${result.deletionToken}"` : ""} 再次调用本工具。`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  const count = result.deletedCount ?? 0;
  return {
    rawData: result,
    displayData: `已在用户权限范围内确认并物理删除 ${count} 条记忆。`,
  };
}
