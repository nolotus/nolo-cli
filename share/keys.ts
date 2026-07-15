import { createKey, splitKey, isAgentKey } from "../database/keys";
import { DataType } from "../create/types";
import { normalizeUserId } from "../core/userId";
import { toSafeAgentKey } from "./helpers";

const SHARE_PREFIX = "share";
const SHARE_INDEX_PREFIX = "shareidx";
const TIMESTAMP_MAX = 9_999_999_999_999;

// ── Normalization ───────────────────────────────────────────────────

const normalizeToken = (value: unknown): string =>
  String(value || "").trim();

const normalizeCreatedAt = (value: unknown): number => {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, TIMESTAMP_MAX);
};

const toInvertedTimestamp = (value: unknown): string =>
  String(TIMESTAMP_MAX - normalizeCreatedAt(value)).padStart(13, "0");

// ── Community index builders ────────────────────────────────────────

type CommunityDimension = "creator" | "agent";

const normalizeDimensionValue = (dim: CommunityDimension, raw: unknown): string =>
  dim === "creator" ? normalizeUserId(raw) : toSafeAgentKey(raw);

const createCommunityIndex = (
  dim: CommunityDimension,
  rawValue: unknown,
  createdAt: unknown,
  token: unknown
): string => {
  const value = normalizeDimensionValue(dim, rawValue);
  const normalizedToken = normalizeToken(token);
  if (!value || !normalizedToken) return "";
  return createKey(SHARE_INDEX_PREFIX, "community", dim, value, toInvertedTimestamp(createdAt), normalizedToken);
};

const createCommunityRange = (dim: CommunityDimension, rawValue: unknown) => {
  const value = normalizeDimensionValue(dim, rawValue);
  if (!value) return { start: "", end: "" };
  const start = createKey(SHARE_INDEX_PREFIX, "community", dim, value, "");
  return { start, end: start + "\uffff" };
};

// ── Global community index (all community shares, time-ordered) ─────

const createCommunityAllIndex = (
  createdAt: unknown,
  token: unknown
): string => {
  const normalizedToken = normalizeToken(token);
  if (!normalizedToken) return "";
  return createKey(SHARE_INDEX_PREFIX, "community", "all", toInvertedTimestamp(createdAt), normalizedToken);
};

const createCommunityAllRange = () => {
  const start = createKey(SHARE_INDEX_PREFIX, "community", "all", "");
  return { start, end: start + "\uffff" };
};

// ── Owner index (all shares regardless of visibility) ───────────────

const createOwnerIndex = (
  rawUserId: unknown,
  createdAt: unknown,
  token: unknown
): string => {
  const userId = normalizeUserId(rawUserId);
  const normalizedToken = normalizeToken(token);
  if (!userId || !normalizedToken) return "";
  return createKey(SHARE_INDEX_PREFIX, "owner", userId, toInvertedTimestamp(createdAt), normalizedToken);
};

const createOwnerRange = (rawUserId: unknown) => {
  const userId = normalizeUserId(rawUserId);
  if (!userId) return { start: "", end: "" };
  const start = createKey(SHARE_INDEX_PREFIX, "owner", userId, "");
  return { start, end: start + "\uffff" };
};

// ── Agent key resolution from payload ───────────────────────────────

const findAgentKeyInArray = (arr: unknown[]): string => {
  for (const item of arr) {
    const key = toSafeAgentKey(item);
    if (key) return key;
  }
  return "";
};

const findAgentKeyInMessages = (messages: unknown[]): string => {
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const key = toSafeAgentKey((raw as Record<string, unknown>).cybotKey);
    if (key) return key;
  }
  return "";
};

const resolveAgentKeyFromPayload = (data: any): string => {
  if (!data || typeof data !== "object") return "";

  const meta = data?.meta;
  const payload = data?.data;

  const directCandidates: unknown[] = [
    meta?.sourceAgentKey, meta?.agentKey,
    data?.sourceAgentKey, data?.agentKey, data?.cybotKey,
    data?.type === DataType.CYBOT ? (data?.dbKey ?? data?.id) : "",
  ];

  for (const c of directCandidates) {
    const key = toSafeAgentKey(c);
    if (key) return key;
  }

  if (payload && typeof payload === "object") {
    const payloadCandidates: unknown[] = [
      payload?.sourceAgentKey, payload?.agentKey, payload?.cybotKey,
      payload?.meta?.sourceAgentKey, payload?.meta?.agentKey,
      data?.type === DataType.CYBOT ? (payload?.dbKey ?? payload?.id) : "",
    ];
    for (const c of payloadCandidates) {
      const key = toSafeAgentKey(c);
      if (key) return key;
    }

    if (Array.isArray(payload?.cybots)) {
      const key = findAgentKeyInArray(payload.cybots);
      if (key) return key;
    }
    if (Array.isArray(payload?.messages)) {
      const key = findAgentKeyInMessages(payload.messages);
      if (key) return key;
    }
    if (Array.isArray(payload?.history)) {
      const key = findAgentKeyInMessages(payload.history);
      if (key) return key;
    }
  }

  return "";
};

