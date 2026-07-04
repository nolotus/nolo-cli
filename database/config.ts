// packages/database/config.ts

// 这个文件现在是前后端通用的，不包含任何后端模块如 'fs' 或 'path'。
export const API_VERSION = "/api/v1";
export const SERVERS = {
  MAIN: "https://nolo.chat",
  US: "https://us.nolo.chat",
} as const;
export const NOLO_CLUSTER_SERVERS = Object.values(SERVERS);

const LEGACY_SERVER_ORIGIN_MAP: Record<string, string> = {
  "https://nolotus.com": SERVERS.MAIN,
  "https://www.nolotus.com": SERVERS.MAIN,
  "https://us.nolotus.com": SERVERS.US,
  "https://www.us.nolotus.com": SERVERS.US,
};

export const normalizeKnownServerOrigin = (server: unknown): string | null => {
  if (typeof server !== "string" || server.trim().length === 0) return null;
  const trimmed = server.trim();
  let origin: string;
  try {
    origin = new URL(trimmed).origin;
  } catch {
    origin = trimmed.replace(/\/+$/, "");
  }
  return LEGACY_SERVER_ORIGIN_MAP[origin.toLowerCase()] ?? origin;
};
const LOCAL_DEV_SERVER_ORIGIN_PATTERN =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|nolotus\.local)(?::\d+)?$/i;

/** True when the origin is a local Nolo dev API (e.g. http://127.0.0.1:38123). */
export const isLocalDevServerOrigin = (server: unknown): boolean => {
  if (typeof server !== "string" || server.trim().length === 0) return false;
  const normalized =
    normalizeKnownServerOrigin(server) ?? server.trim().replace(/\/+$/, "");
  return LOCAL_DEV_SERVER_ORIGIN_PATTERN.test(normalized);
};

export const isNoloClusterServerOrigin = (server: unknown): boolean => {
  if (typeof server !== "string" || server.trim().length === 0) return false;
  const normalized =
    normalizeKnownServerOrigin(server) ?? server.trim().replace(/\/+$/, "");
  return /^https?:\/\/(?:us\.)?nolo\.chat$/i.test(normalized);
};


export const API_ENDPOINTS = {
  DATABASE: `${API_VERSION}/db`,
  SHARE: `${API_VERSION}/share`,
  USERS: `${API_VERSION}/users`,
  WEATHER: `${API_VERSION}/weather`,
  HI: `${API_VERSION}/hi`,
  CHAT: `${API_VERSION}/chat`,
  EXECUTE_SQL: `${API_VERSION}/sqlite/execute_sql`,
  // --- 新增端点 ---
  TRANSACTIONS: `${API_VERSION}/transactions`,
};
