import { normalizeServerOrigin } from "../../core/serverOrigin";
import { DEFAULT_NOLO_SERVER_URL } from "../defaultServer";
import { NOLO_CLUSTER_SERVERS } from "../../database/config";
import { resolvePlatformAuthToken } from "../../agent-runtime/providerResolution";
import {
  createHybridRecordStore,
  shouldCacheHybridRemoteRecord,
  type HybridRecordKvDb,
  type HybridRecordStore,
} from "../agentRuntimeLocal";
import type { CliFetchImpl } from "../cliFetch";

type EnvLike = Record<string, string | undefined>;

export type CliKvDb = HybridRecordKvDb;
export type { HybridRecordStore };

type CliHybridRecordStoreDeps = {
  db: CliKvDb;
  env: EnvLike;
  fetchImpl?: CliFetchImpl;
};

function resolveFallbackServers(env: EnvLike) {
  const values = [
    env.NOLO_SERVER_URL,
    env.BASE_URL,
    ...NOLO_CLUSTER_SERVERS,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return [...new Set(values.map(normalizeServerOrigin))];
}

function resolveAuthToken(env: EnvLike) {
  // Single source of truth: delegate to resolvePlatformAuthToken so the
  // machine key (NOLO_MACHINE_API_KEY) counts as a valid bearer here too.
  return resolvePlatformAuthToken(env);
}

export function shouldCacheRemoteRecord(remoteRecord: any, localRecord: any) {
  return shouldCacheHybridRemoteRecord(remoteRecord, localRecord);
}

export function createCliHybridRecordStore(
  deps: CliHybridRecordStoreDeps
): HybridRecordStore {
  return createHybridRecordStore({
    db: deps.db,
    defaultServer: normalizeServerOrigin(
      deps.env.NOLO_SERVER || deps.env.BASE_URL || DEFAULT_NOLO_SERVER_URL
    ),
    fallbackServers: resolveFallbackServers(deps.env),
    authToken: resolveAuthToken(deps.env),
    fetchImpl: deps.fetchImpl,
  });
}