// ── Public API ──────────────────────────────────────────────────────

export const shareKey = {
  create: (token: string) => createKey(SHARE_PREFIX, token),

  range: () => {
    const start = createKey(SHARE_PREFIX, "");
    return { start, end: start + "\uffff" };
  },

  isShareKey: (key: string) => {
    const parts = splitKey(key);
    return parts.length >= 2 && parts[0] === SHARE_PREFIX;
  },

  tokenFromKey: (key: string) => {
    if (!shareKey.isShareKey(key)) return "";
    return key.slice(`${SHARE_PREFIX}-`.length).trim();
  },

  // Creator dimension
  communityCreatorIndex: (authorId: string, createdAt: number, token: string) =>
    createCommunityIndex("creator", authorId, createdAt, token),

  communityCreatorRange: (authorId: string) =>
    createCommunityRange("creator", authorId),

  // Agent dimension
  communityAgentIndex: (agentKey: string, createdAt: number, token: string) =>
    createCommunityIndex("agent", agentKey, createdAt, token),

  communityAgentRange: (agentKey: string) =>
    createCommunityRange("agent", agentKey),

  // Owner dimension (all shares, for "My Shares")
  ownerIndex: (userId: string, createdAt: number, token: string) =>
    createOwnerIndex(userId, createdAt, token),

  ownerRange: (userId: string) =>
    createOwnerRange(userId),

  // Global community feed (all community shares, time-ordered)
  communityAllIndex: (createdAt: number, token: string) =>
    createCommunityAllIndex(createdAt, token),

  communityAllRange: () =>
    createCommunityAllRange(),

  // From existing share data → index keys
  communityCreatorIndexFromShare: (dbKey: string, data: any) => {
    if (!shareKey.isShareKey(dbKey)) return "";
    if (data?.meta?.visibility !== "community") return "";
    const token = shareKey.tokenFromKey(dbKey);
    return shareKey.communityCreatorIndex(data?.meta?.authorId, data?.meta?.createdAt, token);
  },

  communityAgentIndexFromShare: (dbKey: string, data: any) => {
    if (!shareKey.isShareKey(dbKey)) return "";
    if (data?.meta?.visibility !== "community") return "";
    const token = shareKey.tokenFromKey(dbKey);
    const agentKey = resolveAgentKeyFromPayload(data);
    return shareKey.communityAgentIndex(agentKey, data?.meta?.createdAt, token);
  },

  ownerIndexFromShare: (dbKey: string, data: any) => {
    if (!shareKey.isShareKey(dbKey)) return "";
    const token = shareKey.tokenFromKey(dbKey);
    return shareKey.ownerIndex(data?.meta?.authorId, data?.meta?.createdAt, token);
  },

  communityAllIndexFromShare: (dbKey: string, data: any) => {
    if (!shareKey.isShareKey(dbKey)) return "";
    if (data?.meta?.visibility !== "community") return "";
    const token = shareKey.tokenFromKey(dbKey);
    return shareKey.communityAllIndex(data?.meta?.createdAt, token);
  },

  communityIndexKeysFromShare: (dbKey: string, data: any): string[] => {
    const all = shareKey.communityAllIndexFromShare(dbKey, data);
    const creator = shareKey.communityCreatorIndexFromShare(dbKey, data);
    const agent = shareKey.communityAgentIndexFromShare(dbKey, data);
    return Array.from(new Set([all, creator, agent].filter(Boolean)));
  },

  allIndexKeysFromShare: (dbKey: string, data: any): string[] => {
    const owner = shareKey.ownerIndexFromShare(dbKey, data);
    const community = shareKey.communityIndexKeysFromShare(dbKey, data);
    return Array.from(new Set([owner, ...community].filter(Boolean)));
  },
};
