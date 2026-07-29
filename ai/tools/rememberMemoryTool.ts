import { selectCurrentSpaceId } from "../../create/space/spaceSlice";
import { callToolApi } from "./toolApiClient";
import type { RememberMemoryScope } from "../memory/remember";
import type { MemoryKind } from "../memory/types";

export interface RememberMemoryToolArgs {
  content: string;
  scope?: RememberMemoryScope;
  kind?: MemoryKind;
}

export const rememberMemoryFunctionSchema = {
  name: "rememberMemory",
  description: [
    "当你判断某条用户偏好、纠正、决策习惯或当前 Space 共识值得被长期记住时，调用本工具写入一条 memory。",
    "默认先记原始事件，不要把一次性临时要求、当前任务进度或明显短期信息写进去。",
    "只有重复出现的可执行流程/排障步骤才传 kind=procedural；一般偏好和事实保持默认 episodic。",
    "scope 按内容性质选，不固定优先某一层：",
    "  - Space 协作约定/团队规则 → scope=space（当前 dialog 绑定 space 时）",
    "  - 用户个人身份或纯个人偏好 → scope=auto（默认记到用户）",
    "  - 与当前 Agent 挂钩的有效做法 → scope=auto（runtime 自动把 subject 标记为当前 Agent）",
    "  - 当前任务的临时进度 → 不要调用，走对话上下文",
    "优先写成一句简洁、未来仍可理解的话；如无必要，不要频繁调用。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "要记住的内容。请写成一句未来仍然可理解的简洁描述，例如“这个用户在复杂问题里更喜欢先看结论”。",
      },
      scope: {
        type: "string",
        enum: ["auto", "user", "space"],
        description:
          "记忆范围。按内容性质选：Space 协作共识传 space；用户个人身份/偏好或与当前 Agent 挂钩的做法传 auto（默认）。auto 时 runtime 自动判断 owner，并将 subject 标记为当前 Agent（如果可识别）。",
      },
      kind: {
        type: "string",
        enum: ["episodic", "semantic", "procedural"],
        description:
          "记忆类型。默认 episodic。只有重复出现的可执行流程、排障步骤或稳定 runbook 才使用 procedural。",
      },
    },
    required: ["content"],
  } as const,
};

export async function rememberMemoryFunc(
  args: RememberMemoryToolArgs,
  thunkApi: any
): Promise<{ rawData: unknown; displayData: string }> {
  const state = thunkApi.getState();
  const spaceId = selectCurrentSpaceId(state) || undefined;
  const content = String(args.content ?? "").trim();
  const scope = args.scope ?? "auto";
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
