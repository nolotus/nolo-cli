import type { DialogConfig } from "../../app/types";
import { asOptionalTrimmedString } from "../../core/optionalString";

type LegacyDialogConfig = {
  llmId?: string;
  primaryAgentKey?: string;
};

const normalizeAgentId = (value: unknown): string | null =>
  asOptionalTrimmedString(value) ?? null;

const dedupeAgentIds = (agentIds: Array<string | null | undefined>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const agentId of agentIds) {
    const normalized = normalizeAgentId(agentId);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

export const getDialogAgentIds = (
  dialogConfig:
    | DialogConfig
    | (LegacyDialogConfig & { cybots?: string[] })
    | null
    | undefined,
): string[] => {
  if (!dialogConfig) return [];
  const primaryAgentKey = normalizeAgentId(dialogConfig.primaryAgentKey);
  if (Array.isArray(dialogConfig.cybots)) {
    return dedupeAgentIds([primaryAgentKey, ...dialogConfig.cybots]);
  }
  if (primaryAgentKey) {
    return [primaryAgentKey];
  }
  const legacyAgentId = normalizeAgentId((dialogConfig as LegacyDialogConfig).llmId);
  if (legacyAgentId) {
    return [legacyAgentId];
  }
  return [];
};

export const getPrimaryDialogAgentId = (
  dialogConfig:
    | DialogConfig
    | (LegacyDialogConfig & { cybots?: string[] })
    | null
    | undefined,
): string | null => getDialogAgentIds(dialogConfig)[0] ?? null;

export const getActiveDialogAgentId = (
  dialogConfig:
    | DialogConfig
    | (LegacyDialogConfig & { cybots?: string[]; activeAgentKey?: string })
    | null
    | undefined,
  defaultAgentId?: string,
): string | null => {
  if (!dialogConfig) return defaultAgentId ?? null;
  const activeKey = normalizeAgentId(dialogConfig.activeAgentKey);
  if (activeKey) return activeKey;
  // 显式 primary 优先于 cybots[0]（与 getPrimaryDialogAgentId 一致）：
  // activeAgentKey 只在显式切换后存在，未切换的 dialog 读到这里时
  // 行为必须与旧 primary 完全一致，避免 cybots[0] ≠ primaryAgentKey
  // 的历史数据在升级后漂移。
  const primaryKey = normalizeAgentId(dialogConfig.primaryAgentKey);
  if (primaryKey) return primaryKey;
  if (Array.isArray(dialogConfig.cybots) && dialogConfig.cybots.length > 0) {
    const firstCybot = normalizeAgentId(dialogConfig.cybots[0]);
    if (firstCybot) return firstCybot;
  }
  return defaultAgentId ?? null;
};

export const addDialogAgentIds = (
  existingAgentIds: string[],
  nextAgentIds: string[],
): string[] => {
  const merged = [...existingAgentIds, ...nextAgentIds];
  return merged.filter((id, index) => merged.indexOf(id) === index);
};

export const replacePrimaryDialogAgentId = (
  existingAgentIds: string[],
  nextPrimaryAgentId: string,
): string[] => [
  nextPrimaryAgentId,
  ...existingAgentIds.filter((id) => id !== nextPrimaryAgentId),
];

export const removeDialogAgentId = (
  existingAgentIds: string[],
  agentIdToRemove: string,
): string[] => existingAgentIds.filter((id) => id !== agentIdToRemove);
