import type { AppSummary, AppSummaryRecord } from "../types/appSummary";
import { toAppSummary } from "../types/appSummary";
import { isAppRouteKey, resolveAppRouteKey } from "../utils/appKeys";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { asTrimmedString } from "../../core/trimmedString";
import { normalizeAppRouteId } from "../../create/space/contentKeyUtils";
import { DataType } from "../../create/types";
import { ContentType } from "../types";

export type ContentTab =
  | "all"
  | "app"
  | "agent"
  | "dialog"
  | "page"
  | "image"
  | "document"
  | "video"
  | "audio"
  | "table"
  | "file"
  | "attachment";

export type OwnedAppContentItem = {
  source: "owned-app";
  title: string;
  type: ContentType.APP;
  contentKey: string;
  pinned: boolean;
  createdAt: string | number;
  updatedAt: string | number;
  spaceId: string | null;
  spaceName: string;
  serverOrigin?: string;
  app: AppSummary;
};

export type QueriedContentItem = {
  source: "user-data";
  title: string;
  type: string;
  fileCategory?: "image" | "document" | "video" | "audio" | "other";
  mimeType?: string;
  fileSize?: number;
  originalName?: string;
  contentKey: string;
  pinned: boolean;
  createdAt: string | number;
  updatedAt: string | number;
  spaceId: string | null;
  spaceName: string;
  serverOrigin?: string;
  cybots?: string[];
  primaryAgentKey?: string;
};

export type MyContentListItem = QueriedContentItem | OwnedAppContentItem;

export const MY_CONTENT_USER_DATA_TYPES: DataType[] = [
  DataType.APP,
  DataType.DOC,
  DataType.DIALOG,
  DataType.IMAGE,
  DataType.FILE,
  DataType.TABLE,
  DataType.AGENT,
];

type UserContentRecord = Partial<AppSummaryRecord> & {
  dbKey?: string;
  contentKey?: string;
  type?: string;
  fileCategory?: "image" | "document" | "video" | "audio" | "other";
  mimeType?: string;
  fileSize?: number;
  originalName?: string;
  title?: string;
  displayName?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  created?: string | number;
  updated_at?: string | number;
  pinned?: boolean;
  spaceId?: string | null;
  serverOrigin?: string;
};

const normalizeText = (value: unknown): string => asTrimmedString(value);

export const resolveUserContentRecordKey = (record: UserContentRecord): string => {
  const contentKey = normalizeText(record.contentKey);
  if (contentKey) return contentKey;
  const dbKey = normalizeText(record.dbKey);
  if (dbKey) return dbKey;
  const appKey = normalizeText(record.appKey);
  if (appKey) return appKey;
  return resolveAppRouteKey(undefined, normalizeText(record.appId)) ?? "";
};

export const isUserContentAppRecord = (record: UserContentRecord): boolean => {
  const normalizedType = normalizeText(record.type).toLowerCase();
  const canonicalKey = resolveUserContentRecordKey(record);
  return normalizedType === ContentType.APP || isAppRouteKey(canonicalKey);
};

export const resolveMyContentTab = (
  item: Pick<MyContentListItem, "type" | "contentKey"> & {
    fileCategory?: QueriedContentItem["fileCategory"];
  }
): ContentTab => {
  const normalizedType = item.type?.toLowerCase();
  const contentKey = item.contentKey;

  if (normalizedType === ContentType.APP || contentKey.startsWith("app-")) return "app";
  if (
    normalizedType === ContentType.AGENT ||
    contentKey.startsWith("agent-")
  ) {
    return "agent";
  }
  if (normalizedType === ContentType.DIALOG || contentKey.startsWith("dialog-")) return "dialog";
  if (normalizedType === ContentType.DOC || contentKey.startsWith("page-")) return "page";
  if (
    normalizedType === ContentType.IMAGE ||
    contentKey.startsWith("image-") ||
    (normalizedType === ContentType.FILE && item.fileCategory === "image")
  ) {
    return "image";
  }
  if (normalizedType === ContentType.FILE && item.fileCategory === "document") {
    return "document";
  }
  if (normalizedType === ContentType.FILE && item.fileCategory === "video") {
    return "video";
  }
  if (normalizedType === ContentType.FILE && item.fileCategory === "audio") {
    return "audio";
  }
  if (normalizedType === "table" || contentKey.startsWith("meta-")) return "table";
  return "file";
};

