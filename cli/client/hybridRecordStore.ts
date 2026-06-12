import { DEFAULT_NOLO_SERVER_URL } from "../defaultServer";
import { NOLO_CLUSTER_SERVERS } from "../../database/config";
import {
  createHybridRecordStore,
  shouldCacheHybridRemoteRecord,
  type HybridRecordKvDb,
  type HybridRecordStore,
} from "../agentRuntimeLocal";

type EnvLike = Record<string, string | undefined>;

export type CliKvDb = HybridRecordKvDb;
export type { HybridRecordStore };

type CliHybridRecordStoreDeps = {
  db: CliKvDb;
  env: EnvLike;
  fetchImpl?: typeof fetch;
};

function normalizeServer(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function resolveFallbackServers(env: EnvLike) {
  const values = [
    env.NOLO_SERVER_URL,
    env.BASE_URL,
    ...NOLO_CLUSTER_SERVERS,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return [...new Set(values.map(normalizeServer))];
}

function resolveAuthToken(env: EnvLike) {
  return env.AUTH_TOKEN || env.AUTH || env.BENCHMARK_AUTH_TOKEN || "";
}

export function shouldCacheRemoteRecord(remoteRecord: any, localRecord: any) {
  return shouldCacheHybridRemoteRecord(remoteRecord, localRecord);
}

export function createCliHybridRecordStore(
  deps: CliHybridRecordStoreDeps
): HybridRecordStore {
  return createHybridRecordStore({
    db: deps.db,
    defaultServer: normalizeServer(deps.env.NOLO_SERVER || deps.env.BASE_URL || DEFAULT_NOLO_SERVER_URL),
    fallbackServers: resolveFallbackServers(deps.env),
    authToken: resolveAuthToken(deps.env),
    fetchImpl: deps.fetchImpl,
  });
}
