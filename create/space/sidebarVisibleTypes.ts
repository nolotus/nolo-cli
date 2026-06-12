import type { SpaceContent } from "../../app/types";

export type SidebarVisibleType =
  | "dialog"
  | "page"
  | "image"
  | "document"
  | "video"
  | "audio"
  | "table"
  | "file"
  | "app"
  | "agent"
  | "scheduled";

export const ALL_SIDEBAR_VISIBLE_TYPES: SidebarVisibleType[] = [
  "dialog",
  "page",
  "image",
  "document",
  "video",
  "audio",
  "table",
  "file",
  "app",
  "agent",
  "scheduled",
];

export const SIDEBAR_VISIBLE_TYPES_SEARCH_PARAM = "types";

export const LEGACY_DEFAULT_SIDEBAR_VISIBLE_TYPES: SidebarVisibleType[] = [
  "dialog",
  "page",
  "table",
];

export const DEFAULT_SIDEBAR_VISIBLE_TYPES: SidebarVisibleType[] = [
  ...LEGACY_DEFAULT_SIDEBAR_VISIBLE_TYPES,
  "app",
];

export const SPACE_HOME_TOPBAR_VISIBLE_TYPES: SidebarVisibleType[] = [
  "dialog",
  "page",
  "app",
  "table",
];

export const SPACE_FILE_TOPBAR_VISIBLE_TYPES: SidebarVisibleType[] = [
  "image",
  "document",
  "video",
  "audio",
  "table",
  "file",
];

export const isSidebarVisibleType = (
  value: string | null | undefined
): value is SidebarVisibleType =>
  value === "dialog" ||
  value === "page" ||
  value === "image" ||
  value === "document" ||
  value === "video" ||
  value === "audio" ||
  value === "table" ||
  value === "file" ||
  value === "app" ||
  value === "agent" ||
  value === "scheduled";

export const collectSidebarVisibleTypes = (
  values: readonly string[]
): SidebarVisibleType[] => {
  const valueSet = new Set(values);
  return ALL_SIDEBAR_VISIBLE_TYPES.filter((type) => valueSet.has(type));
};

export const normalizeSidebarVisibleTypes = (
  values: Iterable<string | null | undefined> | null | undefined,
  fallback: readonly SidebarVisibleType[] = DEFAULT_SIDEBAR_VISIBLE_TYPES
): SidebarVisibleType[] => {
  const normalizedFallback = collectSidebarVisibleTypes([...fallback]);
  const safeFallback =
    normalizedFallback.length > 0
      ? normalizedFallback
      : [...DEFAULT_SIDEBAR_VISIBLE_TYPES];

  if (!values) {
    return [...safeFallback];
  }

  const tokens: string[] = [];
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        tokens.push(trimmed);
      }
    }
  }

  if (tokens.length === 0) {
    return [...safeFallback];
  }

  if (tokens.includes("all")) {
    return [...ALL_SIDEBAR_VISIBLE_TYPES];
  }

  const normalized = collectSidebarVisibleTypes(tokens);
  return normalized.length > 0 ? normalized : [...safeFallback];
};

export const parseSidebarVisibleTypesSearchParam = (
  rawValue: string | null | undefined
): SidebarVisibleType[] | null => {
  if (typeof rawValue !== "string") {
    return null;
  }

  const tokens = rawValue
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return null;
  }

  if (tokens.includes("all")) {
    return [...ALL_SIDEBAR_VISIBLE_TYPES];
  }

  const normalized = collectSidebarVisibleTypes(tokens);
  return normalized.length > 0 ? normalized : null;
};

export const serializeSidebarVisibleTypesSearchParam = (
  visibleTypes: readonly SidebarVisibleType[]
): string | null => {
  const normalized = collectSidebarVisibleTypes([...visibleTypes]);
  if (normalized.length === 0) {
    return null;
  }

  return areSidebarVisibleTypesEqual(normalized, ALL_SIDEBAR_VISIBLE_TYPES)
    ? "all"
    : normalized.join(",");
};