const toTimestamp = (value: string | number) =>
  typeof value === "number" ? value : Date.parse(value) || 0;

const normalizeSpaceId = (spaceId: unknown): string | null => {
  return asOptionalTrimmedString(spaceId) ?? null;
};

const resolveRecordTimestamp = (record: UserContentRecord): string | number =>
  record.updatedAt ??
  record.updated_at ??
  record.createdAt ??
  record.created ??
  0;

export const deduplicateContentRecords = <T extends UserContentRecord>(
  records: T[]
): T[] => {
  const uniqueMap = new Map<string, T>();
  for (const record of records) {
    const key = resolveUserContentRecordKey(record);
    if (!key) continue;
    const existing = uniqueMap.get(key);
    if (!existing) {
      uniqueMap.set(key, record);
      continue;
    }
    const existingTs = toTimestamp(resolveRecordTimestamp(existing));
    const nextTs = toTimestamp(resolveRecordTimestamp(record));
    if (nextTs > existingTs) {
      uniqueMap.set(key, record);
    }
  }
  return Array.from(uniqueMap.values());
};

/**
 * Explicit local↔account sync mapping link used to collapse paired rows.
 * Keys may differ (e.g. agent-local-* vs agent-userId-*).
 */
export type ContentSyncMappingLink = {
  localDbKey: string;
  remoteDbKey: string;
};

const pickPreferredMappedRecord = <T extends UserContentRecord>(
  left: T,
  right: T
): T => {
  const leftTs = toTimestamp(resolveRecordTimestamp(left));
  const rightTs = toTimestamp(resolveRecordTimestamp(right));
  if (rightTs > leftTs) return right;
  if (leftTs > rightTs) return left;
  // Timestamp tie: prefer the remote/account side (right is remote when called
  // as pick(local, remote)) so the visible row tracks account identity after sync.
  return right;
};

/**
 * Same-key dedupe, then collapse local+remote pairs linked by explicit mappings
 * into a single row (M5). Unmapped local and account records stay independent.
 */
export const deduplicateContentRecordsWithMappings = <T extends UserContentRecord>(
  records: T[],
  mappings: readonly ContentSyncMappingLink[] = []
): T[] => {
  const byKey = new Map<string, T>();
  for (const record of deduplicateContentRecords(records)) {
    const key = resolveUserContentRecordKey(record);
    if (!key) continue;
    byKey.set(key, record);
  }

  const dropKeys = new Set<string>();

  for (const mapping of mappings) {
    const localKey = asTrimmedString(mapping.localDbKey);
    const remoteKey = asTrimmedString(mapping.remoteDbKey);
    if (!localKey || !remoteKey || localKey === remoteKey) continue;
    if (dropKeys.has(localKey) || dropKeys.has(remoteKey)) continue;

    const localRecord = byKey.get(localKey);
    const remoteRecord = byKey.get(remoteKey);
    if (!localRecord || !remoteRecord) continue;

    const preferred = pickPreferredMappedRecord(localRecord, remoteRecord);
    const preferredKey = resolveUserContentRecordKey(preferred);
    const dropKey = preferredKey === remoteKey ? localKey : remoteKey;

    byKey.set(preferredKey || remoteKey, preferred);
    if (dropKey && dropKey !== (preferredKey || remoteKey)) {
      byKey.delete(dropKey);
      dropKeys.add(dropKey);
    }
  }

  return Array.from(byKey.values());
};

export function buildOwnedAppContentItems(
  apps: readonly AppSummary[],
  myAppsLabel: string
): OwnedAppContentItem[] {
  return apps
    .flatMap((app): OwnedAppContentItem[] => {
      const contentKey = app.appKey ?? normalizeAppRouteId(app.appId ?? "");
      if (!contentKey) return [];
      const timestamp = app.modifiedOn ?? 0;
      return [
        {
          source: "owned-app",
          title: typeof app.name === "string" && app.name.trim() ? app.name : contentKey,
          type: ContentType.APP,
          contentKey,
          pinned: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          spaceId: null,
          spaceName: myAppsLabel,
          serverOrigin: app.serverOrigin,
          app,
        },
      ];
    })
    .sort(
      (left, right) =>
        toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt) ||
        left.contentKey.localeCompare(right.contentKey)
    );
}

