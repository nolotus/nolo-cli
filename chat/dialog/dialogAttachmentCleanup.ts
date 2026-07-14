import { dialogMessageKey } from "../../database/keys";

const FILE_CONTENT_RE = /(?:https?:\/\/[^/"'\s]+)?\/api\/v1\/db\/file\/content\/([^?#"'\s)]+)/g;

export type DialogAttachmentMessage = {
  id?: string;
  dbKey?: string;
  content?: unknown;
  [key: string]: unknown;
};

export type DialogAttachmentCandidate = {
  fileId: string;
  fileDbKey: string | null;
  size: number | null;
  ownerType: string | null;
  ownerId: string | null;
  ownerDbKey: string | null;
  source: string | null;
  status: "delete" | "retain";
  reason: string;
};

export type DialogAttachmentPlan = {
  dialogId: string;
  messageCount: number;
  referencedFileIds: string[];
  candidates: DialogAttachmentCandidate[];
  deleteCandidates: DialogAttachmentCandidate[];
  retainedCandidates: DialogAttachmentCandidate[];
  bytesToDelete: number;
  metadataReadFailures: Array<{ fileId: string; error: string }>;
};

export function extractFileContentIds(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (input: unknown) => {
    if (typeof input === "string") {
      for (const match of input.matchAll(FILE_CONTENT_RE)) {
        const fileId = decodeURIComponent(match[1] ?? "").trim();
        if (fileId) ids.add(fileId);
      }
      return;
    }
    if (Array.isArray(input)) {
      for (const item of input) visit(item);
      return;
    }
    if (input && typeof input === "object") {
      for (const item of Object.values(input as Record<string, unknown>)) visit(item);
    }
  };
  visit(value);
  return [...ids];
}

function messageDbKey(dialogId: string, message: DialogAttachmentMessage) {
  if (typeof message.dbKey === "string" && message.dbKey.trim()) {
    return message.dbKey.trim();
  }
  if (typeof message.id === "string" && message.id.trim()) {
    return dialogMessageKey(dialogId, message.id.trim());
  }
  return null;
}

function asText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildDialogAttachmentPlan(args: {
  dialogId: string;
  ownerId?: string | null;
  includeUserOwnedReferenced?: boolean;
  messages: DialogAttachmentMessage[];
  metadataByFileId: Record<string, any>;
  metadataReadFailures?: Array<{ fileId: string; error: string }>;
}): DialogAttachmentPlan {
  const messageKeys = new Set(
    args.messages
      .map((message) => messageDbKey(args.dialogId, message))
      .filter((key): key is string => Boolean(key))
  );
  const referencedFileIds = [
    ...new Set(args.messages.flatMap((message) => extractFileContentIds(message))),
  ];

  const candidates = referencedFileIds.map<DialogAttachmentCandidate>((fileId) => {
    const metadata = args.metadataByFileId[fileId];
    const ownerType = asText(metadata?.ownerType);
    const ownerId = asText(metadata?.ownerId);
    const ownerDbKey = asText(metadata?.ownerDbKey);
    const fileDbKey = asText(metadata?.dbKey);
    const source = asText(metadata?.source);
    const ownedByDialog = ownerType === "dialog" && ownerId === args.dialogId;
    const ownedByMessage = Boolean(ownerDbKey && messageKeys.has(ownerDbKey));
    const userOwnedReferenced =
      args.includeUserOwnedReferenced === true &&
      Boolean(args.ownerId) &&
      ownerType === "user" &&
      ownerId === args.ownerId;
    const canDelete = Boolean(fileDbKey && (ownedByDialog || ownedByMessage || userOwnedReferenced));

    return {
      fileId,
      fileDbKey,
      size: typeof metadata?.size === "number" && Number.isFinite(metadata.size) ? metadata.size : null,
      ownerType,
      ownerId,
      ownerDbKey,
      source,
      status: canDelete ? "delete" : "retain",
      reason: canDelete
        ? ownedByMessage
          ? "ownerDbKey matches a message in this dialog"
          : userOwnedReferenced
            ? "user-owned file is referenced by this dialog and explicit referenced-attachment deletion is enabled"
            : "ownerType/ownerId matches this dialog"
        : fileDbKey
          ? "file ownership is not exclusive to this dialog"
          : "file metadata not found",
    };
  });

  const deleteCandidates = candidates.filter((candidate) => candidate.status === "delete");
  const retainedCandidates = candidates.filter((candidate) => candidate.status === "retain");
  return {
    dialogId: args.dialogId,
    messageCount: args.messages.length,
    referencedFileIds,
    candidates,
    deleteCandidates,
    retainedCandidates,
    bytesToDelete: deleteCandidates.reduce((sum, candidate) => sum + (candidate.size ?? 0), 0),
    metadataReadFailures: args.metadataReadFailures ?? [],
  };
}
