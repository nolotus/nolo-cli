// 文件路径: database/actions/common.ts

import pino from "pino";
import { getIsDesktopApp } from "../../app/utils/env";
import { fetchWithTransientReadRetry } from "../../app/utils/retryFetch";
import { API_ENDPOINTS, NOLO_CLUSTER_SERVERS, normalizeKnownServerOrigin } from "../config";

// RN 下 pino 的 browser 写法可能有兼容性问题
// 使用简单的 console 封装作为 fallback
const isRN = typeof navigator !== 'undefined' && (navigator as any).product === 'ReactNative';

export const logger = isRN ? {
  info: (...args: any[]) => console.log(...args),
  warn: (...args: any[]) => console.warn(...args),
  error: (...args: any[]) => console.error(...args),
  debug: (...args: any[]) => console.log(...args), // console.debug in RN behaves like log
  trace: (...args: any[]) => console.log(...args),
  fatal: (...args: any[]) => console.error(...args),
  child: () => logger // 简单返回自己
} as unknown as pino.Logger : pino({
  level: "info",
  // transport: {
  //   target: "pino-pretty",
  // },
});
const normalizeServer = (server: string): string =>
  normalizeKnownServerOrigin(server) ?? server.trim().replace(/\/+$/, "");
const isNoloClusterServer = (server: string): boolean =>
  /^https?:\/\/(?:us\.)?nolo\.chat$/i.test(normalizeServer(server));

export const mergeConfiguredServers = (
  currentServer: string | undefined,
  syncServers: string[] | undefined
): string[] => {
  const runtimeOrigin =
    !getIsDesktopApp() &&
      typeof window !== "undefined" &&
      typeof window.location?.origin === "string" &&
      /^https?:\/\//.test(window.location.origin)
      ? window.location.origin
      : undefined;

  const raw = [
    currentServer,
    ...(Array.isArray(syncServers) ? syncServers : []),
    runtimeOrigin,
  ].filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0
  );

  const normalized = raw.map(normalizeServer);
  if (normalized.some(isNoloClusterServer)) {
    normalized.push(...NOLO_CLUSTER_SERVERS);
  }
  return Array.from(new Set(normalized));
};
// 全局缓存网络状态（仅 React Native 使用）
let cachedNetworkState: boolean | null = null;
let netInfoListenerInitialized = false;

// 检测是否为 React Native 环境
const isReactNative = (): boolean => {
  return typeof navigator !== 'undefined' && (navigator as any).product === 'ReactNative';
};

// 初始化 NetInfo 监听器（仅在 React Native 环境调用）
export const initNetworkListener = async () => {
  if (!isReactNative() || netInfoListenerInitialized) return;

  try {
    // 动态导入 NetInfo，避免在 Web 环境下出错
    const NetInfo = await import('@react-native-community/netinfo');
    NetInfo.default.addEventListener(state => {
      cachedNetworkState = state.isConnected ?? true;
    });
    netInfoListenerInitialized = true;
    console.log('[NetInfo] Listener initialized');
  } catch (error) {
    console.warn('[NetInfo] Failed to initialize:', error);
  }
};

// 改进的 isOnline 函数，兼容 Web 和 React Native
export const isOnline = (): boolean => {
  // React Native 环境：使用 NetInfo 缓存
  if (isReactNative()) {
    if (cachedNetworkState !== null) {
      return cachedNetworkState;
    }
    // NetInfo 还未初始化，默认假设在线
    return true;
  }

  // Web 环境：使用 navigator.onLine
  if (typeof navigator !== "undefined" && typeof (navigator as any).onLine !== "undefined") {
    return (navigator as any).onLine;
  }

  // 降级：默认假设在线
  return true;
};

export const getAllServers = (
  currentServer: string | undefined,
  syncServers: string[] | undefined,
  preferredServer?: string | null
): string[] => {
  const preferredNormalized =
    typeof preferredServer === "string" && preferredServer.trim().length > 0
      ? normalizeServer(preferredServer)
      : null;
  const servers = mergeConfiguredServers(
    currentServer,
    preferredNormalized && isNoloClusterServer(preferredNormalized)
      ? [...(Array.isArray(syncServers) ? syncServers : []), preferredNormalized]
      : syncServers
  );
  if (!preferredServer || typeof preferredServer !== "string") {
    return servers;
  }

  const remaining = servers.filter(
    (server) => normalizeServer(server) !== preferredNormalized
  );
  return preferredNormalized ? [preferredNormalized, ...remaining] : remaining;
};

const isLevelNotFoundError = (err: any): boolean => {
  const code = err?.code;
  return (
    err?.notFound === true ||
    err?.name === "NotFoundError" ||
    code === "LEVEL_NOT_FOUND" ||
    code === "LEVEL_NOT_FOUND_ERROR"
  );
};


// 从客户端数据库获取数据 (无需改动)
export const fetchFromClientDb = async (
  clientDb: any,
  dbKey: string
): Promise<any> => {
  if (!clientDb) {
    logger.error(
      { dbKey },
      "Client database is undefined in fetchFromClientDb"
    );
    return null;
  }
  try {
    return await clientDb.get(dbKey);
  } catch (err) {
    if (isLevelNotFoundError(err)) {
      return null;
    }
    logger.error({ err, dbKey }, "Failed to get local data");
    return null;
  }
};

// ======================================================================
// 【核心改造】: fetchFromServer 函数
// ======================================================================
const SERVER_TIMEOUT = 5000;
export const READ_TIMEOUT_ERROR_NAME = "ReadTimeoutError";
const isPublicFileDbKey = (dbKey: string): boolean => dbKey.startsWith("file-");
// file-* 元数据接口对无 token 的 LLM/工具调用开放（仅 metadata）；
// 常规 read 接口保留认证路径，避免普通业务数据被未授权盗链/枚举。
const buildReadUrl = (dbKey: string): string =>
  isPublicFileDbKey(dbKey)
    ? `${API_ENDPOINTS.DATABASE}/file/metadata/${encodeURIComponent(dbKey)}`
    : `${API_ENDPOINTS.DATABASE}/read/${encodeURIComponent(dbKey)}`;

const createReadTimeoutError = (server: string, dbKey: string): Error => {
  const error = new Error(
    `Timed out reading key "${dbKey}" from ${normalizeServer(server)}.`
  );
  error.name = READ_TIMEOUT_ERROR_NAME;
  return error;
};

export const isReadTimeoutError = (error: unknown): boolean =>
  error instanceof Error && error.name === READ_TIMEOUT_ERROR_NAME;

export const fetchFromServer = async (
  server: string,
  dbKey: string,
  token?: string,
  signal?: AbortSignal
): Promise<any> => {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const controller = new AbortController();
  let didTimeout = false;
  const timeoutId = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, SERVER_TIMEOUT);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort);

  try {
    const res = await fetchWithTransientReadRetry(
      `${server}${buildReadUrl(dbKey)}`,
      {
        signal: controller.signal as any,
        headers: {
          "Content-Type": "application/json",
          ...(token && { Authorization: `Bearer ${token}` }),
        },
      }
    );
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onExternalAbort);

    if (res.status === 200) {
      return await res.json();
    }
    return null;
  } catch (err: any) {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onExternalAbort);
    if (didTimeout) {
      throw createReadTimeoutError(server, dbKey);
    }
    if (signal?.aborted || err.name === "AbortError") {
      throw err;
    }
    return null;
  }
};

// 规范化时间字段 (无需改动)
export const normalizeTimeFields = (data: any): any => ({
  ...data,
  createdAt: data.createdAt || new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  updated_at: undefined,
  created_at: undefined,
});
