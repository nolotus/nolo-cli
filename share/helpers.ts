import { asOptionalPositiveFiniteNumber } from "../core/optionalPositiveNumber";
import { asNonEmptyStringArray } from "../core/stringArray";
import { asTrimmedString } from "../core/trimmedString";
import {
  createAgentKey,

  isAgentKey,
  splitKey,
} from "../database/keys";
import { DataType } from "../create/types";
import type { ShareType } from "./types";

// ── String normalization ────────────────────────────────────────────

/** Core pure seam re-export so share callers keep importing from helpers. */
export { normalizeUserId } from "../core/userId";

export const toSafeString = (value: unknown): string => asTrimmedString(value);

export const toNonEmptyString = (value: unknown): string | undefined => {
  const text = toSafeString(value);
  return text || undefined;
};

export const normalizeAuthorName = (value: unknown): string => {
  const text = toSafeString(value);
  if (!text) return "";
  const lower = text.toLowerCase();
  if (lower === "unknown" || lower === "unknown user") return "";
  return text;
};

export const toSafeAgentKey = (value: unknown): string => {
  const text = toSafeString(value);
  return text && isAgentKey(text) ? text : "";
};

// ── Time helpers ────────────────────────────────────────────────────

export const toSafeTimestamp = (value: unknown): number => {
  // Number() first so numeric strings (e.g. epoch-ms text) stay accepted;
  // Date.parse covers ISO / date strings that Number() rejects.
  const fromNumber = asOptionalPositiveFiniteNumber(Number(value));
  if (fromNumber !== undefined) return fromNumber;
  if (typeof value !== "string") return 0;
  return asOptionalPositiveFiniteNumber(Date.parse(value)) ?? 0;
};

const SHARE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export const formatShareTime = (timestamp: number): string => {
  if (!timestamp) return "时间未知";
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? SHARE_TIME_FORMATTER.format(date) : "时间未知";
};

// ── Agent extraction ────────────────────────────────────────────────

const findAgentKeyInMessages = (messages: unknown[]): string => {
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const key = toSafeAgentKey((raw as Record<string, unknown>).cybotKey);
    if (key) return key;
  }
  return "";
};

const findAgentKeyInArray = (items: unknown[]): string => {
  for (const raw of items) {
    const direct = toSafeAgentKey(raw);
    if (direct) return direct;
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const key = toSafeAgentKey(item.dbKey) || toSafeAgentKey(item.id);
    if (key) return key;
  }
  return "";
};

const findAgentNameInMessages = (messages: unknown[]): string => {
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as Record<string, unknown>;
    const name =
      toSafeString(msg.agentName) ||
      toSafeString(msg.cybotName) ||
      toSafeString(msg.sourceAgentName);
    if (name) return name;
  }
  return "";
};

const findAgentNameInArray = (items: unknown[]): string => {
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const name =
      toSafeString(item.name) ||
      toSafeString(item.agentName) ||
      toSafeString(item.cybotName) ||
      toSafeString(item.sourceAgentName);
    if (name) return name;
  }
  return "";
};

export const extractAgentInfo = (
  type: ShareType,
  data: Record<string, unknown>
): { sourceAgentKey?: string; sourceAgentName?: string } => {
  const meta = data.meta as Record<string, unknown> | undefined;

  // Candidate keys in priority order
  const keyCandidates: unknown[] = [
    meta?.sourceAgentKey,
    meta?.agentKey,
    data.sourceAgentKey,
    data.agentKey,
    data.cybotKey,
    type === "cybot" ? (data.dbKey ?? data.id) : undefined,
  ];

  let agentKey = "";
  for (const candidate of keyCandidates) {
    agentKey = toSafeAgentKey(candidate);
    if (agentKey) break;
  }

  // Fallback: search in arrays
  if (!agentKey && Array.isArray(data.cybots)) {
    agentKey = findAgentKeyInArray(data.cybots);
  }
  if (!agentKey && Array.isArray(data.messages)) {
    agentKey = findAgentKeyInMessages(data.messages as unknown[]);
  }
  if (!agentKey && Array.isArray(data.history)) {
    agentKey = findAgentKeyInMessages(data.history as unknown[]);
  }

  // Agent name
  const nameCandidates: unknown[] = [
    meta?.sourceAgentName,
    meta?.agentName,
    meta?.cybotName,
    data.sourceAgentName,
    data.agentName,
    data.cybotName,
    type === "cybot" ? data.name : undefined,
  ];

  let agentName = "";
  for (const candidate of nameCandidates) {
    agentName = toSafeString(candidate);
    if (agentName) break;
  }
  if (!agentName && Array.isArray(data.cybots)) {
    agentName = findAgentNameInArray(data.cybots);
  }
  if (!agentName && Array.isArray(data.messages)) {
    agentName = findAgentNameInMessages(data.messages as unknown[]);
  }
  if (!agentName && Array.isArray(data.history)) {
    agentName = findAgentNameInMessages(data.history as unknown[]);
  }

  return {
    ...(agentKey ? { sourceAgentKey: agentKey } : {}),
    ...(agentName ? { sourceAgentName: agentName } : {}),
  };
};

