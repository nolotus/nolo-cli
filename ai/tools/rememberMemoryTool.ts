import { selectCurrentSpaceId } from "../../create/space/spaceSlice";
import { getActiveDialogKey } from "../../chat/dialog/dialogRuntimeStore";
import { selectById } from "../../database/dbSlice";
import type { DialogConfig } from "../../app/types";
import { resolveDialogMemorySubjectId } from "../../chat/dialog/dialogAgentPolicy";
import { callToolApi } from "./toolApiClient";
import type { RememberMemoryScope } from "../memory/remember";
import type { MemoryKind } from "../memory/types";

export interface RememberMemoryToolArgs {
  content: string;
  scope?: RememberMemoryScope;
  kind?: MemoryKind;
}

// Schema 定义在无依赖的姊妹模块里，供 CLI/desktop 本地 runtime 复用
// （本模块 import 了 Redux，只有渲染进程能加载）。
export { rememberMemoryFunctionSchema } from "./rememberMemoryToolSchema";

export async function rememberMemoryFunc(
  args: RememberMemoryToolArgs,
  thunkApi: any
): Promise<{ rawData: unknown; displayData: string }> {
  const state = thunkApi.getState();
  const spaceId = selectCurrentSpaceId(state) || undefined;
  const content = String(args.content ?? "").trim();
  const scope = args.scope ?? "auto";
  const dialogKey = getActiveDialogKey();
  const dialog = dialogKey
    ? (selectById(state, dialogKey) as DialogConfig | null)
    : null;
  const kind = args.kind ?? "episodic";

  if (!content) {
    throw new Error("rememberMemory 需要非空 content。");
  }

  const result = await callToolApi<{
    success: boolean;
    content: string;
    requestedScope: RememberMemoryScope;
    resolvedScopes: Array<{ ownerType: string; ownerId: string }>;
  }>(
    thunkApi,
    "/api/memory/remember",
    {
      content,
      scope,
      kind,
      spaceId,
      ...(scope === "auto"
        ? { memorySubjectId: resolveDialogMemorySubjectId(dialog) }
        : {}),
    },
    { withAuth: true }
  );

  const scopeLabel =
    result.resolvedScopes?.[0]?.ownerType === "space" ? "当前空间" : "当前用户";

  return {
    rawData: result,
    displayData: `已记住这条${scopeLabel}记忆。`,
  };
}
