/**
 * Durable device-local persistence for explicit sync mappings.
 *
 * Uses the client Level/MemoryDB surface (put/get/del/iterator) only.
 * Records are owner-local (`userId: "local"`) so replication schedules empty.
 * Keys use the `syncmap-local-` namespace and never match content type prefixes.
 *
 * Intentionally does not import `./syncMapping` to avoid circular deps.
 */

import { asOptionalFiniteNumber } from "../../core/optionalNumber";
import { asTrimmedString } from "../../core/trimmedString";
import { isLevelNotFoundError } from "../levelNotFoundError";
import {
  buildSyncMappingRecordKey,
  isSyncMappingRecordKey,
  SYNC_MAPPING_RECORD_TYPE,
  syncMappingRecordKeyRange,
} from "./syncMappingKeys";

/**
 * Minimal client DB surface (Level / MemoryDB / test doubles).
 * Kept structural and loose so MemoryDB's iterator signature type-checks.
 */
export type SyncMappingClientDb = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  del?(key: string): Promise<void>;
  iterator?(options?: {
    gte?: string;
    lte?: string;
    lt?: string;
    reverse?: boolean;
  }): any;
};

export type DurableMappingFields = {
  localDbKey: string;
  remoteDbKey: string;
  accountUserId: string;
  contentType: string;
  updatedAt: number;
};

export type DurableSyncMappingRecord = DurableMappingFields & {
  type: typeof SYNC_MAPPING_RECORD_TYPE;
  userId: "local";
  dbKey: string;
};

const clean = (value: unknown): string => asTrimmedString(value);

export function toDurableSyncMappingRecord(
  input: DurableMappingFields
): DurableSyncMappingRecord {
  const localDbKey = clean(input.localDbKey);
  const remoteDbKey = clean(input.remoteDbKey);
  const accountUserId = clean(input.accountUserId);
  const contentType = clean(input.contentType) || "unknown";
  const updatedAt = asOptionalFiniteNumber(input.updatedAt) ?? Date.now();

  if (!localDbKey || !remoteDbKey || !accountUserId) {
    throw new Error("durable syncMapping requires local/remote/account keys");
  }

  const dbKey = buildSyncMappingRecordKey(accountUserId, localDbKey);
  return {
    type: SYNC_MAPPING_RECORD_TYPE,
    userId: "local",
    dbKey,
    localDbKey,
    remoteDbKey,
    accountUserId,
    contentType,
    updatedAt,
  };
}

export function parseDurableSyncMappingRecord(
  value: unknown
): DurableMappingFields | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.type !== SYNC_MAPPING_RECORD_TYPE) return null;
  if (row.userId !== "local" && row.userId !== undefined) {
    // Reject non-local owners so account-scoped cloud rows cannot masquerade.
    return null;
  }
  const localDbKey = clean(row.localDbKey);
  const remoteDbKey = clean(row.remoteDbKey);
  const accountUserId = clean(row.accountUserId);
  const contentType = clean(row.contentType) || "unknown";
  const updatedAt = asOptionalFiniteNumber(row.updatedAt) ?? Date.now();
  if (!localDbKey || !remoteDbKey || !accountUserId) return null;
  if (localDbKey === remoteDbKey) return null;
  if (accountUserId === "local") return null;
  return {
    localDbKey,
    remoteDbKey,
    accountUserId,
    contentType,
    updatedAt,
  };
}

export async function persistSyncMappingToDb(
  db: SyncMappingClientDb,
  input: DurableMappingFields
): Promise<DurableSyncMappingRecord> {
  const record = toDurableSyncMappingRecord(input);
  await db.put(record.dbKey, record);
  return record;
}

export async function removeSyncMappingFromDb(
  db: SyncMappingClientDb,
  accountUserId: string,
  localDbKey: string
): Promise<boolean> {
  const dbKey = buildSyncMappingRecordKey(accountUserId, localDbKey);
  try {
    if (typeof db.del === "function") {
      await db.del(dbKey);
      return true;
    }
    await db.put(dbKey, null as unknown as object);
    return true;
  } catch (err) {
    if (isLevelNotFoundError(err)) return false;
    throw err;
  }
}

export async function loadSyncMappingsFromDb(
  db: SyncMappingClientDb
): Promise<DurableMappingFields[]> {
  if (typeof db.iterator !== "function") {
    return [];
  }

  const range = syncMappingRecordKeyRange();
  let iterator: any = db.iterator(range);
  if (iterator && typeof iterator.then === "function") {
    iterator = await iterator;
  }
  if (!iterator) return [];

  const out: DurableMappingFields[] = [];
  for await (const entry of iterator as AsyncIterable<unknown>) {
    const pair = entry as [string, unknown];
    const key = Array.isArray(pair) ? pair[0] : "";
    const value = Array.isArray(pair) ? pair[1] : null;
    if (!isSyncMappingRecordKey(key)) continue;
    if (value == null) continue;
    const mapping = parseDurableSyncMappingRecord(value);
    if (mapping) out.push(mapping);
  }
  return out;
}
