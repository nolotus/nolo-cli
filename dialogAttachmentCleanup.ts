import { toErrorMessage } from "./core/errorMessage";
import { asOptionalTrimmedString } from "./core/optionalString";
import { deleteDbRecordOnServers, readDbRecordFromServers, type GlobalDeleteResult } from "./globalRecordOperations";
import type { CliFetchImpl } from "./cliFetch";
import {
  buildDialogAttachmentPlan,
  extractFileContentIds,
  type DialogAttachmentCandidate,
  type DialogAttachmentPlan,
} from "./chat/dialog/dialogAttachmentCleanup";

export { buildDialogAttachmentPlan, extractFileContentIds };

export type DialogAttachmentDeleteResult = {
  fileId: string;
  fileDbKey: string;
  deleteResults: GlobalDeleteResult[];
};

function asText(value: unknown) {
  return asOptionalTrimmedString(value) ?? null;
}

async function readDialogMessages(args: {
  authToken: string;
  dialogId: string;
  fetchImpl: CliFetchImpl;
  serverUrl: string;
}) {
  const response = await args.fetchImpl(`${args.serverUrl}/rpc/getConvMsgs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ dialogId: args.dialogId, limit: 10000 }),
  });
  if (!response.ok) {
    throw new Error(`read dialog messages failed on ${args.serverUrl}: HTTP ${response.status}`);
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

export async function planDialogAttachmentCleanup(args: {
  authToken: string;
  dialogId: string;
  ownerId?: string | null;
  includeUserOwnedReferenced?: boolean;
  fallbackFetchImpl?: CliFetchImpl;
  fetchImpl: CliFetchImpl;
  serverUrl: string;
  serverUrls: string[];
}): Promise<DialogAttachmentPlan> {
  const messages = await readDialogMessages({
    authToken: args.authToken,
    dialogId: args.dialogId,
    fetchImpl: args.fetchImpl,
    serverUrl: args.serverUrl,
  });
  const fileIds = [...new Set(messages.flatMap((message) => extractFileContentIds(message)))];
  const metadataByFileId: Record<string, any> = {};
  const metadataReadFailures: Array<{ fileId: string; error: string }> = [];

  for (const fileId of fileIds) {
    try {
      const result = await readDbRecordFromServers({
        authToken: args.authToken,
        dbKey: `file-id-${fileId}`,
        fallbackFetchImpl: args.fallbackFetchImpl,
        fetchImpl: args.fetchImpl,
        serverUrls: args.serverUrls,
        label: `file metadata index ${fileId}`,
      });
      const mainKey = asText(result.record?.mainKey);
      if (!mainKey) throw new Error(`file-id index missing mainKey`);
      const metadata = await readDbRecordFromServers({
        authToken: args.authToken,
        dbKey: mainKey,
        fallbackFetchImpl: args.fallbackFetchImpl,
        fetchImpl: args.fetchImpl,
        serverUrls: args.serverUrls,
        label: `file metadata ${fileId}`,
      });
      metadataByFileId[fileId] = {
        ...metadata.record,
        dbKey: asText(metadata.record?.dbKey) ?? mainKey,
      };
    } catch (error) {
      const fallbackKey =
        args.ownerId && !fileId.startsWith("file-")
          ? `file-${args.ownerId}-${fileId}`
          : null;
      if (fallbackKey) {
        try {
          const metadata = await readDbRecordFromServers({
            authToken: args.authToken,
            dbKey: fallbackKey,
            fallbackFetchImpl: args.fallbackFetchImpl,
            fetchImpl: args.fetchImpl,
            serverUrls: args.serverUrls,
            label: `file metadata ${fileId}`,
          });
          metadataByFileId[fileId] = {
            ...metadata.record,
            dbKey: asText(metadata.record?.dbKey) ?? fallbackKey,
          };
          continue;
        } catch {
          // Keep the original index error; it explains why the preferred path failed.
        }
      }
      metadataReadFailures.push({
        fileId,
        error: toErrorMessage(error),
      });
    }
  }

  return buildDialogAttachmentPlan({
    dialogId: args.dialogId,
    ownerId: args.ownerId,
    includeUserOwnedReferenced: args.includeUserOwnedReferenced,
    messages,
    metadataByFileId,
    metadataReadFailures,
  });
}

export async function deleteDialogAttachmentCandidates(args: {
  authToken: string;
  candidates: DialogAttachmentCandidate[];
  fallbackFetchImpl?: CliFetchImpl;
  fetchImpl: CliFetchImpl;
  serverUrls: string[];
}): Promise<DialogAttachmentDeleteResult[]> {
  const results: DialogAttachmentDeleteResult[] = [];
  for (const candidate of args.candidates) {
    if (candidate.status !== "delete" || !candidate.fileDbKey) continue;
    const deleteResults = await deleteDbRecordOnServers({
      authToken: args.authToken,
      dbKey: candidate.fileDbKey,
      fallbackFetchImpl: args.fallbackFetchImpl,
      fetchImpl: args.fetchImpl,
      serverUrls: args.serverUrls,
    });
    results.push({
      fileId: candidate.fileId,
      fileDbKey: candidate.fileDbKey,
      deleteResults,
    });
  }
  return results;
}
