// 文件路径: chat/dialog/deleteDialogOrchestration.ts
//
// 把原本内联在 dialogSlice.deleteDialog 异步 thunk 体里的编排逻辑搬到这里，
// 以保持 dialogSlice 的 state shape 不变且对外暴露的 `deleteDialog` 名称不变。
// 这里不持有任何与 dialogSlice 直接关联的 import（避免循环依赖），
// 与 dialogSlice 自身的内嵌动作 `clearPendingAttachments` 协调时使用 lazy import。

import type { DialogConfig } from "../../app/types";
import { getRuntimeServerContext } from "../../database/runtimeServerContext";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { extractCustomId } from "../../core/prefix";
import { asRecordOrEmpty } from "../../core/recordOrEmpty";
import { remove, selectById } from "../../database/dbSlice";
import { clearWorkflow } from "../../ai/workflow/workflowSlice";
import { resetMsgs } from "../messages/messageSlice";
import { scheduleDeleteReplication } from "../../database/actions/replication";
import {
  buildDialogAttachmentPlan,
  extractFileContentIds,
  type DialogAttachmentMessage,
} from "./dialogAttachmentCleanup";
import { cleanupCliSessionForDialog } from "./actions/cleanupCliSession";
import { buildDialogAgentListIndexDeleteOps, createKey } from "../../database/keys";

// --- Helpers used only by deleteDialog ---

const collectKeys = async (prefix: string, db: any): Promise<string[]> => {
  const keys: string[] = [];
  let iterator = db.iterator({
    gte: prefix,
    lte: prefix + "\uffff",
  });
  if (iterator && typeof iterator.then === "function") {
    iterator = await iterator;
  }
  for await (const [key] of iterator) {
    keys.push(key as string);
  }
  return keys;
};

const collectEntries = async (
  prefix: string,
  db: any
): Promise<Array<[string, any]>> => {
  const entries: Array<[string, any]> = [];
  let iterator = db.iterator({
    gte: prefix,
    lte: prefix + "\uffff",
  });
  if (iterator && typeof iterator.then === "function") {
    iterator = await iterator;
  }
  for await (const [key, value] of iterator) {
    entries.push([key as string, value]);
  }
  return entries;
};

const dbGetOrNull = async (db: any, key: string) => {
  if (!db || typeof db.get !== "function") return null;
  try {
    return await db.get(key);
  } catch {
    return null;
  }
};

const readLocalFileMetadata = async (db: any, fileId: string) => {
  const direct = await dbGetOrNull(db, fileId);
  if (direct) return direct;
  const index = await dbGetOrNull(db, createKey("file", "id", fileId));
  const mainKey = asOptionalTrimmedString(index?.mainKey) ?? null;
  return mainKey ? await dbGetOrNull(db, mainKey) : null;
};

export type DeleteDialogPayload =
  | string
  | { dialogKey: string; includeAttachments?: boolean };

const normalizeDeleteDialogPayload = (payload: DeleteDialogPayload) =>
  typeof payload === "string"
    ? { dialogKey: payload, includeAttachments: false }
    : {
        dialogKey: payload.dialogKey,
        includeAttachments: payload.includeAttachments === true,
      };

const deleteOwnedDialogAttachments = async (args: {
  db: any;
  dialogId: string;
  entries: Array<[string, any]>;
  thunkApi: any;
}) => {
  const messages: DialogAttachmentMessage[] = args.entries.map(
    ([dbKey, value]) => ({
      ...asRecordOrEmpty(value),
      dbKey,
    })
  );
  const fileIds = [
    ...new Set(messages.flatMap((message) => extractFileContentIds(message))),
  ];
  const metadataByFileId: Record<string, any> = {};
  const metadataReadFailures: Array<{ fileId: string; error: string }> = [];
  for (const fileId of fileIds) {
    const metadata = await readLocalFileMetadata(args.db, fileId);
    if (metadata) {
      metadataByFileId[fileId] = metadata;
    } else {
      metadataReadFailures.push({
        fileId,
        error: "local file metadata not found",
      });
    }
  }
  const plan = buildDialogAttachmentPlan({
    dialogId: args.dialogId,
    messages,
    metadataByFileId,
    metadataReadFailures,
  });
  if (!plan.deleteCandidates.length) return plan;
  const { deleteFileAction } = await import("../../database/actions/deleteFile");
  for (const candidate of plan.deleteCandidates) {
    if (candidate.fileDbKey) {
      await deleteFileAction(candidate.fileDbKey, args.thunkApi);
    }
  }
  return plan;
};