export function pinnedFirst(
  a: { pinned?: boolean },
  b: { pinned?: boolean }
): number {
  return Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
}

export function buildMyContentItemsFromUserData(
  records: UserContentRecord[],
  currentServer: string,
  spaceNameById: Map<string, string>,
  myAppsLabel: string,
  fallbackSpaceLabel: string
): MyContentListItem[] {
  const items = records.flatMap((record): MyContentListItem[] => {
    const contentKey = resolveUserContentRecordKey(record);
    const normalizedType = normalizeText(record.type).toLowerCase();
    const isAppRecord = isUserContentAppRecord(record);
    const contentType = isAppRecord ? ContentType.APP : normalizedType;
    const timestamp = resolveRecordTimestamp(record);
    const spaceId = normalizeSpaceId(record.spaceId);
    const spaceName = spaceId
      ? spaceNameById.get(spaceId) ?? spaceId
      : isAppRecord
        ? myAppsLabel
        : fallbackSpaceLabel;

    if (isAppRecord) {
      const app = toAppSummary(
        {
          ...record,
          appKey:
            typeof record.appKey === "string" && record.appKey.trim().length > 0
              ? record.appKey
              : contentKey,
          dbKey: contentKey,
        },
        currentServer
      );
      if (!app || !(app.appKey || app.appId)) return [];
      return [
        {
          source: "owned-app",
          title: typeof app.name === "string" && app.name.trim() ? app.name : contentKey,
          type: ContentType.APP,
          contentKey: app.appKey ?? normalizeAppRouteId(app.appId ?? ""),
          pinned: Boolean(record.pinned),
          createdAt: timestamp,
          updatedAt: timestamp,
          spaceId,
          spaceName,
          serverOrigin: app.serverOrigin,
          app,
        },
      ];
    }

    if (!contentKey || !contentType) return [];

    const title = normalizeText(record.title) ||
      normalizeText(record.displayName) ||
      normalizeText(record.name) ||
      contentKey;

    return [
      {
        source: "user-data",
        title,
        type: contentType,
        fileCategory: record.fileCategory,
        mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined,
        fileSize: typeof record.fileSize === "number" ? record.fileSize : undefined,
        originalName:
          typeof record.originalName === "string" && record.originalName.trim().length > 0
            ? record.originalName
            : undefined,
        contentKey,
        pinned: Boolean(record.pinned),
        createdAt: record.createdAt ?? record.created ?? 0,
        updatedAt: timestamp,
        spaceId,
        spaceName,
        serverOrigin:
          typeof record.serverOrigin === "string" && record.serverOrigin.trim().length > 0
            ? record.serverOrigin
            : undefined,
        cybots: (record as any).cybots,
        primaryAgentKey: (record as any).primaryAgentKey || (record as any).primaryCybotKey,
      },
    ];
  });

  return items.sort((left, right) => {
    const pinDiff = pinnedFirst(left, right);
    return (
      pinDiff ||
      toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt) ||
      left.contentKey.localeCompare(right.contentKey)
    );
  });
}

const previewItemKey = (item: MyContentListItem): string =>
  `${item.source}:${item.contentKey}:${item.spaceId ?? "none"}`;

export function buildMyContentPreviewItems(
  items: MyContentListItem[],
  limit?: number,
  activeTab: ContentTab = "all"
): MyContentListItem[] {
  if (typeof limit !== "number") return items;
  if (activeTab !== "all") return items.slice(0, limit);

  const previewPriority: ContentTab[] = [
    "app",
    "agent",
    "dialog",
    "page",
    "table",
    "image",
    "document",
    "video",
    "audio",
    "file",
  ];
  const selected: MyContentListItem[] = [];
  const selectedKeys = new Set<string>();

  const pushIfNeeded = (item: MyContentListItem | undefined) => {
    if (!item || selected.length >= limit) return;
    const key = previewItemKey(item);
    if (selectedKeys.has(key)) return;
    selected.push(item);
    selectedKeys.add(key);
  };

  for (const tab of previewPriority) {
    pushIfNeeded(items.find((item) => resolveMyContentTab(item) === tab));
    if (selected.length >= limit) return selected;
  }

  for (const item of items) {
    pushIfNeeded(item);
    if (selected.length >= limit) break;
  }

  return selected;
}
