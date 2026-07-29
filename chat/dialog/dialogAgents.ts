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