// --- The deleteDialog async thunk body ---
//
// 与 dialogSlice 中原先的内联版本保持字段顺序、副作用顺序、返回结构一致。
// `clearPendingAttachments` 来自 dialogSlice 自身；为避免循环依赖，
// 在确实需要时通过 lazy import 动态获取。

export const deleteDialogThunk = async (
  payload: DeleteDialogPayload,
  thunkApi: any
): Promise<{
  dialogKey: string;
  isCurrentDialog: boolean;
  attachmentPlan: any;
}> => {
  const { dialogKey, includeAttachments } =
    normalizeDeleteDialogPayload(payload);
  const { dispatch, getState, extra } = thunkApi as any;
  const { db } = extra;
  const state = getState() as any;
  const { currentServer, syncServers } = getRuntimeServerContext(state);
  const currentDialogKey = state.dialog.currentDialogKey;
  const currentDialogId = currentDialogKey
    ? extractCustomId(currentDialogKey)
    : null;
  const targetDialogId = extractCustomId(dialogKey);
  const targetDialogConfig = selectById(state, dialogKey) as
    | DialogConfig
    | null;
  const isCurrentDialog =
    currentDialogId !== null && currentDialogId === targetDialogId;

  await cleanupCliSessionForDialog(
    { dispatch, getState: getState as any },
    targetDialogConfig
  );

  // Drop local agent-list secondary index rows before removing the dialog
  // primary (server handleDelete also cascades for the remote authority store).
  const dialogOwnerId =
    (typeof (targetDialogConfig as any)?.userId === "string" &&
      String((targetDialogConfig as any).userId).trim()) ||
    (() => {
      const rest = dialogKey.startsWith("dialog-")
        ? dialogKey.slice("dialog-".length)
        : "";
      const last = rest.lastIndexOf("-");
      return last > 0 ? rest.slice(0, last) : "";
    })();

  const agentListIndexDels = buildDialogAgentListIndexDeleteOps({
    userId: dialogOwnerId,
    dialogKey,
    dialogId: targetDialogId || undefined,
    previousRecord: targetDialogConfig
      ? (targetDialogConfig as unknown as Record<string, unknown>)
      : null,
  });

  // --- 无论是否是当前对话，都从当前空间删除该内容 ---
  await (dispatch as any)(remove(dialogKey));

  const prefix = createKey("dialog", targetDialogId, "msg");
  const deletedEntries = includeAttachments
    ? await collectEntries(prefix, db)
    : [];
  const attachmentPlan =
    includeAttachments && targetDialogId
      ? await deleteOwnedDialogAttachments({
          db,
          dialogId: targetDialogId,
          entries: deletedEntries,
          thunkApi,
        })
      : null;
  const deletedIds = includeAttachments
    ? deletedEntries.map(([key]) => key)
    : await collectKeys(prefix, db);

  const ops = [
    ...agentListIndexDels,
    ...deletedIds.map((key) => ({ type: "del" as const, key })),
  ];
  if (ops.length > 0) {
    await db.batch(ops);
  }
  if (deletedIds.length > 0) {
    scheduleDeleteReplication({
      currentServer,
      syncServers,
      dbKey: targetDialogId,
      deleteOptions: { type: "messages" },
      state,
    });
  }

  // --- 如果是当前对话，清理当前相关状态 ---
  if (isCurrentDialog) {
    await thunkApi.dispatch(resetMsgs());
    // 与 dialogSlice 自身内嵌动作协调：用 lazy import 避开循环依赖
    const { clearPendingAttachments } = await import("./dialogSlice");
    dispatch(clearPendingAttachments());
    dispatch(clearWorkflow());
  }

  return { dialogKey, isCurrentDialog, attachmentPlan };
};
