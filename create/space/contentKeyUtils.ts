import { ContentType } from "../../app/types";
import {
  buildAppDetailPath,
  buildAppEditorPath,
} from "../../app/constants/appEditor";
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

// Route segments that trail the content key instead of being it
// (e.g. `/:agentPageKey/inbox`). When the last segment is one of these,
// the active content key is the segment before it.
const CONTENT_ROUTE_TRAILING_SEGMENTS = new Set(["inbox"]);

// The sidebar renders outside the content route (it is a sibling of the
// routed <Outlet/>), so useParams() cannot see `:pageKey`. Derive the active
// content key straight from the URL instead — useLocation works anywhere.
export const extractActiveRouteKey = (
  currentPath?: string | null
): string | undefined => {
  if (!currentPath) return undefined;
  const pathname = currentPath.split("?")[0].split("#")[0];
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return undefined;
  let last = segments[segments.length - 1];
  if (CONTENT_ROUTE_TRAILING_SEGMENTS.has(last) && segments.length >= 2) {
    last = segments[segments.length - 2];
  }
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

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

  if (
    type?.toLowerCase() === ContentType.APP ||
    isAppContentKey(contentKey)
  ) {
    const appRouteId = normalizeAppRouteId(contentKey);
    return (
      currentPath === buildAppDetailPath(appRouteId, spaceId) ||
      currentPath === buildAppEditorPath(appRouteId, spaceId)
    );
  }

  // Explicit route param wins when a caller actually has it.
  if (activePageKey === contentKey || activePageKey === routeContentKey) {
    return true;
  }

  // Fall back to the key parsed out of the URL so the sidebar stays in sync
  // even though it lives above the content route in the tree.
  const activeKeyFromPath = extractActiveRouteKey(currentPath);
  return (
    activeKeyFromPath === contentKey || activeKeyFromPath === routeContentKey
  );
};
