// packages/app/settings/settingNormalizers.ts
//
// 单一职责:settings 字段归一化纯函数 + 通用 utils(hasOwn/omitKeys/hex/alpha 颜色)。
// 不依赖任何业务模块;只 import 主题/字体/策略相关常量。

import { noloAgentId } from "../../core/init";
import { normalizeServerOrigin } from "../../core/serverOrigin";
import {
  DEFAULT_USER_PREFERENCE_PROFILE,
  type KnowledgeCaptureLevel,
  type SpaceContextLevel,
  type TonePreset,
} from "../../ai/policy/types";

import { SYSTEM_DEFAULT_AGENT_ID } from "./settingTypes";
import { QUICK_CHAT_DEFAULT_TIER_AGENTS } from "./quickChatTierDefaults";

export const hasOwn = (target: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(target, key);

export const normalizeDefaultAgentIdSetting = (
  value: unknown,
): string | undefined => {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  return value === noloAgentId || value === SYSTEM_DEFAULT_AGENT_ID
    ? SYSTEM_DEFAULT_AGENT_ID
    : value;
};

export const normalizeAuthorityHomeServerSetting = (
  value: unknown,
): string | null => {
  const normalized = normalizeServerOrigin(value);
  return /^https?:\/\//i.test(normalized) ? normalized : null;
};

export const normalizeTonePresetSetting = (value: unknown): TonePreset => {
  switch (value) {
    case "professional":
    case "friendly":
    case "direct":
    case "pragmatic":
    case "default":
      return value;
    default:
      return DEFAULT_USER_PREFERENCE_PROFILE.tone?.preset ?? "default";
  }
};

export const normalizePolicyLevelSetting = (
  value: unknown,
  fallback: KnowledgeCaptureLevel | SpaceContextLevel,
): KnowledgeCaptureLevel | SpaceContextLevel => {
  const n = Number(value);
  if (n === 1 || n === 2 || n === 3 || n === 4) {
    return n;
  }
  return fallback;
};

export const resolveDefaultAgentIdSetting = (value: unknown): string =>
  normalizeDefaultAgentIdSetting(value) ?? SYSTEM_DEFAULT_AGENT_ID;

/**
 * Selectors that read the raw `defaultAgentId` field from state usually want the
 * "preferred" stored value (which may be the system-default sentinel), but consumers
 * (e.g. `noloAgentId` lookup) want the runtime nolo agent id. This helper returns the
 * resolved runtime id.
 */
export const selectResolvedDefaultAgentId = (value: unknown): string => {
  const normalizedValue = resolveDefaultAgentIdSetting(value);
  return normalizedValue === SYSTEM_DEFAULT_AGENT_ID
    ? noloAgentId
    : normalizedValue;
};

/**
 * Resolve a quick-chat *tier* agent field (`flashAgentId` / `balancedAgentId` /
 * `qualityAgentId` / `imageAgentId`) to its runtime id.
 *
 * Unlike the generic `defaultAgentId` field (which falls back to the built-in
 * `nolo` agent when unset / on the system-default sentinel), each quick-chat
 * tier has its own dedicated built-in public agent. When the stored value is
 * missing or the `SYSTEM_DEFAULT_AGENT_ID` sentinel, we return that tier's
 * built-in default instead of `noloAgentId`. A user-customized value is
 * returned as-is.
 */
export const selectResolvedTierAgentId = (
  value: unknown,
  tier: "flash" | "balanced" | "quality" | "image",
): string => {
  const normalizedValue = resolveDefaultAgentIdSetting(value);
  return normalizedValue === SYSTEM_DEFAULT_AGENT_ID
    ? QUICK_CHAT_DEFAULT_TIER_AGENTS[tier]
    : normalizedValue;
};

/**
 * Convert a 3- or 6-digit hex color to its "r, g, b" string form, suitable for
 * `rgba(${rgb}, ${alpha})` interpolation. Returns `null` if input is not a valid
 * hex color.
 */
export const hexToRgbString = (value?: string): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^#/, "");
  const safe =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized;

  if (!/^[0-9a-fA-F]{6}$/.test(safe)) return null;

  const intValue = Number.parseInt(safe, 16);
  const r = (intValue >> 16) & 255;
  const g = (intValue >> 8) & 255;
  const b = intValue & 255;
  return `${r}, ${g}, ${b}`;
};

/**
 * Build an `rgba()` color from a hex value, alpha 0-1, and a fallback used when
 * the hex is invalid.
 */
export const alphaColor = (
  hex: string | undefined,
  alpha: number,
  fallback: string,
): string => {
  const rgb = hexToRgbString(hex);
  return rgb ? `rgba(${rgb}, ${alpha})` : fallback;
};

/**
 * Shallow-clone a record and drop the given keys. Returns a new object; the
 * input is not mutated.
 */
export const omitKeys = <T extends Record<string, unknown>>(
  record: T,
  keys: readonly (keyof T)[],
): Record<keyof T, unknown> => {
  const next: Record<keyof T, unknown> = { ...record };
  keys.forEach((key) => {
    delete next[key];
  });
  return next;
};
