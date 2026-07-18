import { asTrimmedString } from "../../core/trimmedString";
import { getNoloDialogIdFromKey } from "../../agent-runtime/noloWorkspaceTools";

export type DeleteDialogsMatchMode = "contains" | "exact" | "prefix" | "dialogId";

export interface DeleteDialogsQuery {
  query: string;
  matchMode?: DeleteDialogsMatchMode;
}

export interface DialogDeletionRecordLike {
  id?: string;
  dbKey?: string;
  title?: string;
  taskLabel?: string;
  updatedAt?: string | number;
  createdAt?: string | number;
  triggerType?: string | null;
  primaryAgentKey?: string | null;
}

export interface DialogDeletionPreviewItem {
  dialogId: string;
  dbKey: string;
  title: string;
  updatedAt: string | number | null;
  triggerType: string | null;
  primaryAgentKey: string | null;
}

export interface SkippedDialogDeletionItem {
  dialogId: string;
  dbKey: string;
  title: string;
  reason: "missing_dialog_id" | "not_owner" | "current_dialog";
}

export interface DialogDeletionPreview {
  deletable: DialogDeletionPreviewItem[];
  skipped: SkippedDialogDeletionItem[];
}

const normalizeText = (value: unknown) => asTrimmedString(value);

const resolveDialogId = (record: DialogDeletionRecordLike) => {
  const id = normalizeText(record.id);
  if (id) return id;
  const dbKey = normalizeText(record.dbKey);
  return dbKey ? getNoloDialogIdFromKey(dbKey) : "";
};

const resolveTitle = (record: DialogDeletionRecordLike, dialogId: string) =>
  normalizeText(record.title) || normalizeText(record.taskLabel) || dialogId || "(untitled)";

export function filterDialogDeletionCandidates(
  records: DialogDeletionRecordLike[],
  query: DeleteDialogsQuery,
) {
  const rawQuery = normalizeText(query.query);
  if (!rawQuery) return [];
  const matchMode = query.matchMode ?? "contains";
  const lowerQuery = rawQuery.toLowerCase();

  return records.filter((record) => {
    const dialogId = resolveDialogId(record);
    const dbKey = normalizeText(record.dbKey);
    const title = resolveTitle(record, dialogId).toLowerCase();
    const lowerDialogId = dialogId.toLowerCase();
    const lowerDbKey = dbKey.toLowerCase();

    if (matchMode === "dialogId") {
      return lowerDialogId === lowerQuery || lowerDbKey === lowerQuery;
    }
    if (matchMode === "exact") {
      return title === lowerQuery || lowerDialogId === lowerQuery || lowerDbKey === lowerQuery;
    }
    if (matchMode === "prefix") {
      return title.startsWith(lowerQuery) || lowerDialogId.startsWith(lowerQuery);
    }
    return title.includes(lowerQuery) || lowerDialogId.includes(lowerQuery) || lowerDbKey.includes(lowerQuery);
  });
}

export function buildDeleteDialogsPreview(args: {
  currentUserId: string;
  candidates: DialogDeletionRecordLike[];
  currentDialogId?: string | null;
}): DialogDeletionPreview {
  const deletable: DialogDeletionPreviewItem[] = [];
  const skipped: SkippedDialogDeletionItem[] = [];
  const ownerPrefix = `dialog-${args.currentUserId}-`;

  for (const record of args.candidates) {
    const dbKey = normalizeText(record.dbKey);
    const dialogId = resolveDialogId(record);
    const title = resolveTitle(record, dialogId);
    if (!dialogId || !dbKey) {
      skipped.push({ dialogId, dbKey, title, reason: "missing_dialog_id" });
      continue;
    }
    if (!dbKey.startsWith(ownerPrefix)) {
      skipped.push({ dialogId, dbKey, title, reason: "not_owner" });
      continue;
    }
    if (args.currentDialogId && dialogId === args.currentDialogId) {
      skipped.push({ dialogId, dbKey, title, reason: "current_dialog" });
      continue;
    }
    deletable.push({
      dialogId,
      dbKey,
      title,
      updatedAt: record.updatedAt ?? record.createdAt ?? null,
      triggerType: record.triggerType ?? null,
      primaryAgentKey: record.primaryAgentKey ?? null,
    });
  }

  return { deletable, skipped };
}

export function resolveConfirmedDialogDeletionTargets(
  preview: DialogDeletionPreview,
  confirmedDialogIds: string[],
) {
  const wanted = new Set<string>();
  for (const raw of confirmedDialogIds) {
    const value = normalizeText(raw);
    if (!value) continue;
    wanted.add(
      value.startsWith("dialog-") ? getNoloDialogIdFromKey(value) : value,
    );
  }
  const targets = preview.deletable.filter((item) => wanted.has(item.dialogId));
  const found = new Set(targets.map((item) => item.dialogId));
  const missingConfirmedDialogIds = Array.from(wanted).filter((dialogId) => !found.has(dialogId));

  return { targets, missingConfirmedDialogIds };
}
