import {
  buildDatabaseFileContentUrl,
  isLocalDatabaseFileContentUrl,
} from "../../database/fileUrl";

export const buildMessageFileContentUrl = (
  serverOrigin: string | undefined | null,
  fileId: string | undefined | null
): string | null => buildDatabaseFileContentUrl(serverOrigin, fileId);

export const isLocalFileContentUrl = (
  url: string | null | undefined
): boolean => isLocalDatabaseFileContentUrl(url);
