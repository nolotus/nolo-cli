import { isRecord } from "../core/isRecord";
import { asRecordOrEmpty } from "../core/recordOrEmpty";

export const ADMIN_PERMISSION_DEFINITIONS = [
  {
    key: "usageManagement",
    label: "用量管理",
    shortLabel: "用量",
    description: "查看用量报表、模型与提供商用量相关数据",
  },
  {
    key: "growthStats",
    label: "增长统计",
    shortLabel: "增长",
    description: "查看 7 天/30 天活跃、新增用户与增长趋势",
  },
] as const;

export type AdminPermissionKey = (typeof ADMIN_PERMISSION_DEFINITIONS)[number]["key"];

export type AdminPermissions = Partial<Record<AdminPermissionKey, boolean>>;

const ADMIN_PERMISSION_KEYS = new Set<AdminPermissionKey>(
  ADMIN_PERMISSION_DEFINITIONS.map((definition) => definition.key)
);

export const isAdminPermissionKey = (value: string): value is AdminPermissionKey =>
  ADMIN_PERMISSION_KEYS.has(value as AdminPermissionKey);

export const hasUsageManagementPermission = (value: unknown): boolean => {
  return hasAdminPermission(value, "usageManagement");
};

export const hasGrowthStatsPermission = (value: unknown): boolean => {
  return hasAdminPermission(value, "growthStats");
};

export const hasAdminPermission = (
  value: unknown,
  permissionKey: AdminPermissionKey
): boolean => {
  if (!value || typeof value !== "object") return false;
  const permissions = (value as { adminPermissions?: AdminPermissions | null })
    .adminPermissions;
  return permissions?.[permissionKey] === true;
};

export const mergeAdminPermissions = (
  current: unknown,
  patch: Partial<AdminPermissions>
): AdminPermissions => ({
  ...(asRecordOrEmpty(current) as AdminPermissions),
  ...patch,
});

export const parseAdminPermissionsPatch = (
  value: unknown
):
  | { ok: true; patch: Partial<AdminPermissions> }
  | { ok: false; error: string } => {
  if (!isRecord(value)) {
    return { ok: false, error: "admin permissions patch must be an object" };
  }

  const patch: Partial<AdminPermissions> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!isAdminPermissionKey(key)) {
      return { ok: false, error: `Unsupported admin permission: ${key}` };
    }
    if (typeof rawValue !== "boolean") {
      return { ok: false, error: `${key} must be boolean` };
    }
    patch[key] = rawValue;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "admin permissions patch cannot be empty" };
  }

  return { ok: true, patch };
};
