import { normalizeServerOrigin } from "../core/serverOrigin";
import { API_ENDPOINTS } from "./config";

const normalizeFileId = (fileId: string | undefined | null): string => {
  if (typeof fileId !== "string") return "";
  return fileId.trim();
};

export const buildDatabaseFileContentUrl = (
  serverOrigin: string | undefined | null,
  fileId: string | undefined | null
): string | null => {
  const normalizedServer = normalizeServerOrigin(serverOrigin);
  const normalizedFileId = normalizeFileId(fileId);

  if (!normalizedServer || !normalizedFileId) {
    return null;
  }

  return `${normalizedServer}${API_ENDPOINTS.DATABASE}/file/content/${normalizedFileId}`;
};

export const isLocalDatabaseFileContentUrl = (
  url: string | null | undefined
): boolean => {
  if (typeof url !== "string" || !url) return false;
  return url.includes("localhost") || url.includes("127.0.0.1");
};
