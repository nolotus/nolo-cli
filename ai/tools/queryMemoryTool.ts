import { getCurrentSpaceId } from "../../create/space/spaceCurrentStore";
import { getActiveDialogKey } from "../../chat/dialog/dialogRuntimeStore";
import { selectById } from "../../database/dbSlice";
import type { DialogConfig } from "../../app/types";
import { resolveDialogRuntimeAgentKey } from "../../chat/dialog/dialogAgentPolicy";
import { callToolApi } from "./toolApiClient";

export { queryMemoryFunctionSchema } from "./queryMemoryToolSchema";

export async function queryMemoryFunc(
  args: { query: string },
  thunkApi: any,
): Promise<{ rawData: unknown; displayData: string }> {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("queryMemory 需要非空 query。");

  const state = thunkApi.getState();
  const dialogKey = getActiveDialogKey();
  const dialog = dialogKey
    ? (selectById(state, dialogKey) as DialogConfig | null)
    : null;
  const result = await callToolApi(
    thunkApi,
    "/api/memory/query",
    {
      agentKey: resolveDialogRuntimeAgentKey(dialog),
      userInput: query,
      ...(getCurrentSpaceId()
        ? { spaceId: getCurrentSpaceId() }
        : {}),
    },
    { withAuth: true },
  );

  const selectedItems = Array.isArray(result?.selectedItems)
    ? result.selectedItems
    : [];
  const displayData = selectedItems.length
    ? selectedItems
        .map((item: any) => String(item?.content ?? "").trim())
        .filter(Boolean)
        .join("\n")
    : "没有找到相关长期记忆。";
  return { rawData: result, displayData };
}
