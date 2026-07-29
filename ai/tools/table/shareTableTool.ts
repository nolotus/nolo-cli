import { DataType } from "../../../create/types";
import { asOptionalTrimmedString } from "../../../core/optionalString";
import { readAndWait } from "../../../database/dbSlice";
import { shareResourceAction } from "../../../share/action";
import { hasExplicitPublicShareRequest } from "../../../share/publicSharePolicy";
import { selectAllMsgs, selectCurrentDialogId } from "../../../chat/messages/messageSlice";

type ShareTableArgs = {
  dbKey?: string;
  tenantId?: string;
  tableId?: string;
  title?: string;
  description?: string;
  visibility?: "private" | "community";
};

type ShareTableResult = {
  rawData: {
    token: string;
    key: string;
    url: string;
  };
  displayData: string;
};

export const shareTableFunctionSchema = {
  name: "shareTable",
  description:
    "把一张表发布为分享链接。默认用于社区分享；只有当用户明确要求公开/社区分享时才应调用。",
  parameters: {
    type: "object",
    properties: {
      dbKey: {
        type: "string",
        description: "表 meta 记录的 dbKey，例如 meta-user123-table123。",
      },
      tenantId: {
        type: "string",
        description: "表所属租户 ID。dbKey 缺失时必填。",
      },
      tableId: {
        type: "string",
        description: "表 ID。dbKey 缺失时必填。",
      },
      title: {
        type: "string",
        description: "分享标题；不传则回退为表 ID。",
      },
      description: {
        type: "string",
        description: "可选：分享描述。",
      },
      visibility: {
        type: "string",
        enum: ["private", "community"],
        description: "默认 community。",
      },
    },
  },
};

const resolveTableDbKey = (args: ShareTableArgs): string => {
  const dbKey = asOptionalTrimmedString(args.dbKey);
  if (dbKey) return dbKey;
  const tenantId = asOptionalTrimmedString(args.tenantId);
  const tableId = asOptionalTrimmedString(args.tableId);
  if (tenantId && tableId) {
    return `meta-${tenantId}-${tableId}`;
  }
  throw new Error("shareTable 需要提供 dbKey，或同时提供 tenantId 和 tableId。");
};

const asNonEmptyString = (value: unknown): string =>
  asOptionalTrimmedString(value) ?? "";

const readSharedTableMeta = async (
  thunkApi: any,
  tableDbKey: string
): Promise<Record<string, unknown> | null> => {
  if (typeof thunkApi?.dispatch !== "function") return null;
  const result = await thunkApi.dispatch(readAndWait(tableDbKey));
  if (!readAndWait.fulfilled.match(result) || !result.payload || typeof result.payload !== "object") {
    return null;
  }
  return result.payload as Record<string, unknown>;
};

export async function shareTableFunc(
  args: ShareTableArgs,
  thunkApi: any
): Promise<ShareTableResult> {
  const state = thunkApi?.getState?.();
  const dialogId = state ? selectCurrentDialogId(state) : undefined;
  const latestUserInput = state
    ? selectAllMsgs(state, dialogId)
        .slice()
        .reverse()
        .find((message) => message?.role === "user" && typeof message?.content === "string")
        ?.content
    : undefined;
  if (!hasExplicitPublicShareRequest(latestUserInput)) {
    throw new Error("当前策略不允许在用户未明确要求公开/社区分享时自动发布表。");
  }

  const tableDbKey = resolveTableDbKey(args);
  const tableMeta =
    !asNonEmptyString(args.tenantId) || !asNonEmptyString(args.tableId) || !asNonEmptyString(args.title)
      ? await readSharedTableMeta(thunkApi, tableDbKey)
      : null;
  const tenantId = asNonEmptyString(args.tenantId) || asNonEmptyString(tableMeta?.tenantId);
  const tableId = asNonEmptyString(args.tableId) || asNonEmptyString(tableMeta?.tableId);
  const title =
    asNonEmptyString(args.title) ||
    asNonEmptyString(tableMeta?.displayName) ||
    asNonEmptyString(tableMeta?.title) ||
    tableId ||
    tableDbKey;

  const result = await shareResourceAction(
    {
      type: DataType.TABLE,
      data: {
        dbKey: tableDbKey,
        ...(tenantId ? { tenantId } : {}),
        ...(tableId ? { tableId } : {}),
        displayName: title,
      },
      title,
      description: asOptionalTrimmedString(args.description),
      visibility: args.visibility ?? "community",
    },
    thunkApi
  );

  return {
    rawData: {
      ...result,
      url: `/share/${result.token}`,
    },
    displayData: `表已分享：/share/${result.token}`,
  };
}
