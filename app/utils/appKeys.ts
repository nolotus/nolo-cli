import { asOptionalTrimmedString } from "../../core/optionalString";

export const APP_ROUTE_KEY_PREFIX = "app-";

const normalizeSegment = (value?: string | null): string | null =>
  asOptionalTrimmedString(value) ?? null;

export const buildUserAppKey = (userId: string, appId: string): string =>
  `${APP_ROUTE_KEY_PREFIX}${userId}-${appId}`;

export const buildOwnerScopedAppKey = (params: {
  userId: string;
  appId: string;
  spaceId?: string | null;
}): string => buildUserAppKey(params.userId, params.appId);

export const buildLegacyAppRouteKey = (appId: string): string =>
  `${APP_ROUTE_KEY_PREFIX}${appId}`;

export const isAppRouteKey = (value?: string | null): value is string =>
  typeof value === "string" && value.startsWith(APP_ROUTE_KEY_PREFIX);

export const resolveAppRouteKey = (
  appKey?: string | null,
  appId?: string | null
): string | null => {
  const normalizedAppKey = normalizeSegment(appKey);
  if (normalizedAppKey) return normalizedAppKey;
  const normalizedAppId = normalizeSegment(appId);
  if (!normalizedAppId) return null;
  return isAppRouteKey(normalizedAppId)
    ? normalizedAppId
    : buildLegacyAppRouteKey(normalizedAppId);
};

export const deriveAppIdFromRouteKey = (
  appKey?: string | null,
  userId?: string | null
): string | undefined => {
  const normalizedAppKey = normalizeSegment(appKey);
  if (!normalizedAppKey || !isAppRouteKey(normalizedAppKey)) return undefined;

  const normalizedUserId = normalizeSegment(userId);
  if (normalizedUserId) {
    const scopedPrefix = `${APP_ROUTE_KEY_PREFIX}${normalizedUserId}-`;
    if (normalizedAppKey.startsWith(scopedPrefix)) {
      const appId = normalizedAppKey.slice(scopedPrefix.length).trim();
      return appId || undefined;
    }
  }

  const legacyAppId = normalizedAppKey.slice(APP_ROUTE_KEY_PREFIX.length).trim();
  return legacyAppId || undefined;
};
