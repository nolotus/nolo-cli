import { ContentType } from "../../app/types";
import { buildAppEditorPath } from "../../app/constants/appEditor";
import { DataType } from "../types";
import { normalizeSpaceId } from "./spaceKeys";

const ROUTABLE_KEY_PREFIXES = [
  "dialog-",
  "page-",
  "meta-",
  "file-",
  "image-",
  "agent-",
  "cybot-",
  "task-",
] as const;

const hasRoutablePrefix = (contentKey: string): boolean =>
  ROUTABLE_KEY_PREFIXES.some((prefix) => contentKey.startsWith(prefix));

export const isAppContentKey = (contentKey: string): boolean =>
  typeof contentKey === "string" && contentKey.startsWith("app-");

export const normalizeAppRouteId = (contentKey: string): string =>
  isAppContentKey(contentKey) ? contentKey : `app-${contentKey}`;

export const resolveRoutableContentKey = (
  contentKey: string,
  type?: string,
  userId?: string
): string => {
  if (!contentKey) return contentKey;

  const normalizedType = type?.toLowerCase();

  if (normalizedType === ContentType.APP || normalizedType === "app") {
    return normalizeAppRouteId(contentKey);
  }

  if (hasRoutablePrefix(contentKey)) return contentKey;
  if (!userId) return contentKey;

  if (normalizedType === DataType.DIALOG || normalizedType === ContentType.DIALOG) {
    return `${DataType.DIALOG}-${userId}-${contentKey}`;
  }

  if (normalizedType === DataType.DOC || normalizedType === ContentType.DOC) {
    return `${DataType.DOC}-${userId}-${contentKey}`;
  }

  // 文件和图片的 dbKey 统一使用 file-{userId}-{fileId} 格式
  if (normalizedType === DataType.FILE || normalizedType === ContentType.FILE ||
      normalizedType === DataType.IMAGE || normalizedType === ContentType.IMAGE) {
    return `file-${userId}-${contentKey}`;
  }

  return contentKey;
};

export const buildScopedPagePath = (
  pageKey: string,
  spaceId?: string | null
): string => {
  if (!spaceId) return `/${pageKey}`;
  return `/space/${normalizeSpaceId(spaceId)}/${pageKey}`;
};

export const buildRoutableContentPath = ({
  contentKey,
  type,
  userId,
  spaceId,
}: {
  contentKey: string;
  type?: string;
  userId?: string;
  spaceId?: string | null;
}): string =>
  buildScopedPagePath(
    resolveRoutableContentKey(contentKey, type, userId),
    spaceId
  );

export const isRoutableContentActive = ({
  contentKey,
  type,
  userId,
  spaceId,
  activePageKey,
  currentPath,
}: {
  contentKey: string;
  type?: string;
  userId?: string | null;
  spaceId?: string | null;
  activePageKey?: string;
  currentPath: string;
}): boolean => {
  const routeContentKey = resolveRoutableContentKey(
    contentKey,
    type,
    userId ?? undefined
  );

  if (activePageKey === contentKey || activePageKey === routeContentKey) {
    return true;
  }

  if (
    type?.toLowerCase() === ContentType.APP ||
    isAppContentKey(contentKey)
  ) {
    const appEditorPath = buildAppEditorPath(normalizeAppRouteId(contentKey), spaceId);
    return currentPath === appEditorPath;
  }

  return false;
};