export const areSidebarVisibleTypesEqual = (
  left: readonly SidebarVisibleType[],
  right: readonly SidebarVisibleType[]
): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export const pickSidebarVisibleTypes = (
  current: readonly SidebarVisibleType[] | null | undefined,
  allowed: readonly SidebarVisibleType[],
  fallback: readonly SidebarVisibleType[] = allowed
): SidebarVisibleType[] => {
  const allowedSet = new Set(allowed);
  const filtered = normalizeSidebarVisibleTypes(current, fallback).filter((type) =>
    allowedSet.has(type)
  );
  return filtered.length > 0 ? filtered : [...fallback];
};

export const isAllSidebarVisibleTypesSelected = (
  visibleTypes: readonly SidebarVisibleType[]
): boolean =>
  areSidebarVisibleTypesEqual(
    normalizeSidebarVisibleTypes(visibleTypes, ALL_SIDEBAR_VISIBLE_TYPES),
    ALL_SIDEBAR_VISIBLE_TYPES
  );

export const withToggledSidebarVisibleType = (
  current: readonly SidebarVisibleType[],
  type: SidebarVisibleType,
  fallback: readonly SidebarVisibleType[] = DEFAULT_SIDEBAR_VISIBLE_TYPES
): SidebarVisibleType[] => {
  const normalizedCurrent = normalizeSidebarVisibleTypes(current, fallback);
  if (normalizedCurrent.includes(type)) {
    if (normalizedCurrent.length === 1) {
      return normalizedCurrent;
    }
    return normalizedCurrent.filter((value) => value !== type);
  }

  return normalizeSidebarVisibleTypes([...normalizedCurrent, type], fallback);
};

export const withExclusiveSidebarVisibleType = (
  current: readonly SidebarVisibleType[],
  type: SidebarVisibleType,
  allowed: readonly SidebarVisibleType[],
  fallback: readonly SidebarVisibleType[] = allowed
): SidebarVisibleType[] => {
  if (!allowed.includes(type)) {
    return pickSidebarVisibleTypes(current, allowed, fallback);
  }

  const selected = pickSidebarVisibleTypes(current, allowed, fallback);
  if (selected.length === 1 && selected[0] === type) {
    return [...fallback];
  }

  return [type];
};

export const matchesSidebarVisibleType = (
  item: SpaceContent,
  type: SidebarVisibleType
): boolean => {
  const itemType = (item.type as string | undefined)?.toLowerCase();
  const contentKey = typeof item.contentKey === "string" ? item.contentKey : "";
  if (type === "agent") {
    return itemType === "agent" || itemType === "cybot";
  }
  if (type === "app") {
    return itemType === "app" || contentKey.startsWith("app-");
  }
  if (type === "scheduled") {
    return itemType === "task" || contentKey.startsWith("task-");
  }
  if (type === "dialog") {
    return itemType === type && item.triggerType !== "scheduled_run";
  }
  if (type === "file") {
    return itemType === "file" || itemType === "image";
  }
  if (type === "image") {
    return (
      itemType === "image" ||
      (itemType === "file" && item.fileCategory === "image") ||
      contentKey.startsWith("image-")
    );
  }
  if (type === "document") {
    return itemType === "file" && item.fileCategory === "document";
  }
  if (type === "video") {
    return itemType === "file" && item.fileCategory === "video";
  }
  if (type === "audio") {
    return itemType === "file" && item.fileCategory === "audio";
  }
  return itemType === type;
};

export const matchesSidebarVisibleTypes = (
  item: SpaceContent,
  visibleTypes: readonly SidebarVisibleType[]
): boolean =>
  normalizeSidebarVisibleTypes(visibleTypes).some((type) =>
    matchesSidebarVisibleType(item, type)
  );
