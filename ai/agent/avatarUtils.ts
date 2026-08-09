// packages/ai/agent/avatarUtils.ts
// Resolves an agent's avatarFileId → a displayable URL

import { buildDatabaseFileContentUrl } from "../../database/fileUrl";

/**
 * Returns a URL for displaying the agent avatar, or null.
 * - If avatarFileId is an http(s) URL → use directly
 * - Otherwise build server file-content URL
 */
export function resolveAvatarUrl(
  avatarFileId: string | undefined | null,
  server: string | undefined | null
): string | null {
  if (!avatarFileId) return null;
  if (avatarFileId.startsWith("http") || avatarFileId.startsWith("blob:")) {
    return avatarFileId;
  }
  if (avatarFileId.startsWith("/")) {
    if (!server) return avatarFileId;
    return `${server}${avatarFileId}`;
  }
  return buildDatabaseFileContentUrl(server, avatarFileId);
}