// ── Cover image extraction ──────────────────────────────────────────

const extractImageFromContent = (content: unknown): string | undefined => {
  if (Array.isArray(content)) {
    const part = content.find(
      (p: any) => p?.type === "image_url" && typeof p?.image_url?.url === "string"
    );
    if (part?.image_url?.url) return part.image_url.url;
  }
  if (typeof content === "string") {
    const match = content.match(/!\[.*?\]\((.*?)\)/);
    if (match?.[1]) return match[1];
  }
  return undefined;
};

export const extractCoverImage = (
  type: ShareType,
  data: Record<string, unknown>
): string | undefined => {
  if (type === DataType.IMAGE) {
    return toNonEmptyString(data.url);
  }
  if (type === DataType.APP) {
    return toNonEmptyString(data.coverImage);
  }
  if (type !== DataType.DIALOG) return undefined;

  const messages = (Array.isArray(data.messages)
    ? data.messages
    : Array.isArray(data.history)
      ? data.history
      : []) as Record<string, unknown>[];

  for (const msg of messages) {
    const fromContent = extractImageFromContent(msg.content);
    if (fromContent) return fromContent;

    const image = toNonEmptyString(msg.image);
    if (image) return image;

    if (Array.isArray(msg.images)) {
      const first = asNonEmptyStringArray(msg.images)[0];
      if (first) return first;
    }
  }
  return undefined;
};

// ── Author extraction ────────────────────────────────────────────────

export const toPublicAgentKey = (value: unknown): string => {
  const key = toSafeAgentKey(value);
  if (!key) return "";

  const parts = splitKey(key);
  if (parts.length < 3) return "";

  const [type, owner] = parts;
  const agentId = parts.slice(2).join("-");
  if (!agentId) return "";
  if (owner === "pub") return key;

  if (type === DataType.AGENT) {
    return createAgentKey.public(agentId);
  }
  return "";
};

export const resolveShareAuthorIdentity = (args: {
  user?: Record<string, unknown> | null;
  profile?: Record<string, unknown> | null;
  fallbackName?: unknown;
  fallbackAvatar?: unknown;
}): { authorName?: string; authorAvatar?: string } => {
  const authorName =
    toNonEmptyString(args.profile?.nickname) ??
    toNonEmptyString(args.user?.name) ??
    toNonEmptyString(args.user?.nickname) ??
    toNonEmptyString(args.user?.username) ??
    toNonEmptyString(args.fallbackName);
  const authorAvatar =
    toNonEmptyString(args.profile?.avatar) ??
    toNonEmptyString(args.user?.avatar) ??
    toNonEmptyString(args.fallbackAvatar);

  return {
    ...(authorName ? { authorName } : {}),
    ...(authorAvatar ? { authorAvatar } : {}),
  };
};

// ── Sanitization ────────────────────────────────────────────────────

const SENSITIVE_FIELDS = ["apiKey", "secret", "password"] as const;

export const sanitizeShareData = (
  data: Record<string, unknown>
): Record<string, unknown> => {
  const snapshot = { ...data };
  for (const field of SENSITIVE_FIELDS) {
    delete snapshot[field];
  }
  return snapshot;
};
